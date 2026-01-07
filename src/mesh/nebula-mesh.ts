// NebulaMesh - Core transport layer
// Implements: s-65f6

import { EventEmitter } from 'events'
import * as net from 'net'
import type {
  NebulaMeshConfig,
  PeerInfo,
  PeerConfig,
  MeshContext,
  WireMessage,
} from '../types'
import { MessageChannel } from '../channel/message-channel'

const DEFAULT_PORT = 7946
const DEFAULT_CONNECTION_TIMEOUT = 30000
const DEFAULT_HEALTH_CHECK_INTERVAL = 10000

export class NebulaMesh extends EventEmitter implements MeshContext {
  private config: Required<
    Pick<NebulaMeshConfig, 'peerId' | 'nebulaIp' | 'port' | 'connectionTimeout'>
  > &
    NebulaMeshConfig
  private peers: Map<string, PeerInfo> = new Map()
  private connections: Map<string, net.Socket> = new Map()
  private server: net.Server | null = null
  private channels: Map<string, MessageChannel<unknown>> = new Map()
  private namespaces: Set<string> = new Set()
  private _connected = false

  constructor(config: NebulaMeshConfig) {
    super()
    this.config = {
      ...config,
      port: config.port ?? DEFAULT_PORT,
      connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
      groups: config.groups ?? [],
    }

    // Initialize peer info from config
    for (const peerConfig of config.peers) {
      this.peers.set(peerConfig.id, this.peerConfigToInfo(peerConfig))
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    if (this._connected) return

    // Start TCP server for incoming connections
    await this.startServer()

    // Connect to configured peers
    await this.connectToPeers()

    this._connected = true
    this.emit('connected')
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return

    // Close all channels
    for (const channel of this.channels.values()) {
      await channel.close()
    }
    this.channels.clear()

    // Close all peer connections
    for (const socket of this.connections.values()) {
      socket.destroy()
    }
    this.connections.clear()

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }

    this._connected = false
    this.emit('disconnected', 'manual')
  }

  get connected(): boolean {
    return this._connected
  }

