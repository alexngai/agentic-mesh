// Transport abstraction types
// Provides transport-agnostic interfaces for mesh networking

import { EventEmitter } from 'events'

// =============================================================================
// Peer Endpoint Types
// =============================================================================

/**
 * Transport-agnostic peer endpoint information.
 * Each transport defines how to reach a peer.
 */
export interface PeerEndpoint {
  /** Peer identifier (transport-agnostic) */
  peerId: string
  /** Transport-specific address (IP, URL, etc.) */
  address: string
  /** Optional port (for TCP-based transports) */
  port?: number
  /** Additional transport-specific metadata */
  metadata?: Record<string, unknown>
}

/**
 * Connection state for a peer.
 */
export interface PeerConnection {
  peerId: string
  connected: boolean
  lastActivity: Date
  /** Transport-specific connection handle */
  handle?: unknown
}

// =============================================================================
// Transport Events
// =============================================================================

/**
 * Events emitted by transport adapters.
 */
export interface TransportEvents {
  /** Emitted when a peer connection is established */
  'peer:connected': (peerId: string, endpoint: PeerEndpoint) => void
  /** Emitted when a peer connection is lost */
  'peer:disconnected': (peerId: string, reason?: string) => void
  /** Emitted when data is received from a peer */
  'data': (peerId: string, data: Buffer) => void
  /** Emitted on transport errors */
  'error': (error: Error) => void
  /** Emitted when transport is ready to accept connections */
  'listening': () => void
  /** Emitted when transport stops listening */
  'closed': () => void
}

// =============================================================================
// Transport Adapter Interface
// =============================================================================

/**
 * Abstract transport adapter interface.
 * Implementations provide the actual network connectivity.
 *
 * The transport layer is responsible for:
 * - Establishing and managing peer connections
 * - Sending and receiving raw data
 * - Emitting connection lifecycle events
 *
 * It is NOT responsible for:
 * - Message framing/parsing (handled by mesh layer)
 * - Protocol logic (handshakes, hub election, etc.)
 * - Message routing to channels
 */
export interface TransportAdapter extends EventEmitter {
  /** Transport type identifier (e.g., 'nebula', 'tailscale', 'tcp') */
  readonly type: string

  /** Whether the transport is currently active (listening + can connect) */
  readonly active: boolean

  /** Local endpoint information */
  readonly localEndpoint: PeerEndpoint

  // ========== Lifecycle ==========

  /**
   * Start the transport (begin listening for incoming connections).
   * @throws Error if transport fails to start
   */
  start(): Promise<void>

  /**
   * Stop the transport (close all connections and stop listening).
   */
  stop(): Promise<void>

  // ========== Connection Management ==========

  /**
   * Connect to a specific peer.
   * @param endpoint Peer endpoint information
   * @returns true if connection established or already connected
   * @throws Error if connection fails
   */
  connect(endpoint: PeerEndpoint): Promise<boolean>

  /**
   * Disconnect from a specific peer.
   * @param peerId Peer to disconnect from
   */
  disconnect(peerId: string): Promise<void>

  /**
   * Get all currently connected peer IDs.
   */
  getConnectedPeers(): string[]

  /**
   * Check if a peer is connected.
   * @param peerId Peer to check
   */
  isConnected(peerId: string): boolean

  /**
   * Get connection info for a peer.
   * @param peerId Peer to get info for
   * @returns Connection info or null if not connected
   */
  getConnection(peerId: string): PeerConnection | null

  // ========== Messaging ==========

  /**
   * Send data to a specific peer.
   * @param peerId Target peer
   * @param data Raw data to send
   * @returns true if sent successfully, false if peer not connected
   */
  send(peerId: string, data: Buffer): boolean

  /**
   * Send data to all connected peers.
   * @param data Raw data to send
   * @returns Map of peerId to send success
   */
  broadcast(data: Buffer): Map<string, boolean>

  // ========== Event Emitter Type Overrides ==========

  on<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this
  on(event: string | symbol, listener: (...args: unknown[]) => void): this

  off<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this
  off(event: string | symbol, listener: (...args: unknown[]) => void): this

  emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): boolean
  emit(event: string | symbol, ...args: unknown[]): boolean
}

// =============================================================================
// Transport Configuration
// =============================================================================

/**
 * Base transport configuration.
 */
export interface BaseTransportConfig {
  /** Transport type identifier */
  type: string
  /** Connection timeout in milliseconds */
  connectionTimeout?: number
}

/**
 * Nebula transport configuration.
 */
export interface NebulaTransportConfig extends BaseTransportConfig {
  type: 'nebula'
  /** Nebula tunnel IP address */
  nebulaIp: string
  /** Port for mesh communication (default: 7946) */
  port?: number
  /** Path to Nebula config file (for auto-discovery) */
  configPath?: string
  /** Path to nebula-cert binary */
  nebulaCertPath?: string
}

/**
 * Tailscale transport configuration (for future use).
 */
export interface TailscaleTransportConfig extends BaseTransportConfig {
  type: 'tailscale'
  /** Tailscale auth key (for new nodes) */
  authKey?: string
  /** Hostname to register with */
  hostname?: string
  /** Control server URL (for Headscale) */
  controlUrl?: string
  /** State directory */
  stateDir?: string
  /** Port for mesh communication (default: 7946) */
  port?: number
}

/**
 * Headscale transport configuration (for future use).
 */
export interface HeadscaleTransportConfig extends BaseTransportConfig {
  type: 'headscale'
  /** Headscale server URL */
  serverUrl: string
  /** API key for server operations */
  apiKey?: string
  /** Pre-auth key for node registration */
  preAuthKey?: string
  /** Hostname to register with */
  hostname?: string
  /** Port for mesh communication (default: 7946) */
  port?: number
}

/**
 * Plain TCP transport configuration (for testing/development).
 */
export interface TcpTransportConfig extends BaseTransportConfig {
  type: 'tcp'
  /** Local bind address */
  bindAddress: string
  /** Port for mesh communication */
  port: number
}

/**
 * Union type of all transport configurations.
 */
export type TransportConfig =
  | NebulaTransportConfig
  | TailscaleTransportConfig
  | HeadscaleTransportConfig
  | TcpTransportConfig

// =============================================================================
// Transport Factory
// =============================================================================

/**
 * Factory function type for creating transport adapters.
 */
export type TransportFactory = (config: TransportConfig) => TransportAdapter
