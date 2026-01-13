// agentic-mesh
// P2P CRDT sync library over Nebula mesh networks

// Core exports
export { NebulaMesh } from './mesh'
export { HealthMonitor } from './mesh/health-monitor'
export type { HealthMonitorConfig, PeerHealth, HealthChangeEvent } from './mesh/health-monitor'
export { ExecutionRouter } from './mesh/execution-router'
export type {
  ExecutionRequest,
  ExecutionResponse,
  ExecutionRequestEvent,
  ExecutionRouterConfig,
} from './mesh/execution-router'
export { MessageChannel, OfflineQueue } from './channel'
export type { QueuedOperation, OfflineQueueConfig } from './channel'
export { SyncProvider, YjsSyncProvider } from './sync'

// cr-sqlite sync provider
export {
  CrSqliteSyncProvider,
  DbSyncError,
  detectExtensionPath,
  getExtensionPath,
  getInstallInstructions,
} from './sync'
export type {
  CrSqliteSyncConfig,
  DbSyncMessages,
  CrSqliteChangeset,
  ConflictInfo,
  DbSyncErrorCode,
} from './sync'

// Certificate management
export {
  CertManager,
  ConfigGenerator,
  configGenerator,
  GroupPermissions,
  groupPermissions,
  PermissionLevel,
  PermissionDeniedError,
  LighthouseManager,
} from './certs'
export type {
  CertManagerConfig,
  AutoRenewalConfig,
  CertificateInfo,
  CertificateIndex,
  CreateRootCAOptions,
  CreateUserCAOptions,
  SignServerCertOptions,
  SetupValidation,
  CertVerification,
  CertEventType,
  CertCreatedEvent,
  CertRenewedEvent,
  CertExpiringEvent,
  CertRevokedEvent,
  RevocationEntry,
  RevocationList,
  RevocationListExport,
  NebulaConfigOptions,
  LighthouseConfigOptions,
  FirewallConfig,
  FirewallRule,
  DnsConfig,
  LoggingConfig,
  GroupHierarchy,
  GroupPermissionsConfig,
  PermissionCheckResult,
  LighthouseStatus,
  LighthouseInfo,
  LighthouseIndex,
  LighthouseManagerConfig,
  CreateLighthouseOptions,
  LighthouseHealth,
  LighthouseEventType,
} from './certs'

// Integrations
export * from './integrations'

// ACP integration
export {
  AcpMeshAdapter,
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  // Session observation type guards (Phase 3)
  isSessionObserveRequest,
  isSessionUnobserveRequest,
  isSessionListRequest,
  isSessionEndedNotification,
} from './acp'
export { meshStream, createConnectedStreams } from './acp'
export type {
  AcpMessage,
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpError,
  AcpMeshEnvelope,
  AcpMeshAdapterConfig,
  BroadcastTarget,
  RespondFn,
  SessionUpdateCallback,
  MeshStreamConfig,
  AcpStream,
  AcpAnyMessage,
  // Session observation types (Phase 3)
  SessionInfo,
  SessionObserveRequest,
  SessionObserveResponse,
  SessionUnobserveRequest,
  SessionListRequest,
  SessionListResponse,
  SessionEndedNotification,
} from './acp'

// Type exports
export type {
  // Hub types
  HubConfig,
  HubState,
  // Peer types
  PeerStatus,
  PeerInfo,
  PeerConfig,
  // Mesh config
  NebulaMeshConfig,
  MeshContext,
  // Channel types
  MessageChannelConfig,
  QueuedMessage,
  MessageContext,
  ChannelStats,
  WireMessage,
  // Sync types
  SyncProviderConfig,
  SyncError,
  YjsSyncConfig,
  YjsMessage,
  YjsMessageType,
  // Event types
  MeshEventType,
  ChannelEventType,
  SyncEventType,
} from './types'

// Enum exports (enums need value export, not just type)
export { HubRole } from './types'
