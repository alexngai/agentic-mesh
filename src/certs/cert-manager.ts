// CertManager - Certificate management via nebula-cert binary
// Implements: i-1bdm

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import * as crypto from 'crypto'
import {
  CertManagerConfig,
  CertificateInfo,
  CertificateIndex,
  CreateRootCAOptions,
  CreateUserCAOptions,
  SignServerCertOptions,
  SetupValidation,
  CertVerification,
  CommandResult,
  RevocationEntry,
  RevocationList,
  RevocationListExport,
} from './types'
import type { NebulaMesh } from '../mesh/nebula-mesh'
import type { MessageChannel } from '../channel/message-channel'

// Revocation update message type
interface RevocationUpdateMessage {
  type: 'revocation:update'
  list: RevocationListExport
}

const INDEX_VERSION = 1
const REVOCATION_VERSION = 1
const INDEX_FILENAME = 'cert-index.json'
const REVOCATION_FILENAME = 'revocation-list.json'
const DEFAULT_DURATION = '8760h' // 1 year

export class CertManager extends EventEmitter {
  private config: Required<Omit<CertManagerConfig, 'autoRenewal'>> & {
    autoRenewal: Required<NonNullable<CertManagerConfig['autoRenewal']>>
  }
  private index: CertificateIndex
  private revocationList: RevocationList
  private autoRenewalTimer: NodeJS.Timeout | null = null
  private initialized = false

  // Mesh integration (Phase 9.4)
  private mesh: NebulaMesh | null = null
  private revocationChannel: MessageChannel<RevocationUpdateMessage> | null = null

  constructor(config: CertManagerConfig) {
    super()
    this.config = {
      certsDir: config.certsDir,
      nebulaCertPath: config.nebulaCertPath ?? 'nebula-cert',
      nebulaPath: config.nebulaPath ?? 'nebula',
      autoRenewal: {
        enabled: config.autoRenewal?.enabled ?? false,
        checkInterval: config.autoRenewal?.checkInterval ?? 3600000, // 1 hour
        renewBeforeDays: config.autoRenewal?.renewBeforeDays ?? 7,
      },
    }
    this.index = this.createEmptyIndex()
    this.revocationList = this.createEmptyRevocationList()
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the CertManager. Must be called before using other methods.
   * Loads existing certificate index or creates a new one.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Ensure certs directory exists
    await fs.promises.mkdir(this.config.certsDir, { recursive: true })

    // Load or create index and revocation list
    await this.loadIndex()
    await this.loadRevocationList()

    this.initialized = true

    // Start auto-renewal if enabled
    if (this.config.autoRenewal.enabled) {
      this.startAutoRenewal()
    }
  }

