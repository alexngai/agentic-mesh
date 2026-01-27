// agentic-mesh type definitions

// Re-export transport types for convenience
export type { PeerEndpoint } from '../transports/types'

// =============================================================================
// Discovery Types (Phase 7.2)
// =============================================================================

export interface NebulaAutoConfigOptions {
  /** Local peer ID (required) */
  peerId: string
  /** Local peer name (optional, defaults to peerId) */
  peerName?: string
  /** Hub configuration override */
  hub?: HubConfig
  /** Port for mesh communication (default: 7946) */
  port?: number
  /** Enable peer discovery (default: true) */
  enableDiscovery?: boolean
  /** Discovery poll interval in ms (default: 30000) */
  discoveryInterval?: number
  /** Path to nebula-cert binary (default: 'nebula-cert') */
  nebulaCertPath?: string
}

// =============================================================================
// Hub Election Types
// =============================================================================

/**
 * Hub roles define the permission level for hub election.
 * Higher roles have priority in hub election.
 * Roles are per-server and determined by deployment configuration.
 */
export enum HubRole {
  /** Cannot become hub - read-only participant */
  MEMBER = 0,
  /** Can become hub if no higher-priority peers available */
  COORDINATOR = 1,
  /** Preferred hub role - highest priority */
  ADMIN = 2,
}

export interface HubConfig {
  /** Role for this peer in hub election */
  role: HubRole
  /** Tiebreaker within same role (higher = more preferred) */
  priority?: number
  /** List of peer IDs that can become hub (if empty, all peers can) */
  candidates?: string[]
}

export interface HubState {
  /** Current hub peer ID (null if no hub elected) */
  hubId: string | null
  /** Hub peer info */
  hub: PeerInfo | null
  /** Election term/epoch for consistency */
  term: number
  /** Timestamp of last election */
  electedAt: Date | null
}

// =============================================================================
// Peer Types
// =============================================================================

export type PeerStatus = 'online' | 'offline' | 'unknown'

import type { PeerEndpoint } from '../transports/types'

export interface PeerInfo {
  id: string
  name?: string
  /**
   * @deprecated Use endpoint.address instead. Kept for backward compatibility.
   */
  nebulaIp: string
  /**
   * @deprecated Use endpoint.port instead. Kept for backward compatibility.
   */
  port?: number
  /**
   * Transport-agnostic endpoint information.
   * New code should use this instead of nebulaIp/port.
   */
  endpoint?: PeerEndpoint
  status: PeerStatus
  lastSeen: Date
  groups: string[]
  activeNamespaces: string[]
  isHub: boolean
  hubRole?: HubRole
  hubPriority?: number
}

// =============================================================================
// Mesh Configuration
// =============================================================================

export interface PeerConfig {
  id: string
  nebulaIp: string
  name?: string
  port?: number // Override default port for this peer
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
  hub?: HubConfig

  // Timeouts
  connectionTimeout?: number // Default: 30000ms
  healthCheckInterval?: number // Default: 10000ms

  // Port for mesh communication
  port?: number // Default: 7946

  // Serialization (Phase 6.2)
  /**
   * Default serialization format for all channels.
   * - 'json': Always use JSON (backward compatible)
   * - 'binary': Always use MessagePack (best performance)
   * - 'auto': Negotiate with peer, prefer binary (default)
   */
  serialization?: 'json' | 'binary' | 'auto'

  /**
   * Enable compression for large messages (>1KB).
   * Only applies to binary format.
   * Default: true
   */
  compressionEnabled?: boolean
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

