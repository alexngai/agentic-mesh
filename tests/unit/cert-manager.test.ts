import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as childProcess from 'child_process'
import { EventEmitter } from 'events'
import { CertManager } from '../../src/certs/cert-manager'
import type { CertificateInfo } from '../../src/certs/types'

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

// Helper to create mock spawn process
function createMockProcess(
  stdout: string,
  stderr: string,
  exitCode: number
): childProcess.ChildProcess {
  const proc = new EventEmitter() as childProcess.ChildProcess
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()

  // @ts-expect-error - mocking
  proc.stdout = stdoutEmitter
  // @ts-expect-error - mocking
  proc.stderr = stderrEmitter

  // Emit data and close after a tick
  setTimeout(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout))
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr))
    proc.emit('close', exitCode)
  }, 0)

  return proc
}

describe('CertManager', () => {
  let tempDir: string
  let certManager: CertManager

  beforeEach(async () => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-manager-test-'))

    // Reset mocks
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Shutdown cert manager
    if (certManager) {
      await certManager.shutdown()
    }

    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('initialization', () => {
    it('should create instance with config', () => {
      certManager = new CertManager({
        certsDir: tempDir,
      })

      expect(certManager).toBeDefined()
    })

    it('should initialize and create certs directory', async () => {
      const certsDir = path.join(tempDir, 'certs')
      certManager = new CertManager({
        certsDir,
      })

      await certManager.initialize()

      expect(fs.existsSync(certsDir)).toBe(true)
    })

    it('should create cert index file on initialize', async () => {
      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      const indexPath = path.join(tempDir, 'cert-index.json')
      expect(fs.existsSync(indexPath)).toBe(true)

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
      expect(index.version).toBe(1)
      expect(index.certificates).toEqual({})
    })

    it('should load existing index on initialize', async () => {
      // Create existing index
      const existingIndex = {
        version: 1,
        certificates: {
          'test-ca': {
            name: 'test-ca',
            type: 'root-ca',
            groups: [],
            createdAt: '2024-01-01T00:00:00.000Z',
            expiresAt: '2025-01-01T00:00:00.000Z',
            certPath: '/path/to/ca.crt',
            keyPath: '/path/to/ca.key',
            revoked: false,
          },
        },
        lastModified: '2024-01-01T00:00:00.000Z',
      }
      fs.writeFileSync(
        path.join(tempDir, 'cert-index.json'),
        JSON.stringify(existingIndex)
      )

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      const cert = certManager.getCertificate('test-ca')
      expect(cert).toBeDefined()
      expect(cert?.name).toBe('test-ca')
    })

    it('should throw if not initialized when accessing certs', () => {
      certManager = new CertManager({
        certsDir: tempDir,
      })

      expect(() => certManager.listCertificates()).toThrow(
        'CertManager not initialized'
      )
    })
  })

  describe('validateSetup', () => {
    it('should validate when nebula-cert is available', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation((cmd) => {
        if (cmd === 'nebula-cert') {
          return createMockProcess('nebula-cert version 1.9.0', '', 0)
        }
        if (cmd === 'nebula') {
          return createMockProcess('', 'Version: 1.9.0', 0)
        }
        return createMockProcess('', 'not found', 1)
      })

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
      const validation = await certManager.validateSetup()

      expect(validation.valid).toBe(true)
      expect(validation.nebulaCertFound).toBe(true)
      expect(validation.nebulaCertVersion).toBe('1.9.0')
      expect(validation.certsDirWritable).toBe(true)
    })

    it('should fail validation when nebula-cert not found', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => {
        const proc = new EventEmitter() as childProcess.ChildProcess
        // @ts-expect-error - mocking
        proc.stdout = new EventEmitter()
        // @ts-expect-error - mocking
        proc.stderr = new EventEmitter()
        setTimeout(() => proc.emit('error', new Error('ENOENT')), 0)
        return proc
      })

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
      const validation = await certManager.validateSetup()

      expect(validation.valid).toBe(false)
      expect(validation.nebulaCertFound).toBe(false)
      expect(validation.errors.length).toBeGreaterThan(0)
    })
  })

  describe('createRootCA', () => {
    it('should create root CA', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation((cmd, args) => {
        if (args?.includes('ca')) {
          return createMockProcess('', '', 0)
        }
        if (args?.includes('print')) {
          return createMockProcess(
            JSON.stringify({
              details: { notAfter: '2025-01-01T00:00:00Z' },
            }),
            '',
            0
          )
        }
        return createMockProcess('', '', 0)
      })

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      const cert = await certManager.createRootCA({
        name: 'my-root-ca',
        groups: ['admin', 'users'],
      })

      expect(cert.name).toBe('my-root-ca')
      expect(cert.type).toBe('root-ca')
      expect(cert.groups).toEqual(['admin', 'users'])
      expect(cert.revoked).toBe(false)

      // Verify stored in index
      const storedCert = certManager.getCertificate('my-root-ca')
      expect(storedCert).toBeDefined()
    })

    it('should emit cert:created event', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      const createdHandler = vi.fn()
      certManager.on('cert:created', createdHandler)

      await certManager.createRootCA({ name: 'test-ca' })

      expect(createdHandler).toHaveBeenCalled()
      expect(createdHandler.mock.calls[0][0].cert.name).toBe('test-ca')
    })

    it('should throw if CA already exists', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
      await certManager.createRootCA({ name: 'test-ca' })

      await expect(
        certManager.createRootCA({ name: 'test-ca' })
      ).rejects.toThrow("Certificate 'test-ca' already exists")
    })

    it('should throw if nebula-cert fails', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() =>
        createMockProcess('', 'invalid duration', 1)
      )

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      await expect(
        certManager.createRootCA({ name: 'test-ca', duration: 'invalid' })
      ).rejects.toThrow('Failed to create root CA')
    })
  })

  describe('createUserCA', () => {
    beforeEach(async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      // Create root CA first
      await certManager.createRootCA({
        name: 'root-ca',
        groups: ['admin', 'users'],
      })
    })

    it('should create user CA signed by root', async () => {
      const cert = await certManager.createUserCA({
        name: 'user-ca',
        rootCAName: 'root-ca',
        groups: ['users'],
      })

      expect(cert.name).toBe('user-ca')
      expect(cert.type).toBe('user-ca')
      expect(cert.signedBy).toBe('root-ca')
      expect(cert.groups).toEqual(['users'])
    })

    it('should throw if root CA not found', async () => {
      await expect(
        certManager.createUserCA({
          name: 'user-ca',
          rootCAName: 'nonexistent',
        })
      ).rejects.toThrow("Root CA 'nonexistent' not found")
    })

    it('should throw if signing cert is not a root CA', async () => {
      // Create user CA first
      await certManager.createUserCA({
        name: 'user-ca-1',
        rootCAName: 'root-ca',
      })

      // Try to create another user CA signed by user CA
      await expect(
        certManager.createUserCA({
          name: 'user-ca-2',
          rootCAName: 'user-ca-1',
        })
      ).rejects.toThrow("'user-ca-1' is not a root CA")
    })
  })

  describe('signServerCert', () => {
    beforeEach(async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
      await certManager.createRootCA({
        name: 'root-ca',
        groups: ['servers'],
      })
    })

    it('should sign server certificate', async () => {
      const cert = await certManager.signServerCert({
        name: 'server-1',
        caName: 'root-ca',
        nebulaIp: '10.42.0.10/24',
        groups: ['servers'],
      })

      expect(cert.name).toBe('server-1')
      expect(cert.type).toBe('server')
      expect(cert.nebulaIp).toBe('10.42.0.10/24')
      expect(cert.signedBy).toBe('root-ca')
      expect(cert.groups).toEqual(['servers'])
    })

    it('should throw if CA not found', async () => {
      await expect(
        certManager.signServerCert({
          name: 'server-1',
          caName: 'nonexistent',
          nebulaIp: '10.42.0.10/24',
        })
      ).rejects.toThrow("CA 'nonexistent' not found")
    })
  })

  describe('certificate queries', () => {
    beforeEach(async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
      await certManager.createRootCA({ name: 'root-ca' })
      await certManager.createUserCA({
        name: 'user-ca',
        rootCAName: 'root-ca',
      })
      await certManager.signServerCert({
        name: 'server-1',
        caName: 'root-ca',
        nebulaIp: '10.42.0.1/24',
      })
      await certManager.signServerCert({
        name: 'server-2',
        caName: 'root-ca',
        nebulaIp: '10.42.0.2/24',
      })
    })

    it('should list all certificates', () => {
      const certs = certManager.listCertificates()
      expect(certs).toHaveLength(4)
    })

    it('should list certificates by type', () => {
      const rootCAs = certManager.listCertificatesByType('root-ca')
      expect(rootCAs).toHaveLength(1)

      const userCAs = certManager.listCertificatesByType('user-ca')
      expect(userCAs).toHaveLength(1)

      const servers = certManager.listCertificatesByType('server')
      expect(servers).toHaveLength(2)
    })

    it('should get certificate by name', () => {
      const cert = certManager.getCertificate('server-1')
      expect(cert).toBeDefined()
      expect(cert?.nebulaIp).toBe('10.42.0.1/24')
    })

    it('should return undefined for nonexistent cert', () => {
      const cert = certManager.getCertificate('nonexistent')
      expect(cert).toBeUndefined()
    })
  })

  describe('verifyCert', () => {
    beforeEach(async () => {
      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
    })

    it('should return invalid for nonexistent cert', async () => {
      const result = await certManager.verifyCert('nonexistent')

      expect(result.valid).toBe(false)
      expect(result.errors).toContain("Certificate 'nonexistent' not found")
    })

    it('should detect expired certificate', async () => {
      // Manually create expired cert in index
      const indexPath = path.join(tempDir, 'cert-index.json')
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      index.certificates['expired-cert'] = {
        name: 'expired-cert',
        type: 'server',
        groups: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        expiresAt: '2023-06-01T00:00:00.000Z', // In the past
        certPath: path.join(tempDir, 'expired.crt'),
        keyPath: path.join(tempDir, 'expired.key'),
        revoked: false,
      }

      fs.writeFileSync(indexPath, JSON.stringify(index))

      // Reload
      certManager = new CertManager({ certsDir: tempDir })
      await certManager.initialize()

      const result = await certManager.verifyCert('expired-cert')

      expect(result.valid).toBe(false)
      expect(result.notExpired).toBe(false)
      expect(result.errors).toContain('Certificate has expired')
    })

    it('should detect revoked certificate', async () => {
      const indexPath = path.join(tempDir, 'cert-index.json')
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      const futureDate = new Date()
      futureDate.setFullYear(futureDate.getFullYear() + 1)

      index.certificates['revoked-cert'] = {
        name: 'revoked-cert',
        type: 'server',
        groups: [],
        createdAt: new Date().toISOString(),
        expiresAt: futureDate.toISOString(),
        certPath: path.join(tempDir, 'revoked.crt'),
        keyPath: path.join(tempDir, 'revoked.key'),
        revoked: true,
      }

      fs.writeFileSync(indexPath, JSON.stringify(index))

      certManager = new CertManager({ certsDir: tempDir })
      await certManager.initialize()

      const result = await certManager.verifyCert('revoked-cert')

      expect(result.valid).toBe(false)
      expect(result.notRevoked).toBe(false)
      expect(result.errors).toContain('Certificate has been revoked')
    })
  })

  describe('getCertsNeedingRenewal', () => {
    beforeEach(async () => {
      certManager = new CertManager({
        certsDir: tempDir,
        autoRenewal: {
          enabled: false,
          renewBeforeDays: 7,
        },
      })

      await certManager.initialize()

      // Create certs with various expiration dates
      const indexPath = path.join(tempDir, 'cert-index.json')
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      const now = new Date()

      // Cert expiring in 3 days (needs renewal)
      const soon = new Date(now)
      soon.setDate(soon.getDate() + 3)
      index.certificates['expiring-soon'] = {
        name: 'expiring-soon',
        type: 'server',
        groups: [],
        createdAt: now.toISOString(),
        expiresAt: soon.toISOString(),
        certPath: '/path/to/cert',
        keyPath: '/path/to/key',
        revoked: false,
      }

      // Cert expiring in 30 days (doesn't need renewal)
      const later = new Date(now)
      later.setDate(later.getDate() + 30)
      index.certificates['expiring-later'] = {
        name: 'expiring-later',
        type: 'server',
        groups: [],
        createdAt: now.toISOString(),
        expiresAt: later.toISOString(),
        certPath: '/path/to/cert',
        keyPath: '/path/to/key',
        revoked: false,
      }

      fs.writeFileSync(indexPath, JSON.stringify(index))

      // Reload
      certManager = new CertManager({
        certsDir: tempDir,
        autoRenewal: { enabled: false, renewBeforeDays: 7 },
      })
      await certManager.initialize()
    })

    it('should return certs expiring within threshold', () => {
      const needingRenewal = certManager.getCertsNeedingRenewal()

      expect(needingRenewal).toHaveLength(1)
      expect(needingRenewal[0].name).toBe('expiring-soon')
    })

    it('should use custom threshold', () => {
      const needingRenewal = certManager.getCertsNeedingRenewal(60)

      expect(needingRenewal).toHaveLength(2)
    })

    it('should exclude revoked certs', async () => {
      const indexPath = path.join(tempDir, 'cert-index.json')
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

      // Mark expiring-soon as revoked
      index.certificates['expiring-soon'].revoked = true

      fs.writeFileSync(indexPath, JSON.stringify(index))

      certManager = new CertManager({
        certsDir: tempDir,
        autoRenewal: { enabled: false, renewBeforeDays: 7 },
      })
      await certManager.initialize()

      const needingRenewal = certManager.getCertsNeedingRenewal()
      expect(needingRenewal).toHaveLength(0)
    })
  })

  describe('renewServerCert', () => {
    it('should renew server certificate', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()

      await certManager.createRootCA({ name: 'root-ca' })
      await certManager.signServerCert({
        name: 'server-1',
        caName: 'root-ca',
        nebulaIp: '10.42.0.1/24',
        groups: ['servers'],
      })

      const renewedHandler = vi.fn()
      certManager.on('cert:renewed', renewedHandler)

      const newCert = await certManager.renewServerCert('server-1')

      expect(newCert.name).toBe('server-1')
      expect(newCert.nebulaIp).toBe('10.42.0.1/24')
      expect(renewedHandler).toHaveBeenCalled()
    })

    it('should throw for non-server certs', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
      })

      await certManager.initialize()
      await certManager.createRootCA({ name: 'root-ca' })

      await expect(certManager.renewServerCert('root-ca')).rejects.toThrow(
        'Can only renew server certificates automatically'
      )
    })
  })

  describe('auto-renewal', () => {
    it('should start auto-renewal when enabled', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({
        certsDir: tempDir,
        autoRenewal: {
          enabled: true,
          checkInterval: 100,
        },
      })

      await certManager.initialize()

      // Just verify it doesn't throw - actual renewal tested separately
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    it('should stop auto-renewal on shutdown', async () => {
      certManager = new CertManager({
        certsDir: tempDir,
        autoRenewal: {
          enabled: true,
          checkInterval: 100,
        },
      })

      await certManager.initialize()
      await certManager.shutdown()

      // Verify no errors after shutdown
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
  })

  describe('persistence', () => {
    it('should persist index across instances', async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      // Create first instance and add cert
      certManager = new CertManager({ certsDir: tempDir })
      await certManager.initialize()
      await certManager.createRootCA({ name: 'persistent-ca' })
      await certManager.shutdown()

      // Create second instance
      const certManager2 = new CertManager({ certsDir: tempDir })
      await certManager2.initialize()

      const cert = certManager2.getCertificate('persistent-ca')
      expect(cert).toBeDefined()
      expect(cert?.name).toBe('persistent-ca')

      await certManager2.shutdown()
    })
  })

  describe('revocation', () => {
    beforeEach(async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({ certsDir: tempDir })
      await certManager.initialize()

      // Create CA and server cert
      await certManager.createRootCA({ name: 'root-ca' })
      await certManager.signServerCert({
        name: 'server-1',
        caName: 'root-ca',
        nebulaIp: '10.42.0.1/24',
      })
    })

    it('should revoke certificate', async () => {
      await certManager.revokeCert('server-1', 'compromised')

      const cert = certManager.getCertificate('server-1')
      expect(cert?.revoked).toBe(true)
    })

    it('should emit cert:revoked event', async () => {
      const revokedHandler = vi.fn()
      certManager.on('cert:revoked', revokedHandler)

      await certManager.revokeCert('server-1', 'compromised')

      expect(revokedHandler).toHaveBeenCalled()
      expect(revokedHandler.mock.calls[0][0].cert.name).toBe('server-1')
      expect(revokedHandler.mock.calls[0][0].reason).toBe('compromised')
    })

    it('should add entry to revocation list', async () => {
      await certManager.revokeCert('server-1', 'key-leak')

      const revocationList = certManager.getRevocationList()
      expect(revocationList).toHaveLength(1)
      expect(revocationList[0].certName).toBe('server-1')
      expect(revocationList[0].reason).toBe('key-leak')
    })

    it('should throw when revoking nonexistent cert', async () => {
      await expect(
        certManager.revokeCert('nonexistent', 'test')
      ).rejects.toThrow("Certificate 'nonexistent' not found")
    })

    it('should throw when revoking already revoked cert', async () => {
      await certManager.revokeCert('server-1', 'first')

      await expect(
        certManager.revokeCert('server-1', 'second')
      ).rejects.toThrow("Certificate 'server-1' is already revoked")
    })

    it('should check if cert is revoked by name', async () => {
      expect(certManager.isRevoked('server-1')).toBe(false)

      await certManager.revokeCert('server-1', 'test')

      expect(certManager.isRevoked('server-1')).toBe(true)
    })

    it('should persist revocation list', async () => {
      await certManager.revokeCert('server-1', 'test')
      await certManager.shutdown()

      // Create new instance
      const certManager2 = new CertManager({ certsDir: tempDir })
      await certManager2.initialize()

      expect(certManager2.isRevoked('server-1')).toBe(true)
      const revocationList = certManager2.getRevocationList()
      expect(revocationList).toHaveLength(1)

      await certManager2.shutdown()
    })
  })

  describe('revocation export/import', () => {
    beforeEach(async () => {
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      certManager = new CertManager({ certsDir: tempDir })
      await certManager.initialize()

      await certManager.createRootCA({ name: 'root-ca' })
      await certManager.signServerCert({
        name: 'server-1',
        caName: 'root-ca',
        nebulaIp: '10.42.0.1/24',
      })
      await certManager.signServerCert({
        name: 'server-2',
        caName: 'root-ca',
        nebulaIp: '10.42.0.2/24',
      })
    })

    it('should export revocation list', async () => {
      await certManager.revokeCert('server-1', 'test')

      const exported = certManager.exportRevocationList()

      expect(exported.version).toBe(1)
      expect(exported.data).toBeTruthy()

      const parsed = JSON.parse(exported.data)
      expect(parsed.entries).toHaveLength(1)
    })

    it('should import revocation list', async () => {
      // Revoke in first manager
      await certManager.revokeCert('server-1', 'test')
      const exported = certManager.exportRevocationList()
      await certManager.shutdown()

      // Create second manager (simulating another peer)
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-import-test-'))
      const certManager2 = new CertManager({ certsDir: tempDir2 })
      await certManager2.initialize()

      // Import revocation list
      const addedCount = await certManager2.importRevocationList(exported)

      expect(addedCount).toBe(1)
      expect(certManager2.isRevoked('server-1')).toBe(true)

      await certManager2.shutdown()
      fs.rmSync(tempDir2, { recursive: true, force: true })
    })

    it('should not duplicate entries on re-import', async () => {
      await certManager.revokeCert('server-1', 'test')
      const exported = certManager.exportRevocationList()

      // Import same list twice
      const count1 = await certManager.importRevocationList(exported)
      const count2 = await certManager.importRevocationList(exported)

      expect(count1).toBe(0) // Already have it
      expect(count2).toBe(0)
      expect(certManager.getRevocationList()).toHaveLength(1)
    })

    it('should merge multiple revocation lists', async () => {
      // Revoke server-1
      await certManager.revokeCert('server-1', 'test')
      const exported1 = certManager.exportRevocationList()

      // Create second manager and revoke server-2
      const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-merge-test-'))
      const spawnMock = vi.mocked(childProcess.spawn)
      spawnMock.mockImplementation(() => createMockProcess('', '', 0))

      const certManager2 = new CertManager({ certsDir: tempDir2 })
      await certManager2.initialize()
      await certManager2.createRootCA({ name: 'root-ca' })
      await certManager2.signServerCert({
        name: 'server-2',
        caName: 'root-ca',
        nebulaIp: '10.42.0.2/24',
      })
      await certManager2.revokeCert('server-2', 'other-reason')
      const exported2 = certManager2.exportRevocationList()

      // Import into first manager
      const addedFromSecond = await certManager.importRevocationList(exported2)
      expect(addedFromSecond).toBe(1)

      // Import from first into second
      const addedFromFirst = await certManager2.importRevocationList(exported1)
      expect(addedFromFirst).toBe(1)

      // Both should have 2 revocations
      expect(certManager.getRevocationList()).toHaveLength(2)
      expect(certManager2.getRevocationList()).toHaveLength(2)

      await certManager2.shutdown()
      fs.rmSync(tempDir2, { recursive: true, force: true })
    })
  })
})