  /**
   * Shut down the CertManager, stopping auto-renewal.
   */
  async shutdown(): Promise<void> {
    this.stopAutoRenewal()
    await this.disconnectFromMesh()
    this.initialized = false
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Validate that nebula-cert and optionally nebula are available.
   */
  async validateSetup(): Promise<SetupValidation> {
    const result: SetupValidation = {
      valid: true,
      nebulaCertFound: false,
      nebulaFound: false,
      certsDirWritable: false,
      errors: [],
      warnings: [],
    }

    // Check nebula-cert
    try {
      const versionResult = await this.runCommand(this.config.nebulaCertPath, [
        'version',
      ])
      if (versionResult.success) {
        result.nebulaCertFound = true
        // Parse version from output (format: "nebula-cert version X.X.X")
        const match = versionResult.stdout.match(/version\s+(\S+)/)
        result.nebulaCertVersion = match?.[1]
      } else {
        result.errors.push(
          `nebula-cert not working: ${versionResult.stderr || 'unknown error'}`
        )
        result.valid = false
      }
    } catch {
      result.errors.push(
        `nebula-cert not found at '${this.config.nebulaCertPath}'`
      )
      result.valid = false
    }

    // Check nebula (optional)
    try {
      const versionResult = await this.runCommand(this.config.nebulaPath, [
        '-version',
      ])
      if (versionResult.success || versionResult.stderr.includes('Version:')) {
        result.nebulaFound = true
        // Parse version from stderr (nebula outputs version to stderr)
        const match = versionResult.stderr.match(/Version:\s*(\S+)/)
        result.nebulaVersion = match?.[1]
      }
    } catch {
      result.warnings.push(
        `nebula not found at '${this.config.nebulaPath}' (optional)`
      )
    }

    // Check certs directory
    try {
      await fs.promises.mkdir(this.config.certsDir, { recursive: true })
      // Test write access
      const testFile = path.join(this.config.certsDir, '.write-test')
      await fs.promises.writeFile(testFile, 'test')
      await fs.promises.unlink(testFile)
      result.certsDirWritable = true
    } catch {
      result.errors.push(
        `Certificates directory not writable: ${this.config.certsDir}`
      )
      result.valid = false
    }

    return result
  }

  // ===========================================================================
  // Root CA Operations
  // ===========================================================================

  /**
   * Create a new root CA.
   */
  async createRootCA(options: CreateRootCAOptions): Promise<CertificateInfo> {
    this.ensureInitialized()

    const { name, duration = DEFAULT_DURATION, groups = [] } = options

    // Check if CA already exists
    if (this.index.certificates[name]) {
      throw new Error(`Certificate '${name}' already exists`)
    }

    const caDir = path.join(this.config.certsDir, name)
    await fs.promises.mkdir(caDir, { recursive: true })

    const crtPath = path.join(caDir, 'ca.crt')
    const keyPath = path.join(caDir, 'ca.key')

    // Build command arguments
    const args = ['ca', '-name', name, '-duration', duration]

    if (groups.length > 0) {
      args.push('-groups', groups.join(','))
    }

    args.push('-out-crt', crtPath, '-out-key', keyPath)

    // Run nebula-cert ca
    const result = await this.runCommand(this.config.nebulaCertPath, args)

    if (!result.success) {
      throw new Error(`Failed to create root CA: ${result.stderr}`)
    }

    // Parse expiration from cert
    const expiresAt = await this.parseCertExpiration(crtPath)

    // Create certificate info
    const certInfo: CertificateInfo = {
      name,
      type: 'root-ca',
      groups,
      createdAt: new Date(),
      expiresAt,
      certPath: crtPath,
      keyPath,
      revoked: false,
    }

    // Update index
    this.index.certificates[name] = certInfo
    await this.saveIndex()

    this.emit('cert:created', { cert: certInfo })

    return certInfo
  }

  // ===========================================================================
  // User CA Operations
  // ===========================================================================

  /**
   * Create a user CA signed by a root CA.
   */
  async createUserCA(options: CreateUserCAOptions): Promise<CertificateInfo> {
    this.ensureInitialized()

    const { name, rootCAName, duration = DEFAULT_DURATION, groups = [] } = options

    // Check if cert already exists
    if (this.index.certificates[name]) {
      throw new Error(`Certificate '${name}' already exists`)
    }

    // Get root CA
    const rootCA = this.index.certificates[rootCAName]
    if (!rootCA) {
      throw new Error(`Root CA '${rootCAName}' not found`)
    }
    if (rootCA.type !== 'root-ca') {
      throw new Error(`'${rootCAName}' is not a root CA`)
    }

    // Validate groups are subset of root CA groups
    for (const group of groups) {
      if (rootCA.groups.length > 0 && !rootCA.groups.includes(group)) {
        throw new Error(
          `Group '${group}' not allowed by root CA '${rootCAName}'`
        )
      }
    }

    const caDir = path.join(this.config.certsDir, name)
    await fs.promises.mkdir(caDir, { recursive: true })

    const crtPath = path.join(caDir, 'ca.crt')
    const keyPath = path.join(caDir, 'ca.key')

    // Build command arguments
    const args = [
      'ca',
      '-name',
      name,
      '-duration',
      duration,
      '-sign-crt',
      rootCA.certPath,
      '-sign-key',
      rootCA.keyPath,
    ]

    if (groups.length > 0) {
      args.push('-groups', groups.join(','))
    }

    args.push('-out-crt', crtPath, '-out-key', keyPath)

    // Run nebula-cert ca
    const result = await this.runCommand(this.config.nebulaCertPath, args)

    if (!result.success) {
      throw new Error(`Failed to create user CA: ${result.stderr}`)
    }

    // Parse expiration from cert
    const expiresAt = await this.parseCertExpiration(crtPath)

    // Create certificate info
    const certInfo: CertificateInfo = {
      name,
      type: 'user-ca',
      groups,
      createdAt: new Date(),
      expiresAt,
      certPath: crtPath,
      keyPath,
      signedBy: rootCAName,
      revoked: false,
    }

    // Update index
    this.index.certificates[name] = certInfo
    await this.saveIndex()

    this.emit('cert:created', { cert: certInfo })

    return certInfo
  }

  // ===========================================================================
  // Server Certificate Operations
  // ===========================================================================

  /**
   * Sign a server certificate.
   */
  async signServerCert(
    options: SignServerCertOptions
  ): Promise<CertificateInfo> {
    this.ensureInitialized()

    const {
      name,
      caName,
      nebulaIp,
      groups = [],
      duration = DEFAULT_DURATION,
      subnets = [],
    } = options

    // Check if cert already exists
    if (this.index.certificates[name]) {
      throw new Error(`Certificate '${name}' already exists`)
    }

    // Get CA
    const ca = this.index.certificates[caName]
    if (!ca) {
      throw new Error(`CA '${caName}' not found`)
    }
    if (ca.type !== 'root-ca' && ca.type !== 'user-ca') {
      throw new Error(`'${caName}' is not a CA`)
    }

    // Validate groups
    for (const group of groups) {
      if (ca.groups.length > 0 && !ca.groups.includes(group)) {
        throw new Error(`Group '${group}' not allowed by CA '${caName}'`)
      }
    }

    const certDir = path.join(this.config.certsDir, name)
    await fs.promises.mkdir(certDir, { recursive: true })

    const crtPath = path.join(certDir, `${name}.crt`)
    const keyPath = path.join(certDir, `${name}.key`)

    // Build command arguments
    const args = [
      'sign',
      '-name',
      name,
      '-ip',
      nebulaIp,
      '-duration',
      duration,
      '-ca-crt',
      ca.certPath,
      '-ca-key',
      ca.keyPath,
    ]

    if (groups.length > 0) {
      args.push('-groups', groups.join(','))
    }

    if (subnets.length > 0) {
      args.push('-subnets', subnets.join(','))
    }

    args.push('-out-crt', crtPath, '-out-key', keyPath)

    // Run nebula-cert sign
    const result = await this.runCommand(this.config.nebulaCertPath, args)

    if (!result.success) {
      throw new Error(`Failed to sign server cert: ${result.stderr}`)
    }

    // Parse expiration from cert
    const expiresAt = await this.parseCertExpiration(crtPath)

    // Create certificate info
    const certInfo: CertificateInfo = {
      name,
      type: 'server',
      nebulaIp,
      groups,
      createdAt: new Date(),
      expiresAt,
      certPath: crtPath,
      keyPath,
      signedBy: caName,
      revoked: false,
    }

    // Update index
    this.index.certificates[name] = certInfo
    await this.saveIndex()

    this.emit('cert:created', { cert: certInfo })

    return certInfo
  }

  // ===========================================================================
  // Certificate Queries
  // ===========================================================================

  /**
   * Get certificate by name.
   */
  getCertificate(name: string): CertificateInfo | undefined {
    this.ensureInitialized()
    return this.index.certificates[name]
  }

  /**
   * List all certificates.
   */
  listCertificates(): CertificateInfo[] {
    this.ensureInitialized()
    return Object.values(this.index.certificates)
  }

  /**
   * List certificates by type.
   */
  listCertificatesByType(
    type: CertificateInfo['type']
  ): CertificateInfo[] {
    this.ensureInitialized()
    return Object.values(this.index.certificates).filter((c) => c.type === type)
  }

  /**
   * Get certificates that need renewal.
   */
  getCertsNeedingRenewal(daysThreshold?: number): CertificateInfo[] {
    this.ensureInitialized()
    const threshold = daysThreshold ?? this.config.autoRenewal.renewBeforeDays
    const thresholdDate = new Date()
    thresholdDate.setDate(thresholdDate.getDate() + threshold)

    return Object.values(this.index.certificates).filter(
      (cert) => !cert.revoked && new Date(cert.expiresAt) <= thresholdDate
    )
  }

  // ===========================================================================
  // Certificate Verification
  // ===========================================================================

  /**
   * Verify a certificate.
   */
  async verifyCert(name: string): Promise<CertVerification> {
    this.ensureInitialized()

    const cert = this.index.certificates[name]
    if (!cert) {
      return {
        valid: false,
        chainValid: false,
        notExpired: false,
        notRevoked: false,
        errors: [`Certificate '${name}' not found`],
      }
    }

    const errors: string[] = []
    const now = new Date()

    // Check expiration
    const notExpired = new Date(cert.expiresAt) > now
    if (!notExpired) {
      errors.push('Certificate has expired')
    }

    // Check revocation
    const notRevoked = !cert.revoked
    if (!notRevoked) {
      errors.push('Certificate has been revoked')
    }

    // Check chain (verify signed-by cert exists and is valid)
    let chainValid = true
    if (cert.signedBy) {
      const signerCert = this.index.certificates[cert.signedBy]
      if (!signerCert) {
        chainValid = false
        errors.push(`Signing CA '${cert.signedBy}' not found`)
      } else if (signerCert.revoked) {
        chainValid = false
        errors.push(`Signing CA '${cert.signedBy}' has been revoked`)
      } else if (new Date(signerCert.expiresAt) < now) {
        chainValid = false
        errors.push(`Signing CA '${cert.signedBy}' has expired`)
      }
    }

    // Verify cert files exist
    try {
      await fs.promises.access(cert.certPath, fs.constants.R_OK)
      await fs.promises.access(cert.keyPath, fs.constants.R_OK)
    } catch {
      chainValid = false
      errors.push('Certificate files not accessible')
    }

    // Use nebula-cert verify if available
    if (cert.signedBy) {
      const signerCert = this.index.certificates[cert.signedBy]
      if (signerCert) {
        const verifyResult = await this.runCommand(this.config.nebulaCertPath, [
          'verify',
          '-ca',
          signerCert.certPath,
          '-crt',
          cert.certPath,
        ])
        if (!verifyResult.success) {
          chainValid = false
          errors.push(`Chain verification failed: ${verifyResult.stderr}`)
        }
      }
    }

    return {
      valid: notExpired && notRevoked && chainValid,
      chainValid,
      notExpired,
      notRevoked,
      errors,
    }
  }

  // ===========================================================================
  // Revocation Management
  // ===========================================================================

  /**
   * Revoke a certificate.
   */
  async revokeCert(name: string, reason: string = 'unspecified'): Promise<void> {
    this.ensureInitialized()

    const cert = this.index.certificates[name]
    if (!cert) {
      throw new Error(`Certificate '${name}' not found`)
    }

    if (cert.revoked) {
      throw new Error(`Certificate '${name}' is already revoked`)
    }

    // Calculate fingerprint
    const fingerprint = await this.calculateCertFingerprint(cert.certPath)

    // Add to revocation list
    const entry: RevocationEntry = {
      certName: name,
      fingerprint,
      revokedAt: new Date(),
      reason,
      revokedBy: 'local',
    }

    this.revocationList.entries.push(entry)
    this.revocationList.lastUpdated = new Date()
    await this.saveRevocationList()

    // Update certificate in index
    cert.revoked = true
    await this.saveIndex()

    this.emit('cert:revoked', { cert, reason })

    // Broadcast update to mesh if connected (Phase 9.4)
    this.broadcastRevocationUpdate()
  }

  /**
   * Check if a certificate is revoked by name.
   */
  isRevoked(name: string): boolean {
    this.ensureInitialized()

    const cert = this.index.certificates[name]
    if (cert) {
      return cert.revoked
    }

    // Also check revocation list for certs we don't have locally
    return this.revocationList.entries.some((e) => e.certName === name)
  }

  /**
   * Check if a certificate is revoked by fingerprint.
   */
  isRevokedByFingerprint(fingerprint: string): boolean {
    this.ensureInitialized()
    return this.revocationList.entries.some((e) => e.fingerprint === fingerprint)
  }

  /**
   * Get all revocation entries.
   */
  getRevocationList(): RevocationEntry[] {
    this.ensureInitialized()
    return [...this.revocationList.entries]
  }

  /**
   * Export revocation list for distribution.
   */
  exportRevocationList(): RevocationListExport {
    this.ensureInitialized()
    return {
      data: JSON.stringify(this.revocationList),
      version: REVOCATION_VERSION,
    }
  }

  /**
   * Import and merge revocation list from another source.
   * New entries are added, existing entries are preserved.
   */
  async importRevocationList(exported: RevocationListExport): Promise<number> {
    this.ensureInitialized()

    if (exported.version !== REVOCATION_VERSION) {
      throw new Error(`Unsupported revocation list version: ${exported.version}`)
    }

    const imported = JSON.parse(exported.data) as RevocationList

    // Convert date strings back to Date objects
    for (const entry of imported.entries) {
      entry.revokedAt = new Date(entry.revokedAt)
    }

    // Merge entries (add new ones)
    let addedCount = 0
    const existingFingerprints = new Set(
      this.revocationList.entries.map((e) => e.fingerprint)
    )

    for (const entry of imported.entries) {
      if (!existingFingerprints.has(entry.fingerprint)) {
        this.revocationList.entries.push(entry)
        existingFingerprints.add(entry.fingerprint)
        addedCount++

        // Mark corresponding local cert as revoked if we have it
        const cert = this.index.certificates[entry.certName]
        if (cert && !cert.revoked) {
          cert.revoked = true
        }
      }
    }

    if (addedCount > 0) {
      this.revocationList.lastUpdated = new Date()
      await this.saveRevocationList()
      await this.saveIndex()
    }

    return addedCount
  }

  // ===========================================================================
  // Auto-Renewal
  // ===========================================================================

  /**
   * Start auto-renewal monitoring.
   */
  startAutoRenewal(): void {
    if (this.autoRenewalTimer) return

    this.autoRenewalTimer = setInterval(async () => {
      try {
        await this.checkAndRenewCerts()
      } catch (error) {
        this.emit('error', error)
      }
    }, this.config.autoRenewal.checkInterval)
  }

  /**
   * Stop auto-renewal monitoring.
   */
  stopAutoRenewal(): void {
    if (this.autoRenewalTimer) {
      clearInterval(this.autoRenewalTimer)
      this.autoRenewalTimer = null
    }
  }

  /**
   * Check for expiring certs and renew them.
   */
  async checkAndRenewCerts(): Promise<CertificateInfo[]> {
    const certsNeedingRenewal = this.getCertsNeedingRenewal()
    const renewed: CertificateInfo[] = []

    for (const cert of certsNeedingRenewal) {
      const daysUntilExpiry = Math.ceil(
        (new Date(cert.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      )

      this.emit('cert:expiring', { cert, daysUntilExpiry })

      // Only auto-renew server certs (CAs require manual renewal)
      if (cert.type === 'server' && cert.signedBy) {
        try {
          const newCert = await this.renewServerCert(cert.name)
          renewed.push(newCert)
        } catch (error) {
          this.emit('error', {
            message: `Failed to renew cert '${cert.name}'`,
            error,
          })
        }
      }
    }

    return renewed
  }

  /**
   * Renew a server certificate.
   */
  async renewServerCert(name: string): Promise<CertificateInfo> {
    this.ensureInitialized()

    const cert = this.index.certificates[name]
    if (!cert) {
      throw new Error(`Certificate '${name}' not found`)
    }
    if (cert.type !== 'server') {
      throw new Error('Can only renew server certificates automatically')
    }
    if (!cert.signedBy) {
      throw new Error('Certificate has no signing CA')
    }
    if (!cert.nebulaIp) {
      throw new Error('Certificate has no Nebula IP')
    }

    // Create backup of old cert
    const oldCert = { ...cert }

    // Re-sign with same options
    // First, delete old entry so signServerCert doesn't fail
    delete this.index.certificates[name]

    try {
      const newCert = await this.signServerCert({
        name,
        caName: cert.signedBy,
        nebulaIp: cert.nebulaIp,
        groups: cert.groups,
      })

      this.emit('cert:renewed', { oldCert, newCert })

      return newCert
    } catch (error) {
      // Restore old entry on failure
      this.index.certificates[name] = oldCert
      await this.saveIndex()
      throw error
    }
  }

  // ===========================================================================
  // Mesh Integration (Phase 9.4)
  // ===========================================================================

  /**
   * Connect to a mesh for revocation list distribution.
   * When connected as hub, revocation updates are broadcast to all peers.
   * When connected as peer, revocation updates are received and imported.
   *
   * @param mesh The NebulaMesh instance to connect to
   *
   * @example
   * ```typescript
   * const mesh = new NebulaMesh(config)
   * await mesh.connect()
   * certManager.connectToMesh(mesh)
   *
   * // On revoke, hub broadcasts automatically
   * await certManager.revokeCert(compromisedCert)
   * ```
   */
  connectToMesh(mesh: NebulaMesh): void {
    this.ensureInitialized()

    if (this.mesh) {
      throw new Error('Already connected to mesh')
    }

    this.mesh = mesh

    // Create revocation channel
    this.revocationChannel = mesh.createChannel<RevocationUpdateMessage>('certs:revocation')

    // Handle incoming revocation updates
    this.revocationChannel.on('message', async (msg) => {
      if (msg.type === 'revocation:update') {
        try {
          const added = await this.importRevocationList(msg.list)
          if (added > 0) {
            this.emit('revocation:imported', { count: added })
          }
        } catch (error) {
          this.emit('error', { message: 'Failed to import revocation list', error })
        }
      }
    })

    // Open the channel
    this.revocationChannel.open().catch((error) => {
      this.emit('error', { message: 'Failed to open revocation channel', error })
    })

    this.emit('mesh:connected')
  }

  /**
   * Disconnect from mesh.
   */
  async disconnectFromMesh(): Promise<void> {
    if (!this.mesh) return

    if (this.revocationChannel) {
      await this.revocationChannel.close()
      this.revocationChannel = null
    }

    this.mesh = null
    this.emit('mesh:disconnected')
  }

  /**
   * Check if connected to mesh.
   */
  get meshConnected(): boolean {
    return this.mesh !== null
  }

  /**
   * Broadcast revocation update to all peers (hub only).
   */
  private broadcastRevocationUpdate(): void {
    if (!this.mesh || !this.revocationChannel) return

    // Only broadcast if we're the hub
    if (!this.mesh.isHub()) return

    const msg: RevocationUpdateMessage = {
      type: 'revocation:update',
      list: this.exportRevocationList(),
    }

    this.revocationChannel.broadcast(msg)
    this.emit('revocation:broadcast')
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('CertManager not initialized. Call initialize() first.')
    }
  }

  private createEmptyIndex(): CertificateIndex {
    return {
      version: INDEX_VERSION,
      certificates: {},
      lastModified: new Date(),
    }
  }

  private async loadIndex(): Promise<void> {
    const indexPath = path.join(this.config.certsDir, INDEX_FILENAME)

    try {
      const data = await fs.promises.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(data) as CertificateIndex

      // Convert date strings back to Date objects
      for (const cert of Object.values(parsed.certificates)) {
        cert.createdAt = new Date(cert.createdAt)
        cert.expiresAt = new Date(cert.expiresAt)
      }
      parsed.lastModified = new Date(parsed.lastModified)

      this.index = parsed
    } catch {
      // Index doesn't exist, use empty index
      this.index = this.createEmptyIndex()
      await this.saveIndex()
    }
  }

  private async saveIndex(): Promise<void> {
    const indexPath = path.join(this.config.certsDir, INDEX_FILENAME)
    this.index.lastModified = new Date()
    await fs.promises.writeFile(
      indexPath,
      JSON.stringify(this.index, null, 2),
      'utf-8'
    )
  }

  private createEmptyRevocationList(): RevocationList {
    return {
      version: REVOCATION_VERSION,
      entries: [],
      lastUpdated: new Date(),
    }
  }

  private async loadRevocationList(): Promise<void> {
    const listPath = path.join(this.config.certsDir, REVOCATION_FILENAME)

    try {
      const data = await fs.promises.readFile(listPath, 'utf-8')
      const parsed = JSON.parse(data) as RevocationList

      // Convert date strings back to Date objects
      for (const entry of parsed.entries) {
        entry.revokedAt = new Date(entry.revokedAt)
      }
      parsed.lastUpdated = new Date(parsed.lastUpdated)

      this.revocationList = parsed
    } catch {
      // Revocation list doesn't exist, use empty list
      this.revocationList = this.createEmptyRevocationList()
    }
  }

  private async saveRevocationList(): Promise<void> {
    const listPath = path.join(this.config.certsDir, REVOCATION_FILENAME)
    await fs.promises.writeFile(
      listPath,
      JSON.stringify(this.revocationList, null, 2),
      'utf-8'
    )
  }

  private async calculateCertFingerprint(certPath: string): Promise<string> {
    try {
      const certContent = await fs.promises.readFile(certPath)
      return crypto.createHash('sha256').update(certContent).digest('hex')
    } catch {
      // If we can't read the cert, use a placeholder
      return crypto.createHash('sha256').update(certPath).digest('hex')
    }
  }

  private async runCommand(
    command: string,
    args: string[]
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const proc = spawn(command, args)
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 1,
        })
      })

      proc.on('error', (error) => {
        resolve({
          success: false,
          stdout: '',
          stderr: error.message,
          exitCode: 1,
        })
      })
    })
  }

  private async parseCertExpiration(certPath: string): Promise<Date> {
    // Use nebula-cert print to get cert details
    const result = await this.runCommand(this.config.nebulaCertPath, [
      'print',
      '-path',
      certPath,
      '-json',
    ])

    if (result.success) {
      try {
        const certData = JSON.parse(result.stdout)
        // nebula-cert outputs notAfter as RFC3339 timestamp
        if (certData.details?.notAfter) {
          return new Date(certData.details.notAfter)
        }
      } catch {
        // Fall through to default
      }
    }

    // Default to 1 year from now if we can't parse
    const defaultExpiry = new Date()
    defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1)
    return defaultExpiry
  }
}