  // ==========================================================================
  // Peer Management
  // ==========================================================================

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values())
  }

  getPeer(id: string): PeerInfo | null {
    return this.peers.get(id) ?? null
  }

  getSelf(): PeerInfo {
    return {
      id: this.config.peerId,
      name: this.config.peerName,
      nebulaIp: this.config.nebulaIp,
      status: 'online',
      lastSeen: new Date(),
      groups: this.config.groups ?? [],
      activeNamespaces: Array.from(this.namespaces),
      isHub: false, // Phase 3
      hubPriority: this.config.hubPriority,
    }
  }

  private peerConfigToInfo(config: PeerConfig): PeerInfo {
    return {
      id: config.id,
      name: config.name,
      nebulaIp: config.nebulaIp,
      status: 'unknown',
      lastSeen: new Date(0),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    }
  }

  // ==========================================================================
  // Hub (Phase 3 - stub for now)
  // ==========================================================================

  getActiveHub(): PeerInfo | null {
    return null // Phase 3
  }

  isHub(): boolean {
    return false // Phase 3
  }

  // ==========================================================================
  // Namespace Registry
  // ==========================================================================

  async registerNamespace(namespace: string): Promise<void> {
    this.namespaces.add(namespace)
    // Phase 3: broadcast to hub
  }

  async unregisterNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace)
    // Phase 3: notify hub
  }

  getActiveNamespaces(): Map<string, string[]> {
    const result = new Map<string, string[]>()

    // Add our own namespaces
    for (const ns of this.namespaces) {
      result.set(ns, [this.config.peerId])
    }

    // Phase 3: aggregate from peers via hub
    return result
  }

  // ==========================================================================
  // Channel Factory
  // ==========================================================================

  createChannel<T>(name: string): MessageChannel<T> {
    if (this.channels.has(name)) {
      return this.channels.get(name) as MessageChannel<T>
    }

    const channel = new MessageChannel<T>(this, name)
    this.channels.set(name, channel as MessageChannel<unknown>)
    return channel
  }

  // ==========================================================================
  // Internal: Networking
  // ==========================================================================

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleIncomingConnection(socket)
      })

      this.server.on('error', (err) => {
        reject(err)
      })

      this.server.listen(this.config.port, this.config.nebulaIp, () => {
        resolve()
      })
    })
  }

  private async connectToPeers(): Promise<void> {
    const connectPromises = Array.from(this.peers.values()).map((peer) =>
      this.connectToPeer(peer).catch((err) => {
        console.warn(`Failed to connect to peer ${peer.id}:`, err.message)
      })
    )
    await Promise.all(connectPromises)
  }

  private async connectToPeer(peer: PeerInfo): Promise<void> {
    if (this.connections.has(peer.id)) return

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(
        {
          host: peer.nebulaIp,
          port: this.config.port,
          timeout: this.config.connectionTimeout,
        },
        () => {
          // Send handshake
          this.sendHandshake(socket)
          this.setupSocket(socket, peer.id)
          this.connections.set(peer.id, socket)

          // Update peer status
          peer.status = 'online'
          peer.lastSeen = new Date()
          this.emit('peer:joined', peer)

          resolve()
        }
      )

      socket.on('error', (err) => {
        peer.status = 'offline'
        reject(err)
      })

      socket.on('timeout', () => {
        socket.destroy()
        reject(new Error('Connection timeout'))
      })
    })
  }

  private handleIncomingConnection(socket: net.Socket): void {
    let peerId: string | null = null
    let buffer = ''

    socket.on('data', (data) => {
      buffer += data.toString()

      // Process complete messages (newline-delimited JSON)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const msg = JSON.parse(line)

          if (msg.type === 'handshake') {
            peerId = msg.peerId
            this.handleHandshake(socket, msg)
          } else if (peerId) {
            this.handleMessage(peerId, msg)
          }
        } catch (err) {
          console.error('Failed to parse message:', err)
        }
      }
    })

    socket.on('close', () => {
      if (peerId) {
        this.handlePeerDisconnect(peerId)
      }
    })

    socket.on('error', (err) => {
      console.error('Socket error:', err)
      if (peerId) {
        this.handlePeerDisconnect(peerId)
      }
    })
  }

  private setupSocket(socket: net.Socket, peerId: string): void {
    let buffer = ''

    socket.on('data', (data) => {
      buffer += data.toString()

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const msg = JSON.parse(line)
          this.handleMessage(peerId, msg)
        } catch (err) {
          console.error('Failed to parse message:', err)
        }
      }
    })

    socket.on('close', () => {
      this.handlePeerDisconnect(peerId)
    })

    socket.on('error', (err) => {
      console.error(`Socket error for peer ${peerId}:`, err)
    })
  }

  private sendHandshake(socket: net.Socket): void {
    const handshake = {
      type: 'handshake',
      peerId: this.config.peerId,
      peerName: this.config.peerName,
      groups: this.config.groups,
      namespaces: Array.from(this.namespaces),
    }
    socket.write(JSON.stringify(handshake) + '\n')
  }

  private handleHandshake(
    socket: net.Socket,
    msg: { peerId: string; peerName?: string; groups?: string[]; namespaces?: string[] }
  ): void {
    const peerId = msg.peerId

    // Check if we already have this peer configured
    let peer = this.peers.get(peerId)

    if (!peer) {
      // Unknown peer connecting - create entry
      const remoteAddress = socket.remoteAddress ?? 'unknown'
      peer = {
        id: peerId,
        name: msg.peerName,
        nebulaIp: remoteAddress,
        status: 'online',
        lastSeen: new Date(),
        groups: msg.groups ?? [],
        activeNamespaces: msg.namespaces ?? [],
        isHub: false,
      }
      this.peers.set(peerId, peer)
    } else {
      peer.status = 'online'
      peer.lastSeen = new Date()
      peer.name = msg.peerName ?? peer.name
      peer.groups = msg.groups ?? peer.groups
      peer.activeNamespaces = msg.namespaces ?? []
    }

    this.connections.set(peerId, socket)

    // Send our handshake back
    this.sendHandshake(socket)

    this.emit('peer:joined', peer)
  }

  private handlePeerDisconnect(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      peer.status = 'offline'
      this.emit('peer:left', peer)
    }
    this.connections.delete(peerId)
  }

  // ==========================================================================
  // Internal: Message Handling
  // ==========================================================================

  private handleMessage(fromPeerId: string, msg: WireMessage): void {
    if (msg.type === 'message' && msg.channel) {
      const channel = this.channels.get(msg.channel)
      if (channel) {
        const peer = this.peers.get(fromPeerId)
        if (peer) {
          channel._receiveMessage(msg.payload, peer)
        }
      }
    }
  }

  /** @internal - Used by MessageChannel */
  _sendToPeer<T>(peerId: string, channelName: string, message: T): boolean {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed) {
      return false
    }

    const wireMsg: WireMessage<T> = {
      id: crypto.randomUUID(),
      channel: channelName,
      type: 'message',
      payload: message,
      from: this.config.peerId,
      to: peerId,
      timestamp: Date.now(),
    }

    socket.write(JSON.stringify(wireMsg) + '\n')
    return true
  }

  /** @internal - Used by MessageChannel */
  _broadcast<T>(channelName: string, message: T): void {
    for (const [peerId, socket] of this.connections) {
      if (!socket.destroyed) {
        const wireMsg: WireMessage<T> = {
          id: crypto.randomUUID(),
          channel: channelName,
          type: 'message',
          payload: message,
          from: this.config.peerId,
          to: null,
          timestamp: Date.now(),
        }
        socket.write(JSON.stringify(wireMsg) + '\n')
      }
    }
  }
}
