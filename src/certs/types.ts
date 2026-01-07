// Certificate Management Types
// Implements: i-1bdm

// =============================================================================
// Configuration Types
// =============================================================================

export interface CertManagerConfig {
  /** Path to certificate storage directory */
  certsDir: string
  /** Path to nebula-cert binary (auto-detected if not specified) */
  nebulaCertPath?: string
  /** Path to nebula binary (for validation) */
  nebulaPath?: string
  /** Auto-renewal configuration */
  autoRenewal?: AutoRenewalConfig
}

export interface AutoRenewalConfig {
  /** Enable auto-renewal. Default: false */
  enabled: boolean
  /** Check interval in ms. Default: 3600000 (1 hour) */
  checkInterval?: number
  /** Renew certificates this many days before expiry. Default: 7 */
  renewBeforeDays?: number
}

// =============================================================================
// Certificate Types
// =============================================================================

export interface CertificateInfo {
  /** Certificate name/identifier */
  name: string
  /** Certificate type */
  type: 'root-ca' | 'user-ca' | 'server'
  /** Nebula IP address (for server certs) */
  nebulaIp?: string
  /** Groups assigned to this certificate */
  groups: string[]
  /** Certificate creation time */
  createdAt: Date
  /** Certificate expiration time */
  expiresAt: Date
  /** Path to .crt file */
  certPath: string
  /** Path to .key file */
  keyPath: string
  /** Parent CA name (for signed certs) */
  signedBy?: string
  /** Whether this cert has been revoked */
  revoked: boolean
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

export interface CertificateIndex {
  /** Index version for migrations */
  version: number
  /** All tracked certificates */
  certificates: Record<string, CertificateInfo>
  /** Last modified timestamp */
  lastModified: Date
}

// =============================================================================
// CA Creation Options
// =============================================================================

export interface CreateRootCAOptions {
  /** CA name (used as identifier) */
  name: string
  /** Validity duration. Default: "8760h" (1 year) */
  duration?: string
  /** Groups that can be assigned by this CA */
  groups?: string[]
}

export interface CreateUserCAOptions {
  /** User CA name */
  name: string
  /** Root CA name to sign with */
  rootCAName: string
  /** Validity duration. Default: "8760h" (1 year) */
  duration?: string
  /** Groups this CA can assign (subset of root CA groups) */
  groups?: string[]
}

export interface SignServerCertOptions {
  /** Server certificate name */
  name: string
  /** CA name to sign with (root or user CA) */
  caName: string
  /** Nebula IP address (e.g., "10.42.0.10/24") */
  nebulaIp: string
  /** Groups to assign */
  groups?: string[]
  /** Validity duration. Default: "8760h" (1 year) */
  duration?: string
  /** Subnets this cert can route */
  subnets?: string[]
}

// =============================================================================
// Validation Types
// =============================================================================

export interface SetupValidation {
  /** Overall validation passed */
  valid: boolean
  /** nebula-cert binary found and working */
  nebulaCertFound: boolean
  /** nebula-cert version (if found) */
  nebulaCertVersion?: string
  /** nebula binary found (optional) */
  nebulaFound: boolean
  /** nebula version (if found) */
  nebulaVersion?: string
  /** Certificates directory exists and writable */
  certsDirWritable: boolean
  /** Validation errors */
  errors: string[]
  /** Validation warnings */
  warnings: string[]
}

export interface CertVerification {
  /** Certificate is valid */
  valid: boolean
  /** Certificate chain is complete */
  chainValid: boolean
  /** Certificate is not expired */
  notExpired: boolean
  /** Certificate is not revoked */
  notRevoked: boolean
  /** Verification errors */
  errors: string[]
}

// =============================================================================
// Event Types
// =============================================================================

export type CertEventType =
  | 'cert:created'
  | 'cert:renewed'
  | 'cert:revoked'
  | 'cert:expiring'
  | 'cert:expired'
  | 'error'

export interface CertCreatedEvent {
  cert: CertificateInfo
}

export interface CertRenewedEvent {
  oldCert: CertificateInfo
  newCert: CertificateInfo
}

export interface CertExpiringEvent {
  cert: CertificateInfo
  daysUntilExpiry: number
}

// =============================================================================
// Revocation Types
// =============================================================================

export interface RevocationEntry {
  /** Certificate name that was revoked */
  certName: string
  /** Certificate fingerprint (SHA256 of cert content) */
  fingerprint: string
  /** Time of revocation */
  revokedAt: Date
  /** Reason for revocation */
  reason: string
  /** Who revoked (peer ID or 'local') */
  revokedBy: string
}

export interface RevocationList {
  /** Version for compatibility */
  version: number
  /** List of revoked certificates */
  entries: RevocationEntry[]
  /** Last updated timestamp */
  lastUpdated: Date
  /** Signature from issuing CA (optional) */
  signature?: string
}

export interface RevocationListExport {
  /** Serialized revocation list */
  data: string
  /** Format version */
  version: number
}

export interface CertRevokedEvent {
  cert: CertificateInfo
  reason: string
}

// =============================================================================
// Command Result Types
// =============================================================================

export interface CommandResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
}
