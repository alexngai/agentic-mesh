// TailscaleTransport - TCP transport over Tailscale mesh network
// Implements TransportAdapter interface for Tailscale-based connectivity

import { EventEmitter } from 'events'
import * as net from 'net'
import type {
  TransportAdapter,
  PeerEndpoint,
  PeerConnection,
  TailscaleTransportConfig,
} from '../types'
import { TailscaleCLI, type TailscalePeerInfo } from './cli'

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PORT = 7946
const DEFAULT_CONNECTION_TIMEOUT = 30000

// =============================================================================
// TailscaleTransport
// =============================================================================

/**
 * TCP-based transport adapter for Tailscale mesh networks.
 *
 * This transport uses plain TCP sockets over the Tailscale virtual network interface.
 * Tailscale provides the encrypted tunnel and peer discovery; this adapter handles:
 * - TCP server for incoming connections
 * - TCP client connections to peers
 * - Raw data sending/receiving
 * - Connection lifecycle events
 *
 * It does NOT handle:
 * - Message framing/parsing (handled by mesh layer)
 * - Protocol logic (handshakes, hub election)
 * - Tailscale authentication (must be done separately)
 */
export class TailscaleTransport extends EventEmitter implements TransportAdapter {
  readonly type = 'tailscale'

  private config: {
    port: number
    connectionTimeout: number
    authKey?: string
    hostname?: string
    tailscaleBin: string
  }
  private cli: TailscaleCLI
  private server: net.Server | null = null
  private connections: Map<string, net.Socket> = new Map()
  private connectionInfo: Map<string, PeerConnection> = new Map()
  private pendingConnections: Map<string, Promise<boolean>> = new Map()
  private _active = false
  private _stopping = false
  private localIP: string | null = null

  constructor(config: TailscaleTransportConfig) {
    super()
    this.config = {
      port: config.port ?? DEFAULT_PORT,
      connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
      authKey: config.authKey,
      hostname: config.hostname,
      tailscaleBin: 'tailscale',
    }
    this.cli = new TailscaleCLI(this.config.tailscaleBin)
  }

  // ===========================================================================
  // TransportAdapter Properties
  // ===========================================================================

  get active(): boolean {
    return this._active
  }

  get localEndpoint(): PeerEndpoint {
    return {
      peerId: '', // Peer ID is managed by mesh layer, not transport
      address: this.localIP ?? '0.0.0.0',
      port: this.config.port,
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    if (this._active) {
      return
    }

    // Check Tailscale status
    const isConnected = await this.cli.isConnected()
    if (!isConnected) {
      const state = await this.cli.getBackendState().catch(() => 'Unknown')
      throw new Error(`Tailscale is not connected (state: ${state}). Run 'tailscale up' first.`)
    }

    // Get local Tailscale IP
    this.localIP = await this.cli.getLocalIP()

    // Start TCP server
    await this.startServer()
    this._active = true
    this.emit('listening')
  }

  async stop(): Promise<void> {
    if (!this._active) {
      return
    }

    this._stopping = true

    // Close all peer connections
    for (const [peerId, socket] of this.connections) {
      socket.destroy()
      this.connectionInfo.delete(peerId)
    }
    this.connections.clear()

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }

    this._active = false
    this._stopping = false
    this.emit('closed')
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  async connect(endpoint: PeerEndpoint): Promise<boolean> {
    if (!this._active) {
      throw new Error('Transport not active')
    }

    const peerId = endpoint.peerId

    // Already connected
    if (this.connections.has(peerId)) {
      return true
    }

    // Connection already in progress
    const pending = this.pendingConnections.get(peerId)
    if (pending) {
      return pending
    }

    // Start new connection
    const connectPromise = this.connectToPeer(endpoint)
    this.pendingConnections.set(peerId, connectPromise)

    try {
      const result = await connectPromise
      return result
    } finally {
      this.pendingConnections.delete(peerId)
    }
  }

  async disconnect(peerId: string): Promise<void> {
    const socket = this.connections.get(peerId)
    if (socket) {
      socket.destroy()
      this.connections.delete(peerId)
      this.connectionInfo.delete(peerId)
    }
  }

  getConnectedPeers(): string[] {
    return Array.from(this.connections.keys())
  }

  isConnected(peerId: string): boolean {
    const socket = this.connections.get(peerId)
    return socket !== undefined && !socket.destroyed
  }

  getConnection(peerId: string): PeerConnection | null {
    return this.connectionInfo.get(peerId) ?? null
  }

  // ===========================================================================
  // Messaging
  // ===========================================================================

  send(peerId: string, data: Buffer): boolean {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed) {
      return false
    }

    try {
      socket.write(data)
      return true
    } catch {
      return false
    }
  }

  broadcast(data: Buffer): Map<string, boolean> {
    const results = new Map<string, boolean>()

    for (const [peerId, socket] of this.connections) {
      if (!socket.destroyed) {
        try {
          socket.write(data)
          results.set(peerId, true)
        } catch {
          results.set(peerId, false)
        }
      } else {
        results.set(peerId, false)
      }
    }

    return results
  }

