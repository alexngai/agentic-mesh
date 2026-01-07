// agentic-mesh
// P2P CRDT sync library over Nebula mesh networks

// Core exports
export { NebulaMesh } from './mesh'
export { MessageChannel } from './channel'
export { SyncProvider, YjsSyncProvider } from './sync'

// Integrations
export * from './integrations'

// Type exports
export type {
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
