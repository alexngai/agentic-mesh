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
  HubConfig,
} from '../types'
import { HubRole } from '../types'
import { MessageChannel } from '../channel/message-channel'
import { HubElection } from './hub-election'
import {
  NamespaceRegistry,
  NamespaceUpdate,
  NamespaceSnapshot,
} from './namespace-registry'
import { HealthMonitor, HealthChangeEvent } from './health-monitor'

const DEFAULT_PORT = 7946
const DEFAULT_CONNECTION_TIMEOUT = 30000
const DEFAULT_HEALTH_CHECK_INTERVAL = 10000

const DEFAULT_HUB_CONFIG: HubConfig = {
  role: HubRole.MEMBER,
  priority: 0,
}

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
  private _disconnecting = false
  private hubElection: HubElection
  private namespaceRegistry: NamespaceRegistry
  private healthMonitor: HealthMonitor

  constructor(config: NebulaMeshConfig) {
    super()
    this.config = {
      ...config,
      port: config.port ?? DEFAULT_PORT,
      connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
      groups: config.groups ?? [],
    }

    // Initialize hub election
    const hubConfig = config.hub ?? DEFAULT_HUB_CONFIG
    this.hubElection = new HubElection({
      peerId: config.peerId,
      hubConfig,
    })

    // Initialize namespace registry
    this.namespaceRegistry = new NamespaceRegistry(config.peerId)

    // Initialize health monitor
    const healthCheckInterval = config.healthCheckInterval ?? DEFAULT_HEALTH_CHECK_INTERVAL
    this.healthMonitor = new HealthMonitor({
      heartbeatInterval: healthCheckInterval,
    })

    // Handle health monitor events
    this.healthMonitor.on('health:changed', (event: HealthChangeEvent) => {
      const peer = this.peers.get(event.peerId)
      if (peer && event.newStatus === 'offline') {
        this.handlePeerDisconnect(event.peerId)
      }
      this.emit('peer:health', event)
    })

    this.healthMonitor.on('hub:unhealthy', (hubId: string) => {
      // Trigger hub re-election when hub becomes unhealthy
      const peer = this.peers.get(hubId)
      if (peer) {
        this.hubElection.peerLeft(peer)
      }
    })

    // Forward namespace events
    this.namespaceRegistry.on('namespace:updated', (update: NamespaceUpdate) => {
      // Hub broadcasts namespace updates to all peers
      if (this.isHub()) {
        this.broadcastNamespaceUpdate(update)
      }
    })

    // Forward hub events
    this.hubElection.on('hub:changed', (event) => {
      this.emit('hub:changed', event)
      // Update health monitor with new hub
      this.healthMonitor.setHubId(event.current)
      // Broadcast hub announcement to all peers
      this.broadcastHubAnnouncement()

      // If we became hub, register our local namespaces
      if (event.current === config.peerId) {
        for (const ns of this.namespaces) {
          this.namespaceRegistry.registerPeer(ns, config.peerId)
        }
      }
    })

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

    // Start hub election after connections established
    this.hubElection.updatePeers(Array.from(this.peers.values()))
    this.hubElection.start()

    // Start health monitoring
    this.healthMonitor.start((peerId) => this.sendPing(peerId))

    this.emit('connected')
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return

    // Mark as disconnecting to suppress errors during shutdown
    this._disconnecting = true

    // Stop health monitoring
    this.healthMonitor.stop()

    // Stop hub election
    this.hubElection.stop()

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
    const hubConfig = this.config.hub ?? DEFAULT_HUB_CONFIG
    return {
      id: this.config.peerId,
      name: this.config.peerName,
      nebulaIp: this.config.nebulaIp,
      status: 'online',
      lastSeen: new Date(),
      groups: this.config.groups ?? [],
      activeNamespaces: Array.from(this.namespaces),
      isHub: this.hubElection.isHub,
      hubRole: hubConfig.role,
      hubPriority: hubConfig.priority,
    }
  }

  private peerConfigToInfo(config: PeerConfig): PeerInfo {
    return {
      id: config.id,
      name: config.name,
      nebulaIp: config.nebulaIp,
      port: config.port,
      status: 'unknown',
      lastSeen: new Date(0),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    }
  }

  // ==========================================================================
  // Hub Election
  // ==========================================================================

  getActiveHub(): PeerInfo | null {
    const state = this.hubElection.state
    if (state.hubId === this.config.peerId) {
      return this.getSelf()
    }
    return state.hub
  }

  isHub(): boolean {
    return this.hubElection.isHub
  }

  /**
   * Get the current hub election state.
   */
  getHubState() {
    return this.hubElection.state
  }

  /**
   * Broadcast hub announcement to all connected peers.
   */
  private broadcastHubAnnouncement(): void {
    const announcement = this.hubElection.createHubAnnouncement()
    const msg = {
      type: 'hub-announcement',
      ...announcement,
    }

    for (const [peerId, socket] of this.connections) {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(msg) + '\n')
      }
    }
  }

  // ==========================================================================
  // Namespace Registry
  // ==========================================================================

  async registerNamespace(namespace: string): Promise<void> {
    this.namespaces.add(namespace)

    if (this.isHub()) {
      // We're the hub - register directly
      this.namespaceRegistry.registerPeer(namespace, this.config.peerId)
    } else {
      // Send registration to hub
      this.sendNamespaceRegistration(namespace, 'register')
    }
  }

  async unregisterNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace)

    if (this.isHub()) {
      // We're the hub - unregister directly
      this.namespaceRegistry.unregisterPeer(namespace, this.config.peerId)
    } else {
      // Send unregistration to hub
      this.sendNamespaceRegistration(namespace, 'unregister')
    }
  }

  getActiveNamespaces(): Map<string, string[]> {
    // Use the namespace registry if we have synced data
    const registryData = this.namespaceRegistry.getAllNamespaces()
    if (registryData.size > 0) {
      return registryData
    }

    // Fallback to local namespaces only (pre-sync or single node)
    const result = new Map<string, string[]>()
    for (const ns of this.namespaces) {
      result.set(ns, [this.config.peerId])
    }
    return result
  }

  /**
   * Get peers participating in a specific namespace.
   */
  getPeersForNamespace(namespace: string): string[] {
    return this.namespaceRegistry.getPeersForNamespace(namespace)
  }

  /**
   * Send namespace registration/unregistration to hub.
   */
  private sendNamespaceRegistration(
    namespace: string,
    action: 'register' | 'unregister'
  ): void {
    const hubId = this.hubElection.hubId
    if (!hubId || hubId === this.config.peerId) return

    const socket = this.connections.get(hubId)
    if (!socket || socket.destroyed) return

    const msg = {
      type: action === 'register' ? 'namespace-register' : 'namespace-unregister',
      namespace,
      peerId: this.config.peerId,
    }

    socket.write(JSON.stringify(msg) + '\n')
  }

  /**
   * Broadcast namespace update to all peers (hub-side).
   */
  private broadcastNamespaceUpdate(update: NamespaceUpdate): void {
    for (const [peerId, socket] of this.connections) {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(update) + '\n')
      }
    }
  }

  /**
   * Send namespace snapshot to a specific peer (hub-side).
   */
  private sendNamespaceSnapshot(peerId: string): void {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed) return

    const snapshot = this.namespaceRegistry.createSnapshot()
    socket.write(JSON.stringify(snapshot) + '\n')
  }

  // ==========================================================================
  // Channel Factory
  // ==========================================================================

  createChannel<T>(
    name: string,
    config?: import('../types').MessageChannelConfig
  ): MessageChannel<T> {
    if (this.channels.has(name)) {
      return this.channels.get(name) as MessageChannel<T>
    }

    const channel = new MessageChannel<T>(this, name, config)
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
        if (!this._disconnecting) {
          console.warn(`Failed to connect to peer ${peer.id}:`, err.message)
        }
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
          port: peer.port ?? this.config.port,
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
          // Only log errors when not disconnecting (to avoid noise during shutdown)
          if (!this._disconnecting) {
            console.error('Failed to parse message:', err)
          }
        }
      }
    })

    socket.on('close', () => {
      if (peerId && !this._disconnecting) {
        this.handlePeerDisconnect(peerId)
      }
    })

    socket.on('error', (err) => {
      if (!this._disconnecting) {
        console.error('Socket error:', err)
        if (peerId) {
          this.handlePeerDisconnect(peerId)
        }
      }
    })
  }

  private setupSocket(socket: net.Socket, peerId: string): void {
    let buffer = ''

    socket.on('data', (data) => {
      // Ignore data during disconnection
      if (this._disconnecting) return

      buffer += data.toString()

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const msg = JSON.parse(line)
          this.handleMessage(peerId, msg)
        } catch (err) {
          if (!this._disconnecting) {
            console.error('Failed to parse message:', err)
          }
        }
      }
    })

    socket.on('close', () => {
      if (!this._disconnecting) {
        this.handlePeerDisconnect(peerId)
      }
    })

    socket.on('error', (err) => {
      if (!this._disconnecting) {
        console.error(`Socket error for peer ${peerId}:`, err)
      }
    })
  }

  private sendHandshake(socket: net.Socket): void {
    const hubConfig = this.config.hub ?? DEFAULT_HUB_CONFIG
    const handshake = {
      type: 'handshake',
      peerId: this.config.peerId,
      peerName: this.config.peerName,
      groups: this.config.groups,
      namespaces: Array.from(this.namespaces),
      hubRole: hubConfig.role,
      hubPriority: hubConfig.priority,
    }
    socket.write(JSON.stringify(handshake) + '\n')
  }

  private handleHandshake(
    socket: net.Socket,
    msg: {
      peerId: string
      peerName?: string
      groups?: string[]
      namespaces?: string[]
      hubRole?: HubRole
      hubPriority?: number
    }
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
        hubRole: msg.hubRole,
        hubPriority: msg.hubPriority,
      }
      this.peers.set(peerId, peer)
    } else {
      peer.status = 'online'
      peer.lastSeen = new Date()
      peer.name = msg.peerName ?? peer.name
      peer.groups = msg.groups ?? peer.groups
      peer.activeNamespaces = msg.namespaces ?? []
      peer.hubRole = msg.hubRole ?? peer.hubRole
      peer.hubPriority = msg.hubPriority ?? peer.hubPriority
    }

    this.connections.set(peerId, socket)

    // Send our handshake back
    this.sendHandshake(socket)

    // Notify hub election of new peer
    this.hubElection.peerJoined(peer)

    // Register peer with health monitor
    this.healthMonitor.registerPeer(peer)

    // If we're hub, register peer's namespaces and send snapshot
    if (this.isHub()) {
      // Register namespaces the peer advertised in handshake
      for (const ns of msg.namespaces ?? []) {
        this.namespaceRegistry.registerPeer(ns, peerId)
      }

      // Send current namespace state to the new peer
      this.sendNamespaceSnapshot(peerId)
    }

    this.emit('peer:joined', peer)
  }

  private handlePeerDisconnect(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      peer.status = 'offline'

      // Unregister from health monitor
      this.healthMonitor.unregisterPeer(peerId)

      // If we're hub, unregister peer from all namespaces
      if (this.isHub()) {
        this.namespaceRegistry.unregisterPeerFromAll(peerId)
      }

      // Notify hub election of peer leaving
      this.hubElection.peerLeft(peer)
      this.emit('peer:left', peer)
    }
    this.connections.delete(peerId)
  }

  // ==========================================================================
  // Internal: Message Handling
  // ==========================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(fromPeerId: string, msg: any): void {
    // Record traffic for health monitoring (any message counts as implicit heartbeat)
    this.healthMonitor.recordTraffic(fromPeerId)

    // Update peer lastSeen
    const peer = this.peers.get(fromPeerId)
    if (peer) {
      peer.lastSeen = new Date()
    }

    // Handle ping messages
    if (msg.type === 'ping') {
      this.sendPong(fromPeerId)
      return
    }

    // Handle pong messages
    if (msg.type === 'pong') {
      this.healthMonitor.recordPong(fromPeerId)
      return
    }

    // Handle hub announcements
    if (msg.type === 'hub-announcement') {
      this.hubElection.receiveHubAnnouncement(fromPeerId, {
        hubId: msg.hubId,
        term: msg.term,
      })
      return
    }

    // Handle namespace registration (hub-side)
    if (msg.type === 'namespace-register' && this.isHub()) {
      this.namespaceRegistry.registerPeer(msg.namespace, msg.peerId)
      return
    }

    // Handle namespace unregistration (hub-side)
    if (msg.type === 'namespace-unregister' && this.isHub()) {
      this.namespaceRegistry.unregisterPeer(msg.namespace, msg.peerId)
      return
    }

    // Handle namespace updates (peer-side)
    if (msg.type === 'namespace-update') {
      this.namespaceRegistry.applyUpdate(msg as NamespaceUpdate)
      return
    }

    // Handle namespace snapshot (peer-side)
    if (msg.type === 'namespace-snapshot') {
      this.namespaceRegistry.applySnapshot(msg as NamespaceSnapshot)
      return
    }

    // Handle channel messages
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

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  /**
   * Send a ping to a peer for health checking.
   */
  private sendPing(peerId: string): void {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed) return

    const msg = {
      type: 'ping',
      timestamp: Date.now(),
    }
    socket.write(JSON.stringify(msg) + '\n')
  }

  /**
   * Send a pong response to a peer.
   */
  private sendPong(peerId: string): void {
    const socket = this.connections.get(peerId)
    if (!socket || socket.destroyed) return

    const msg = {
      type: 'pong',
      timestamp: Date.now(),
    }
    socket.write(JSON.stringify(msg) + '\n')
  }

  /**
   * Get health status for all monitored peers.
   */
  getPeerHealth() {
    return this.healthMonitor.getAllPeerHealth()
  }

  /**
   * Get healthy (online) peer IDs.
   */
  getHealthyPeers(): string[] {
    return this.healthMonitor.getHealthyPeers()
  }

  /**
   * Check if the current hub is healthy.
   */
  isHubHealthy(): boolean {
    return this.healthMonitor.isHubHealthy()
  }
}
