// Certificate Management Module
// Provides PKI operations via nebula-cert binary

export { CertManager } from './cert-manager'
export { ConfigGenerator, configGenerator } from './config-generator'
export {
  GroupPermissions,
  groupPermissions,
  PermissionLevel,
  PermissionDeniedError,
} from './group-permissions'
export type {
  GroupHierarchy,
  GroupPermissionsConfig,
  PermissionCheckResult,
} from './group-permissions'
export { LighthouseManager } from './lighthouse-manager'
export type {
  LighthouseStatus,
  LighthouseInfo,
  LighthouseIndex,
  LighthouseManagerConfig,
  CreateLighthouseOptions,
  LighthouseHealth,
  LighthouseEventType,
} from './lighthouse-manager'

export type {
  // Configuration
  CertManagerConfig,
  AutoRenewalConfig,
  // Certificate types
  CertificateInfo,
  CertificateIndex,
  // Creation options
  CreateRootCAOptions,
  CreateUserCAOptions,
  SignServerCertOptions,
  // Validation
  SetupValidation,
  CertVerification,
  // Events
  CertEventType,
  CertCreatedEvent,
  CertRenewedEvent,
  CertExpiringEvent,
  CertRevokedEvent,
  // Revocation
  RevocationEntry,
  RevocationList,
  RevocationListExport,
  // Internal
  CommandResult,
} from './types'

export type {
  // Config generation types
  NebulaConfigOptions,
  LighthouseConfigOptions,
  FirewallConfig,
  FirewallRule,
  DnsConfig,
  LoggingConfig,
} from './config-generator'
