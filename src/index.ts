// agentic-mesh
// P2P CRDT sync library over Nebula mesh networks

// Core exports
export { NebulaMesh } from './mesh'
export { HealthMonitor } from './mesh/health-monitor'
export type { HealthMonitorConfig, PeerHealth, HealthChangeEvent } from './mesh/health-monitor'
export { MessageChannel, OfflineQueue } from './channel'
export type { QueuedOperation, OfflineQueueConfig } from './channel'
export { SyncProvider, YjsSyncProvider } from './sync'

// Integrations
export * from './integrations'

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
