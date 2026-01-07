// agentic-mesh type definitions

// =============================================================================
// Peer Types
// =============================================================================

export type PeerStatus = 'online' | 'offline' | 'unknown'

export interface PeerInfo {
  id: string
  name?: string
  nebulaIp: string
  status: PeerStatus
  lastSeen: Date
  groups: string[]
  activeNamespaces: string[]
  isHub: boolean
  hubPriority?: number
}

// =============================================================================
// Mesh Configuration
// =============================================================================

export interface PeerConfig {
  id: string
  nebulaIp: string
  name?: string
}

export interface NebulaMeshConfig {
  // Identity
  peerId: string
  peerName?: string
  nebulaIp: string

  // Peers (static for Phase 1)
  peers: PeerConfig[]

  // Groups (from certificate)
  groups?: string[]

  // Hub configuration (Phase 3)
  hubPriority?: number
  hubCandidates?: string[]

  // Timeouts
  connectionTimeout?: number // Default: 30000ms
  healthCheckInterval?: number // Default: 10000ms

  // Port for mesh communication
  port?: number // Default: 7946
}

// =============================================================================
// Message Channel Types
// =============================================================================

export interface MessageChannelConfig {
  // Queue behavior (Phase 3)
  enableOfflineQueue?: boolean // Default: true
  offlineQueueTTL?: number // Default: 86400000 (24h)
  maxQueueSize?: number // Default: 1000 messages

  // Delivery
  retryAttempts?: number // Default: 3
  retryDelay?: number // Default: 1000ms
  timeout?: number // Default: 30000ms
}

export interface QueuedMessage<T = unknown> {
  id: string
  message: T
  targetPeerId: string
  createdAt: Date
  expiresAt: Date
  attempts: number
}

export interface MessageContext {
  messageId: string
  from: PeerInfo
  timestamp: Date
}

export interface ChannelStats {
  messagesSent: number
  messagesReceived: number
  queuedMessages: number
  failedDeliveries: number
}

// Wire format for messages
export interface WireMessage<T = unknown> {
  id: string
  channel: string
  type: 'message' | 'request' | 'response'
  payload: T
  from: string
  to: string | null // null for broadcast
  timestamp: number
  requestId?: string // For response correlation
}

// =============================================================================
// Sync Provider Types
// =============================================================================

export interface SyncProviderConfig {
  namespace: string
}

export interface SyncError {
  code: string
  message: string
  peerId?: string
  recoverable: boolean
}

// =============================================================================
// Yjs Sync Provider Types
// =============================================================================

export interface YjsSyncConfig extends SyncProviderConfig {
  // Persistence (Phase 3)
  persistence?: {
    enabled: boolean
    path?: string
    snapshotInterval?: number // Default: 60000ms
  }

  // Awareness (Phase 3)
  awareness?: {
    enabled: boolean
    localState?: Record<string, unknown>
  }
}

// Yjs protocol message types
export type YjsMessageType = 'sync-step-1' | 'sync-step-2' | 'update' | 'awareness'

export interface YjsSyncStep1 {
  type: 'sync-step-1'
  stateVector: Uint8Array
}

export interface YjsSyncStep2 {
  type: 'sync-step-2'
  diff: Uint8Array
  stateVector?: Uint8Array
}

export interface YjsUpdate {
  type: 'update'
  update: Uint8Array
}

export interface YjsAwareness {
  type: 'awareness'
  changes: Uint8Array
}

export type YjsMessage = YjsSyncStep1 | YjsSyncStep2 | YjsUpdate | YjsAwareness

// =============================================================================
// Event Types
// =============================================================================

export type MeshEventType =
  | 'connected'
  | 'disconnected'
  | 'peer:joined'
  | 'peer:left'
  | 'peer:updated'
  | 'hub:changed'
  | 'error'

export type ChannelEventType = 'message' | 'error'

export type SyncEventType = 'synced' | 'syncing' | 'error' | 'update' | 'peer:synced'

// =============================================================================
// Mesh Context (provided to SyncProviders)
// =============================================================================

export interface MeshContext {
  // Hub info
  getActiveHub(): PeerInfo | null
  isHub(): boolean

  // Peer info
  getPeers(): PeerInfo[]
  getSelf(): PeerInfo

  // Namespace registry
  registerNamespace(namespace: string): Promise<void>
  unregisterNamespace(namespace: string): Promise<void>
  getActiveNamespaces(): Map<string, string[]>

  // Events - uses EventEmitter signatures
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this
}