  // ===========================================================================
  // Tailscale-Specific Methods
  // ===========================================================================

  /**
   * Get the underlying Tailscale CLI wrapper.
   */
  getCLI(): TailscaleCLI {
    return this.cli
  }

  /**
   * Get all peers in the Tailscale network.
   */
  async getTailscalePeers(): Promise<TailscalePeerInfo[]> {
    return this.cli.getPeers()
  }

  /**
   * Get online peers in the Tailscale network.
   */
  async getOnlineTailscalePeers(): Promise<TailscalePeerInfo[]> {
    return this.cli.getOnlinePeers()
  }

  /**
   * Ping a Tailscale peer to check connectivity.
   * @param target Hostname, DNS name, or IP
   * @param timeout Timeout in seconds
   * @returns Latency in ms, or null if failed
   */
  async pingPeer(target: string, timeout = 5): Promise<number | null> {
    return this.cli.ping(target, timeout)
  }

  /**
   * Get transport configuration.
   */
  getConfig(): Readonly<typeof this.config> {
    return this.config
  }

  // ===========================================================================
  // Internal: Server
  // ===========================================================================

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleIncomingConnection(socket)
      })

      this.server.on('error', (err) => {
        if (!this._active) {
          reject(err)
        } else {
          this.emit('error', err)
        }
      })

      this.server.listen(this.config.port, this.localIP!, () => {
        resolve()
      })
    })
  }

  private handleIncomingConnection(socket: net.Socket): void {
    // For incoming connections, we don't know the peer ID yet
    // The mesh layer will identify the peer via handshake
    // We emit a special event for unidentified connections

    const remoteAddress = socket.remoteAddress ?? 'unknown'
    const remotePort = socket.remotePort ?? 0

    // Create a temporary ID based on remote address
    const tempId = `incoming:${remoteAddress}:${remotePort}`

    this.setupSocketHandlers(socket, tempId, true)

    // Emit event so mesh layer can handle the connection
    this.emit('connection', socket, {
      address: remoteAddress,
      port: remotePort,
    })
  }

  // ===========================================================================
  // Internal: Client Connection
  // ===========================================================================

  private async connectToPeer(endpoint: PeerEndpoint): Promise<boolean> {
    const peerId = endpoint.peerId
    const address = endpoint.address
    const port = endpoint.port ?? this.config.port

    return new Promise((resolve) => {
      const socket = net.createConnection(
        {
          host: address,
          port,
          timeout: this.config.connectionTimeout,
        },
        () => {
          // Connection established
          this.registerConnection(peerId, socket, endpoint)
          resolve(true)
        }
      )

      socket.on('error', () => {
        // Connection failures are expected when peers aren't online yet.
        // Don't emit error - just return false and let the caller handle it.
        resolve(false)
      })

      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
  }

  /**
   * Register a connection with a known peer ID.
   * Called after outgoing connection or after incoming connection is identified.
   */
  registerConnection(peerId: string, socket: net.Socket, endpoint: PeerEndpoint): void {
    // Remove any existing connection
    const existing = this.connections.get(peerId)
    if (existing && existing !== socket) {
      existing.destroy()
    }

    this.connections.set(peerId, socket)
    this.connectionInfo.set(peerId, {
      peerId,
      connected: true,
      lastActivity: new Date(),
      handle: socket,
    })

    this.setupSocketHandlers(socket, peerId, false)

    this.emit('peer:connected', peerId, endpoint)
  }

  /**
   * Update the peer ID for an incoming connection after identification.
   */
  identifyConnection(tempId: string, peerId: string, socket: net.Socket, endpoint: PeerEndpoint): void {
    // Remove temp entry if it exists
    this.connections.delete(tempId)
    this.connectionInfo.delete(tempId)

    // Register with real peer ID
    this.registerConnection(peerId, socket, endpoint)
  }

  // ===========================================================================
  // Internal: Socket Handlers
  // ===========================================================================

  private setupSocketHandlers(socket: net.Socket, peerId: string, isIncoming: boolean): void {
    socket.on('data', (data: Buffer) => {
      if (this._stopping) return

      // Update last activity
      const connInfo = this.connectionInfo.get(peerId)
      if (connInfo) {
        connInfo.lastActivity = new Date()
      }

      // Emit raw data to mesh layer for parsing
      this.emit('data', peerId, data)
    })

    socket.on('close', () => {
      if (this._stopping) return

      this.connections.delete(peerId)
      this.connectionInfo.delete(peerId)

      // Only emit disconnect for identified connections
      if (!peerId.startsWith('incoming:')) {
        this.emit('peer:disconnected', peerId, 'connection closed')
      }
    })

    socket.on('error', (err) => {
      if (this._stopping) return

      // Only emit for identified connections
      if (!peerId.startsWith('incoming:')) {
        this.emit('error', new Error(`Socket error for ${peerId}: ${err.message}`))
      }
    })
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get the underlying socket for a peer (for advanced use cases).
   * @internal
   */
  getSocket(peerId: string): net.Socket | null {
    return this.connections.get(peerId) ?? null
  }
}