  // Permission enforcement (Phase 5)
  requiredGroups?: string[] // Groups required to send messages (empty = allow all)
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
  permissionDenied?: number // Phase 5: count of messages rejected due to permission
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
// Hub Relay Types (Phase 9.1)
// =============================================================================

/**
 * Message to be relayed through the hub for NAT-blocked peers.
 */
export interface RelayMessage<T = unknown> {
  type: 'relay'
  /** Original sender peer ID */
  from: string
  /** Target peer ID */
  to: string
  /** Channel name */
  channel: string
  /** Original message payload */
  payload: T
  /** Original message type */
  messageType: 'message' | 'request' | 'response'
  /** Request ID for RPC messages */
  requestId?: string
  /** Timestamp when relay was requested */
  timestamp: number
}

/**
 * Stats for hub relay operations.
 */
export interface RelayStats {
  /** Number of messages relayed */
  messagesRelayed: number
  /** Number of relay requests received */
  relayRequestsReceived: number
  /** Number of relay failures */
  relayFailures: number
  /** Number of messages queued for offline peers */
  messagesQueuedForRelay: number
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
  | 'peer:health'
  | 'hub:changed'
  | 'error'

export type ChannelEventType = 'message' | 'error'

export type SyncEventType = 'synced' | 'syncing' | 'error' | 'update' | 'peer:synced'

// =============================================================================
// Mesh Context (provided to SyncProviders and MessageChannels)
// =============================================================================

/**
 * Generic channel interface for type-safe channel creation.
 * This avoids circular imports with MessageChannel.
 */
export interface IMessageChannel<T = unknown> {
  readonly name: string
  readonly isOpen: boolean
  open(): Promise<void>
  close(): Promise<void>
  send(peerId: string, message: T): boolean
  broadcast(message: T): void

  // RPC methods
  request<R>(peerId: string, message: T, timeout?: number): Promise<R>
  onRequest(handler: (message: T, from: PeerInfo) => Promise<unknown>): void
  offRequest(): void

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this
}

/**
 * MeshContext is the primary interface for interacting with the mesh network.
 * It provides transport-agnostic access to peer management, hub election,
 * namespace registry, and channel creation.
 *
 * This interface is implemented by NebulaMesh and future transport implementations.
 * MessageChannel and SyncProviders depend on this interface, not concrete implementations.
 */
export interface MeshContext {
  // ========== Hub Info ==========

  /** Get the current hub peer, or null if no hub elected */
  getActiveHub(): PeerInfo | null

  /** Check if this peer is the current hub */
  isHub(): boolean

  // ========== Peer Info ==========

  /** Get all known peers */
  getPeers(): PeerInfo[]

  /** Get info about the local peer */
  getSelf(): PeerInfo

  /** Get info about a specific peer by ID */
  getPeer?(id: string): PeerInfo | null

  // ========== Namespace Registry ==========

  /** Register interest in a namespace for sync */
  registerNamespace(namespace: string): Promise<void>

  /** Unregister from a namespace */
  unregisterNamespace(namespace: string): Promise<void>

  /** Get all active namespaces and their participating peers */
  getActiveNamespaces(): Map<string, string[]>

  // ========== Channel Factory ==========

  /**
   * Create or get a message channel by name.
   * Channels are cached - calling with the same name returns the existing channel.
   *
   * @param name Unique channel name
   * @param config Optional channel configuration
   * @returns MessageChannel instance
   */
  createChannel<T>(name: string, config?: MessageChannelConfig): IMessageChannel<T>

  // ========== Internal Transport Operations ==========
  // These are used internally by MessageChannel and should not be called directly.

  /**
   * @internal Send a message to a specific peer on a channel.
   * @returns true if sent, false if peer not connected
   */
  _sendToPeer<T>(peerId: string, channelName: string, message: T): boolean

  /**
   * @internal Broadcast a message to all connected peers on a channel.
   */
  _broadcast<T>(channelName: string, message: T): void

  /**
   * @internal Send an RPC message (request or response) to a peer.
   * @returns true if sent, false if peer not connected
   */
  _sendRpc<T>(
    peerId: string,
    channelName: string,
    message: T,
    type: 'request' | 'response',
    requestId: string
  ): boolean

  /**
   * @internal Get the local peer ID.
   */
  _getPeerId(): string

  // ========== Events ==========

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string | symbol, listener: (...args: any[]) => void): this
}
