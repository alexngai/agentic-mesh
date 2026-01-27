// NebulaMesh - Core mesh layer
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
  NebulaAutoConfigOptions,
  RelayMessage,
  RelayStats,
  OptionalFeaturesConfig,
} from '../types'
import { HubRole } from '../types'
import { MessageChannel } from '../channel/message-channel'
import { OfflineQueue, QueuedOperation } from '../channel/offline-queue'
import { HubElection } from './hub-election'
import {
  NamespaceRegistry,
  NamespaceUpdate,
  NamespaceSnapshot,
} from './namespace-registry'
import { HealthMonitor } from './health-monitor'
import type { HealthChangeEvent, HealthMonitorAdapter } from './health-adapter'
import { NoopHealthMonitor } from './health-adapter'
import { SerializerManager, type SerializerCapabilities } from '../channel/serializers'
import {
  parseNebulaSetup,
  type NebulaSetup,
} from './nebula-config-parser'
import {
  PeerDiscovery,
  type DiscoveryMessage,
  type DiscoveryPeerInfo,
  discoveryPeerToPeerConfig,
} from './peer-discovery'
import { NebulaTransport } from '../transports/nebula'
import type { PeerEndpoint } from '../transports/types'

const DEFAULT_PORT = 7946
const DEFAULT_CONNECTION_TIMEOUT = 30000
const DEFAULT_HEALTH_CHECK_INTERVAL = 10000

const DEFAULT_HUB_CONFIG: HubConfig = {
  role: HubRole.MEMBER,
  priority: 0,
}

/**
 * Default optional features configuration.
 * All features are enabled by default for backward compatibility.
 */
const DEFAULT_FEATURES: Required<OptionalFeaturesConfig> = {
  hubElection: true,
  healthMonitoring: true,
  namespaceRegistry: true,
  hubRelay: true,
  offlineQueue: true,
}

export class NebulaMesh extends EventEmitter implements MeshContext {
  private config: Required<
    Pick<NebulaMeshConfig, 'peerId' | 'nebulaIp' | 'port' | 'connectionTimeout'>
  > &
    NebulaMeshConfig
  private peers: Map<string, PeerInfo> = new Map()
  private channels: Map<string, MessageChannel<unknown>> = new Map()
  private namespaces: Set<string> = new Set()
  private _connected = false
  private _disconnecting = false
  private hubElection: HubElection | null = null
  private namespaceRegistry: NamespaceRegistry | null = null
  private healthMonitor: HealthMonitorAdapter
  private serializer: SerializerManager

  // Phase 5: Optional features configuration
  private features: Required<OptionalFeaturesConfig>

  // Phase 10: Pluggable Transport
  private transport: NebulaTransport
  private peerBuffers: Map<string, string> = new Map() // Buffer per peer for message parsing
  private incomingBuffers: Map<string, string> = new Map() // Buffer for incoming connections (before handshake)
  private incomingSockets: Map<string, net.Socket> = new Map() // Temporary storage for incoming sockets

  // Phase 7.2: Peer Discovery
  private peerDiscovery: PeerDiscovery | null = null
  private discoveryChannel: MessageChannel<DiscoveryMessage> | null = null
  private nebulaSetup: NebulaSetup | null = null

  // Phase 9.1: Hub Relay
  private relayStats: RelayStats = {
    messagesRelayed: 0,
    relayRequestsReceived: 0,
    relayFailures: 0,
    messagesQueuedForRelay: 0,
  }

  // Phase 9.2: Hub Offline Queue
  private hubOfflineQueue: OfflineQueue | null = null

  constructor(config: NebulaMeshConfig) {
    super()
    this.config = {
      ...config,
      port: config.port ?? DEFAULT_PORT,
      connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
      groups: config.groups ?? [],
    }

    // Phase 5: Merge features with defaults
    this.features = {
      ...DEFAULT_FEATURES,
      ...config.features,
    }

    // Initialize hub election (conditionally - Phase 5)
    if (this.features.hubElection) {
      const hubConfig = config.hub ?? DEFAULT_HUB_CONFIG
      this.hubElection = new HubElection({
        peerId: config.peerId,
        hubConfig,
      })
    }

    // Initialize namespace registry (conditionally - Phase 5)
    if (this.features.namespaceRegistry && this.features.hubElection) {
      this.namespaceRegistry = new NamespaceRegistry(config.peerId)
    }

    // Initialize health monitor (conditionally - Phase 5)
    const healthCheckInterval = config.healthCheckInterval ?? DEFAULT_HEALTH_CHECK_INTERVAL
    if (this.features.healthMonitoring === true) {
      this.healthMonitor = new HealthMonitor({
        heartbeatInterval: healthCheckInterval,
      })
    } else {
      // Use noop health monitor when disabled or using transport-based health
      this.healthMonitor = new NoopHealthMonitor()
    }

    // Initialize serializer manager
    this.serializer = new SerializerManager({
      format: config.serialization ?? 'auto',
      compression: config.compressionEnabled ?? true,
    })

    // Initialize transport (Phase 10)
    this.transport = new NebulaTransport({
      type: 'nebula',
      nebulaIp: this.config.nebulaIp,
      port: this.config.port,
      connectionTimeout: this.config.connectionTimeout,
    })

    // Set up transport event handlers
    this.setupTransportHandlers()

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
      if (this.hubElection) {
        const peer = this.peers.get(hubId)
        if (peer) {
          this.hubElection.peerLeft(peer)
        }
      }
    })

    // Forward namespace events (if namespace registry is enabled)
    if (this.namespaceRegistry) {
      this.namespaceRegistry.on('namespace:updated', (update: NamespaceUpdate) => {
        // Hub broadcasts namespace updates to all peers
        if (this.isHub()) {
          this.broadcastNamespaceUpdate(update)
        }
      })
    }

    // Forward hub events (if hub election is enabled)
    if (this.hubElection) {
      this.hubElection.on('hub:changed', (event) => {
        this.emit('hub:changed', event)
        // Update health monitor with new hub
        this.healthMonitor.setHubId(event.current)
        // Broadcast hub announcement to all peers
        this.broadcastHubAnnouncement()

        // If we became hub, register our local namespaces and init offline queue
        if (event.current === config.peerId) {
          if (this.namespaceRegistry) {
            for (const ns of this.namespaces) {
              this.namespaceRegistry.registerPeer(ns, config.peerId)
            }
          }
          // Initialize hub offline queue (if enabled)
          if (this.features.offlineQueue) {
            this.hubOfflineQueue = new OfflineQueue({
              ttl: 24 * 60 * 60 * 1000, // 24 hours
              maxSize: 1000,
            })
            this.hubOfflineQueue.init().catch(() => {})
          }
        } else if (event.previous === config.peerId && this.hubOfflineQueue) {
          // We stopped being hub, cleanup queue
          this.hubOfflineQueue.stop().catch(() => {})
          this.hubOfflineQueue = null
        }
      })
    }

    // Initialize peer info from config
    for (const peerConfig of config.peers) {
      this.peers.set(peerConfig.id, this.peerConfigToInfo(peerConfig))
    }
  }

  // ==========================================================================
  // Transport Event Handlers (Phase 10)
  // ==========================================================================

  private setupTransportHandlers(): void {
    // Handle incoming connections (before handshake identifies the peer)
    this.transport.on('connection', (socket: net.Socket, info: { address: string; port: number }) => {
      const tempId = `incoming:${info.address}:${info.port}`
      this.incomingSockets.set(tempId, socket)
      this.incomingBuffers.set(tempId, '')
    })

    // Handle peer connected (after we initiate connection)
    this.transport.on('peer:connected', (peerId: string, endpoint: PeerEndpoint) => {
      // Initialize buffer for this peer
      this.peerBuffers.set(peerId, '')

      // Send handshake to identify ourselves
      this.sendHandshakeToPeer(peerId)
    })

    // Handle peer disconnected
    this.transport.on('peer:disconnected', (peerId: string) => {
      if (!this._disconnecting) {
        this.handlePeerDisconnect(peerId)
      }
      this.peerBuffers.delete(peerId)
    })

    // Handle incoming data
    this.transport.on('data', (peerId: string, data: Buffer) => {
      if (this._disconnecting) return

      // Check if this is from an identified peer or an incoming connection
      if (peerId.startsWith('incoming:')) {
        this.handleIncomingData(peerId, data)
      } else {
        this.handlePeerData(peerId, data)
      }
    })

    // Handle transport errors
    this.transport.on('error', (error: Error) => {
      if (!this._disconnecting) {
        this.emit('error', error)
      }
    })
  }

  /**
   * Handle data from an incoming connection (before handshake).
   */
  private handleIncomingData(tempId: string, data: Buffer): void {
    let buffer = this.incomingBuffers.get(tempId) ?? ''
    buffer += data.toString()

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    this.incomingBuffers.set(tempId, buffer)

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const msg = JSON.parse(line)

        if (msg.type === 'handshake') {
          const socket = this.incomingSockets.get(tempId)
          if (socket) {
            this.handleIncomingHandshake(tempId, socket, msg)
          }
        }
        // Other messages before handshake are ignored
      } catch (err) {
        if (!this._disconnecting) {
          console.error('Failed to parse incoming message:', err)
        }
      }
    }
  }

  /**
   * Handle data from an identified peer.
   */
  private handlePeerData(peerId: string, data: Buffer): void {
    let buffer = this.peerBuffers.get(peerId) ?? ''
    buffer += data.toString()

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    this.peerBuffers.set(peerId, buffer)

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const msg = JSON.parse(line)

        // Handle handshake response from peer we connected to
        if (msg.type === 'handshake') {
          this.processHandshake(peerId, msg)
        } else {
          this.handleMessage(peerId, msg)
        }
      } catch (err) {
        if (!this._disconnecting) {
          console.error('Failed to parse message:', err)
        }
      }
    }
  }

  /**
   * Handle handshake from an incoming connection.
   */
  private handleIncomingHandshake(
    tempId: string,
    socket: net.Socket,
    msg: {
      peerId: string
      peerName?: string
      groups?: string[]
      namespaces?: string[]
      hubRole?: HubRole
      hubPriority?: number
      serialization?: SerializerCapabilities
    }
  ): void {
    const peerId = msg.peerId

    // Clean up temporary storage
    this.incomingSockets.delete(tempId)
    this.incomingBuffers.delete(tempId)

    // Handle simultaneous connection race condition:
    // If we already have a connection to this peer (from our outgoing connection),
    // use a tie-breaker to decide which connection to keep.
    // The peer with the lexicographically larger ID keeps its outgoing connection.
    if (this.transport.isConnected(peerId)) {
      if (this.config.peerId > peerId) {
        // We have larger ID, keep our outgoing connection, reject incoming
        socket.destroy()
        return
      }
      // They have larger ID, they keep their outgoing (our incoming)
      // We'll accept this incoming connection and let transport replace the old one
    }

    // Identify the connection with the transport
    const endpoint: PeerEndpoint = {
      peerId,
      address: socket.remoteAddress ?? 'unknown',
      port: socket.remotePort ?? 0,
    }
    this.transport.identifyConnection(tempId, peerId, socket, endpoint)

    // Initialize buffer for this peer
    this.peerBuffers.set(peerId, '')

    // Process the handshake
    this.processHandshake(peerId, msg)

    // Send our handshake back
    this.sendHandshakeToPeer(peerId)
  }

  /**
   * Send handshake to a specific peer via transport.
   */
  private sendHandshakeToPeer(peerId: string): void {
    const hubConfig = this.config.hub ?? DEFAULT_HUB_CONFIG
    const handshake = {
      type: 'handshake',
      peerId: this.config.peerId,
      peerName: this.config.peerName,
      groups: this.config.groups,
      namespaces: Array.from(this.namespaces),
      hubRole: hubConfig.role,
      hubPriority: hubConfig.priority,
      // Phase 6.2: Serialization capabilities
      serialization: this.serializer.getCapabilities(),
    }
    const data = Buffer.from(JSON.stringify(handshake) + '\n')
    this.transport.send(peerId, data)
  }

  /**
   * Process handshake data from a peer (shared between incoming and outgoing).
   */
  private processHandshake(
    peerId: string,
    msg: {
      peerId: string
      peerName?: string
      groups?: string[]
      namespaces?: string[]
      hubRole?: HubRole
      hubPriority?: number
      serialization?: SerializerCapabilities
    }
  ): void {
    // Check if we already have this peer configured
    let peer = this.peers.get(peerId)
    const connection = this.transport.getConnection(peerId)
    const remoteAddress = (connection?.handle as net.Socket | undefined)?.remoteAddress ?? 'unknown'
    const wasAlreadyOnline = peer?.status === 'online'

    if (!peer) {
      // Unknown peer connecting - create entry
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

    // Phase 6.2: Negotiate serialization format
    const remoteCapabilities = msg.serialization ?? {
      supportedFormats: ['json'] as ('json' | 'binary')[],
      compressionSupported: false,
    }
    this.serializer.negotiateFormat(peerId, remoteCapabilities)

    // Only do these if peer wasn't already online (avoid duplicates)
    if (!wasAlreadyOnline) {
      // Notify hub election of new peer (if enabled)
      if (this.hubElection) {
        this.hubElection.peerJoined(peer)
      }

      // Register peer with health monitor
      this.healthMonitor.registerPeer(peer)

      // If we're hub, register peer's namespaces and send snapshot
      if (this.isHub()) {
        // Register namespaces the peer advertised in handshake (if registry enabled)
        if (this.namespaceRegistry) {
          for (const ns of msg.namespaces ?? []) {
            this.namespaceRegistry.registerPeer(ns, peerId)
          }
        }

        // Send current namespace state to the new peer
        this.sendNamespaceSnapshot(peerId)

        // Flush any queued relay messages for this peer (Phase 9.2)
        this.flushQueuedRelayMessages(peerId)
      }

      this.emit('peer:joined', peer)
    }
  }

  // ==========================================================================
  // Static Factory: fromNebulaConfig (Phase 7.2)
  // ==========================================================================

  /**
   * Create a NebulaMesh instance from an existing Nebula configuration file.
   *
   * This factory method:
   * - Parses the nebula config.yaml file
   * - Extracts PKI paths and lighthouse configuration
   * - Parses the certificate to get Nebula IP and groups
   * - Auto-configures the mesh based on lighthouse settings
   *
   * @param configPath Path to nebula config.yaml (supports ~ for home dir)
   * @param options Additional configuration options
   * @returns Configured NebulaMesh instance
   *
   * @example
   * ```typescript
   * const mesh = await NebulaMesh.fromNebulaConfig('~/.nebula/config.yaml', {
   *   peerId: 'alice',
   *   enableDiscovery: true,
   * })
   *
   * await mesh.connect()
   * mesh.startPeerDiscovery()  // Start discovering peers via lighthouses
   * ```
   */
  static async fromNebulaConfig(
    configPath: string,
    options: NebulaAutoConfigOptions
  ): Promise<NebulaMesh> {
    // Parse Nebula configuration and certificate
    const setup = await parseNebulaSetup(configPath, {
      nebulaCertPath: options.nebulaCertPath,
    })

    // Extract lighthouse peer configs from static_host_map
    const lighthousePeers: PeerConfig[] = []
    const lighthousePeerIds: string[] = []

    for (const [nebulaIp, endpoints] of setup.config.lighthouse.hosts) {
      // Generate a peer ID from the Nebula IP
      const peerId = `lighthouse-${nebulaIp.replace(/[./]/g, '-')}`
      lighthousePeerIds.push(peerId)

      lighthousePeers.push({
        id: peerId,
        nebulaIp: nebulaIp.split('/')[0], // Remove CIDR if present
        name: `Lighthouse ${nebulaIp}`,
        port: options.port ?? DEFAULT_PORT,
      })
    }

    // Create mesh config
    const meshConfig: NebulaMeshConfig = {
      peerId: options.peerId,
      peerName: options.peerName ?? options.peerId,
      nebulaIp: setup.cert.nebulaIp.split('/')[0], // Remove CIDR
      peers: lighthousePeers,
      groups: setup.cert.groups,
      hub: options.hub ?? {
        role: setup.config.isLighthouse ? HubRole.COORDINATOR : HubRole.MEMBER,
        priority: setup.config.isLighthouse ? 10 : 0,
      },
      port: options.port ?? DEFAULT_PORT,
      features: options.features, // Phase 5: Pass through optional features config
    }

    // Create mesh instance
    const mesh = new NebulaMesh(meshConfig)

    // Store setup for discovery
    mesh.nebulaSetup = setup

    // Set up peer discovery if enabled
    if (options.enableDiscovery !== false) {
      mesh.peerDiscovery = new PeerDiscovery({
        peerId: options.peerId,
        peerName: options.peerName,
        nebulaIp: setup.cert.nebulaIp.split('/')[0],
        port: options.port ?? DEFAULT_PORT,
        groups: setup.cert.groups,
        lighthousePeerIds,
        pollInterval: options.discoveryInterval ?? 30000,
        isLighthouse: setup.config.isLighthouse,
      })

      // Forward discovery events
      mesh.peerDiscovery.on('peer:discovered', (peer: DiscoveryPeerInfo) => {
        mesh.handleDiscoveredPeer(peer)
      })

      mesh.peerDiscovery.on('peer:lost', (peer: DiscoveryPeerInfo) => {
        mesh.emit('peer:discovery:lost', peer)
      })

      mesh.peerDiscovery.on('discovery:error', (error: unknown) => {
        mesh.emit('discovery:error', error)
      })
    }

    return mesh
  }

  /**
   * Get the Nebula setup info (if created via fromNebulaConfig).
   */
  getNebulaSetup(): NebulaSetup | null {
    return this.nebulaSetup
  }

  /**
   * Get the current optional features configuration.
   * Returns the merged configuration (defaults + user overrides).
   */
  getFeatures(): Required<OptionalFeaturesConfig> {
    return { ...this.features }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    if (this._connected) return

    // Start transport (handles TCP server)
    await this.transport.start()

    // Connect to configured peers via transport
    await this.connectToPeers()

    this._connected = true

    // Start hub election after connections established (if enabled)
    if (this.hubElection) {
      this.hubElection.updatePeers(Array.from(this.peers.values()))
      this.hubElection.start()
    }

    // Start health monitoring
    this.healthMonitor.start((peerId) => this.sendPing(peerId))

    this.emit('connected')
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return

    // Mark as disconnecting to suppress errors during shutdown
    this._disconnecting = true

    // Stop peer discovery
    if (this.peerDiscovery?.running) {
      await this.stopPeerDiscovery()
    }

    // Stop hub offline queue
    if (this.hubOfflineQueue) {
      await this.hubOfflineQueue.stop()
      this.hubOfflineQueue = null
    }

    // Stop health monitoring
    this.healthMonitor.stop()

    // Stop hub election (if enabled)
    if (this.hubElection) {
      this.hubElection.stop()
    }

    // Close all channels
    for (const channel of this.channels.values()) {
      await channel.close()
    }
    this.channels.clear()

    // Stop transport (closes all connections and server)
    await this.transport.stop()

    // Clear buffers
    this.peerBuffers.clear()
    this.incomingBuffers.clear()
    this.incomingSockets.clear()

    this._connected = false
    this._disconnecting = false
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
      isHub: this.hubElection?.isHub ?? false,
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
    if (!this.hubElection) {
      return null // No hub when hub election is disabled
    }
    const state = this.hubElection.state
    if (state.hubId === this.config.peerId) {
      return this.getSelf()
    }
    return state.hub
  }

  isHub(): boolean {
    if (!this.hubElection) {
      return false // Never hub when hub election is disabled
    }
    return this.hubElection.isHub
  }

  /**
   * Get the current hub election state.
   * Returns null if hub election is disabled.
   */
  getHubState() {
    if (!this.hubElection) {
      return null
    }
    return this.hubElection.state
  }

  /**
   * Broadcast hub announcement to all connected peers.
   */
  private broadcastHubAnnouncement(): void {
    if (!this.hubElection) {
      return // No announcements when hub election is disabled
    }
    const announcement = this.hubElection.createHubAnnouncement()
    const msg = {
      type: 'hub-announcement',
      ...announcement,
    }

    const data = Buffer.from(JSON.stringify(msg) + '\n')
    this.transport.broadcast(data)
  }

  // ==========================================================================
  // Namespace Registry
  // ==========================================================================

  async registerNamespace(namespace: string): Promise<void> {
    this.namespaces.add(namespace)

    // Skip namespace registry operations if disabled
    if (!this.namespaceRegistry) {
      return
    }

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

    // Skip namespace registry operations if disabled
    if (!this.namespaceRegistry) {
      return
    }

    if (this.isHub()) {
      // We're the hub - unregister directly
      this.namespaceRegistry.unregisterPeer(namespace, this.config.peerId)
    } else {
      // Send unregistration to hub
      this.sendNamespaceRegistration(namespace, 'unregister')
    }
  }

  getActiveNamespaces(): Map<string, string[]> {
    // If namespace registry is disabled, return local namespaces only
    if (!this.namespaceRegistry) {
      const result = new Map<string, string[]>()
      for (const ns of this.namespaces) {
        result.set(ns, [this.config.peerId])
      }
      return result
    }

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
    if (!this.namespaceRegistry) {
      // Return self only if we're in the namespace
      return this.namespaces.has(namespace) ? [this.config.peerId] : []
    }
    return this.namespaceRegistry.getPeersForNamespace(namespace)
  }

  /**
   * Send namespace registration/unregistration to hub.
   */
  private sendNamespaceRegistration(
    namespace: string,
    action: 'register' | 'unregister'
  ): void {
    if (!this.hubElection) return // No hub when hub election is disabled

    const hubId = this.hubElection.hubId
    if (!hubId || hubId === this.config.peerId) return

    if (!this.transport.isConnected(hubId)) return

    const msg = {
      type: action === 'register' ? 'namespace-register' : 'namespace-unregister',
      namespace,
      peerId: this.config.peerId,
    }

    const data = Buffer.from(JSON.stringify(msg) + '\n')
    this.transport.send(hubId, data)
  }

  /**
   * Broadcast namespace update to all peers (hub-side).
   */
  private broadcastNamespaceUpdate(update: NamespaceUpdate): void {
    const data = Buffer.from(JSON.stringify(update) + '\n')
    this.transport.broadcast(data)
  }

  /**
   * Send namespace snapshot to a specific peer (hub-side).
   */
  private sendNamespaceSnapshot(peerId: string): void {
    if (!this.namespaceRegistry) return // Namespace registry disabled

    if (!this.transport.isConnected(peerId)) return

    const snapshot = this.namespaceRegistry.createSnapshot()
    const data = Buffer.from(JSON.stringify(snapshot) + '\n')
    this.transport.send(peerId, data)
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
  // Internal: Networking (Transport-based)
  // ==========================================================================

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
    if (this.transport.isConnected(peer.id)) return

    const endpoint: PeerEndpoint = {
      peerId: peer.id,
      address: peer.nebulaIp,
      port: peer.port ?? this.config.port,
    }

    const success = await this.transport.connect(endpoint)
    if (!success) {
      peer.status = 'offline'
      throw new Error(`Failed to connect to peer ${peer.id}`)
    }

    // Note: peer:joined event and handshake will be triggered by transport events
    // after the connection is established and handshake completes
  }

  private handlePeerDisconnect(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      peer.status = 'offline'

      // Unregister from health monitor
      this.healthMonitor.unregisterPeer(peerId)

      // Clean up serializer format cache
      this.serializer.removePeer(peerId)

      // If we're hub, unregister peer from all namespaces (if registry enabled)
      if (this.isHub() && this.namespaceRegistry) {
        this.namespaceRegistry.unregisterPeerFromAll(peerId)
      }

      // Notify hub election of peer leaving (if enabled)
      if (this.hubElection) {
        this.hubElection.peerLeft(peer)
      }
      this.emit('peer:left', peer)
    }
    // Connection cleanup is handled by transport
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

    // Handle hub announcements (if hub election is enabled)
    if (msg.type === 'hub-announcement' && this.hubElection) {
      this.hubElection.receiveHubAnnouncement(fromPeerId, {
        hubId: msg.hubId,
        term: msg.term,
      })
      return
    }

    // Handle namespace registration (hub-side, if registry enabled)
    if (msg.type === 'namespace-register' && this.isHub() && this.namespaceRegistry) {
      this.namespaceRegistry.registerPeer(msg.namespace, msg.peerId)
      return
    }

    // Handle namespace unregistration (hub-side, if registry enabled)
    if (msg.type === 'namespace-unregister' && this.isHub() && this.namespaceRegistry) {
      this.namespaceRegistry.unregisterPeer(msg.namespace, msg.peerId)
      return
    }

    // Handle namespace updates (peer-side, if registry enabled)
    if (msg.type === 'namespace-update' && this.namespaceRegistry) {
      this.namespaceRegistry.applyUpdate(msg as NamespaceUpdate)
      return
    }

    // Handle namespace snapshot (peer-side, if registry enabled)
    if (msg.type === 'namespace-snapshot' && this.namespaceRegistry) {
      this.namespaceRegistry.applySnapshot(msg as NamespaceSnapshot)
      return
    }

    // Handle relay requests (hub-side) - Phase 9.1
    if (msg.type === 'relay' && this.isHub()) {
      this.handleRelayRequest(msg as RelayMessage)
      return
    }

    // Handle relayed messages (peer-side) - Phase 9.1
    if (msg.type === 'relayed') {
      this.handleRelayedMessage(fromPeerId, msg)
      return
    }

    // Handle channel messages
    if (msg.channel) {
      const channel = this.channels.get(msg.channel)
      if (channel) {
        const peer = this.peers.get(fromPeerId)
        if (peer) {
          if (msg.type === 'message') {
            channel._receiveMessage(msg.payload, peer)
          } else if (msg.type === 'request' && msg.requestId) {
            // RPC request - delegate to channel's request handler
            channel._receiveRequest(msg.payload, peer, msg.requestId)
          } else if (msg.type === 'response' && msg.requestId) {
            // RPC response - resolve pending request
            channel._receiveResponse(msg.payload, peer, msg.requestId)
          }
        }
      }
    }
  }

  /** @internal - Used by MessageChannel */
  _sendToPeer<T>(peerId: string, channelName: string, message: T): boolean {
    if (!this.transport.isConnected(peerId)) {
      // Try relay via hub if we're not the hub
      return this.tryRelay(peerId, channelName, message, 'message')
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

    const data = Buffer.from(JSON.stringify(wireMsg) + '\n')
    return this.transport.send(peerId, data)
  }

  /** @internal - Used by MessageChannel */
  _broadcast<T>(channelName: string, message: T): void {
    const connectedPeers = this.transport.getConnectedPeers()
    for (const peerId of connectedPeers) {
      const wireMsg: WireMessage<T> = {
        id: crypto.randomUUID(),
        channel: channelName,
        type: 'message',
        payload: message,
        from: this.config.peerId,
        to: null,
        timestamp: Date.now(),
      }
      const data = Buffer.from(JSON.stringify(wireMsg) + '\n')
      this.transport.send(peerId, data)
    }
  }

  /** @internal - Used by MessageChannel for RPC */
  _sendRpc<T>(
    peerId: string,
    channelName: string,
    message: T,
    type: 'request' | 'response',
    requestId: string
  ): boolean {
    if (!this.transport.isConnected(peerId)) {
      // Try relay via hub if we're not the hub
      return this.tryRelay(peerId, channelName, message, type, requestId)
    }

    const wireMsg: WireMessage<T> = {
      id: crypto.randomUUID(),
      channel: channelName,
      type,
      payload: message,
      from: this.config.peerId,
      to: peerId,
      timestamp: Date.now(),
      requestId,
    }

    const data = Buffer.from(JSON.stringify(wireMsg) + '\n')
    return this.transport.send(peerId, data)
  }

  /** @internal - Used by MessageChannel for request ID generation */
  _getPeerId(): string {
    return this.config.peerId
  }

  // ==========================================================================
  // Peer Discovery (Phase 7.2)
  // ==========================================================================

  /**
   * Start peer discovery via lighthouses.
   *
   * This requires the mesh to be created with `fromNebulaConfig()` with
   * `enableDiscovery: true` (the default).
   *
   * @param pollInterval Optional interval override in ms (default: from config)
   */
  async startPeerDiscovery(pollInterval?: number): Promise<void> {
    if (!this.peerDiscovery) {
      throw new Error(
        'Peer discovery not available. Create mesh with fromNebulaConfig() and enableDiscovery: true'
      )
    }

    if (this.peerDiscovery.running) {
      return
    }

    // Create discovery channel
    this.discoveryChannel = this.createChannel<DiscoveryMessage>('discovery:peers')

    // Start discovery
    await this.peerDiscovery.start(this.discoveryChannel)
  }

  /**
   * Stop peer discovery.
   */
  async stopPeerDiscovery(): Promise<void> {
    if (!this.peerDiscovery || !this.peerDiscovery.running) {
      return
    }

    await this.peerDiscovery.stop()

    if (this.discoveryChannel) {
      await this.discoveryChannel.close()
      this.discoveryChannel = null
    }
  }

  /**
   * Manually trigger peer discovery.
   * Returns the list of discovered peers.
   *
   * @param namespace Optional namespace filter
   */
  async discoverPeers(namespace?: string): Promise<DiscoveryPeerInfo[]> {
    if (!this.peerDiscovery) {
      throw new Error('Peer discovery not available')
    }

    return this.peerDiscovery.discoverPeers(namespace)
  }

  /**
   * Get discovered peers.
   */
  getDiscoveredPeers(): DiscoveryPeerInfo[] {
    if (!this.peerDiscovery) {
      return []
    }
    return this.peerDiscovery.getDiscoveredPeers()
  }

  /**
   * Whether peer discovery is running.
   */
  get discoveryRunning(): boolean {
    return this.peerDiscovery?.running ?? false
  }

  /**
   * Handle a discovered peer - add to peers if not already known.
   */
  private handleDiscoveredPeer(peer: DiscoveryPeerInfo): void {
    const existing = this.peers.get(peer.id)

    if (!existing) {
      // Add as new peer
      const peerConfig = discoveryPeerToPeerConfig(peer)
      const peerInfo = this.peerConfigToInfo(peerConfig)
      peerInfo.groups = peer.groups
      peerInfo.activeNamespaces = peer.namespaces
      this.peers.set(peer.id, peerInfo)
      this.emit('peer:discovered', peerInfo)

      // Attempt to connect if mesh is connected
      if (this._connected) {
        this.connectToPeer(peerInfo).catch(() => {
          // Connection failures are expected for unreachable peers
        })
      }
    } else {
      // Update existing peer info
      existing.name = peer.name ?? existing.name
      existing.groups = peer.groups
      existing.activeNamespaces = peer.namespaces
      this.emit('peer:updated', existing)
    }
  }

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  /**
   * Send a ping to a peer for health checking.
   */
  private sendPing(peerId: string): void {
    if (!this.transport.isConnected(peerId)) return

    const msg = {
      type: 'ping',
      timestamp: Date.now(),
    }
    const data = Buffer.from(JSON.stringify(msg) + '\n')
    this.transport.send(peerId, data)
  }

  /**
   * Send a pong response to a peer.
   */
  private sendPong(peerId: string): void {
    if (!this.transport.isConnected(peerId)) return

    const msg = {
      type: 'pong',
      timestamp: Date.now(),
    }
    const data = Buffer.from(JSON.stringify(msg) + '\n')
    this.transport.send(peerId, data)
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

  // ==========================================================================
  // Hub Relay (Phase 9.1)
  // ==========================================================================

  /**
   * Try to relay a message through the hub when direct connection fails.
   * @internal
   */
  private tryRelay<T>(
    peerId: string,
    channelName: string,
    message: T,
    messageType: 'message' | 'request' | 'response',
    requestId?: string
  ): boolean {
    // Hub relay must be enabled
    if (!this.features.hubRelay) {
      return false
    }

    // Can't relay if we are the hub (nowhere to relay to)
    if (this.isHub()) {
      return false
    }

    // Hub election must be enabled to have a hub
    if (!this.hubElection) {
      return false
    }

    // Get the hub
    const hubId = this.hubElection.hubId
    if (!hubId) {
      return false
    }

    if (!this.transport.isConnected(hubId)) {
      return false
    }

    // Send relay request to hub
    const relayMsg: RelayMessage<T> = {
      type: 'relay',
      from: this.config.peerId,
      to: peerId,
      channel: channelName,
      payload: message,
      messageType,
      requestId,
      timestamp: Date.now(),
    }

    const data = Buffer.from(JSON.stringify(relayMsg) + '\n')
    this.transport.send(hubId, data)
    this.emit('relay:sent', { to: peerId, channel: channelName, via: hubId })
    return true
  }

  /**
   * Handle a relay request (hub-side).
   * Forwards the message to the target peer if connected, or queues if offline.
   */
  private handleRelayRequest<T>(msg: RelayMessage<T>): void {
    this.relayStats.relayRequestsReceived++

    if (!this.transport.isConnected(msg.to)) {
      // Target not connected - queue for later delivery
      if (this.hubOfflineQueue) {
        this.hubOfflineQueue.enqueue(msg.channel, msg, msg.to)
        this.relayStats.messagesQueuedForRelay++
        this.emit('relay:queued', {
          from: msg.from,
          to: msg.to,
          channel: msg.channel,
        })
      } else {
        this.relayStats.relayFailures++
        this.emit('relay:failed', {
          from: msg.from,
          to: msg.to,
          reason: 'target_offline',
        })
      }
      return
    }

    // Forward the message to target as a 'relayed' message
    this.forwardRelayMessage(msg)
  }

  /**
   * Forward a relay message to the target peer.
   */
  private forwardRelayMessage<T>(msg: RelayMessage<T>): void {
    const relayedMsg = {
      type: 'relayed',
      originalFrom: msg.from,
      channel: msg.channel,
      payload: msg.payload,
      messageType: msg.messageType,
      requestId: msg.requestId,
      timestamp: msg.timestamp,
    }

    const data = Buffer.from(JSON.stringify(relayedMsg) + '\n')
    this.transport.send(msg.to, data)
    this.relayStats.messagesRelayed++
    this.emit('relay:forwarded', {
      from: msg.from,
      to: msg.to,
      channel: msg.channel,
    })
  }

  /**
   * Flush queued relay messages for a peer that has rejoined (hub-side).
   */
  private flushQueuedRelayMessages(peerId: string): void {
    if (!this.hubOfflineQueue || !this.isHub()) {
      return
    }

    if (!this.transport.isConnected(peerId)) {
      return
    }

    const queued = this.hubOfflineQueue.getForPeer(peerId)
    let flushed = 0

    for (const op of queued) {
      // Only flush messages specifically targeted to this peer (not broadcasts)
      if (op.targetPeerId !== peerId) {
        continue
      }

      const msg = op.message as RelayMessage
      this.forwardRelayMessage(msg)
      this.hubOfflineQueue.dequeue(op.id)
      flushed++
    }

    if (flushed > 0) {
      this.emit('relay:flushed', { peerId, count: flushed })
    }
  }

  /**
   * Handle a relayed message (peer-side).
   * Processes the message as if it came directly from the original sender.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleRelayedMessage(fromPeerId: string, msg: any): void {
    // Hub election must be enabled to verify relayed messages
    if (!this.hubElection) {
      console.warn('Received relayed message but hub election is disabled, ignoring')
      return
    }

    // Verify it came from the hub (security check)
    if (fromPeerId !== this.hubElection.hubId) {
      console.warn('Received relayed message from non-hub peer, ignoring')
      return
    }

    // Get or create a virtual peer info for the original sender
    let originalPeer = this.peers.get(msg.originalFrom)
    if (!originalPeer) {
      // Create a minimal peer entry for unknown relayed sender
      originalPeer = {
        id: msg.originalFrom,
        nebulaIp: 'relayed',
        status: 'online',
        lastSeen: new Date(),
        groups: [],
        activeNamespaces: [],
        isHub: false,
      }
    }

    // Route to appropriate channel
    const channel = this.channels.get(msg.channel)
    if (!channel) {
      return
    }

    if (msg.messageType === 'message') {
      channel._receiveMessage(msg.payload, originalPeer)
    } else if (msg.messageType === 'request' && msg.requestId) {
      channel._receiveRequest(msg.payload, originalPeer, msg.requestId)
    } else if (msg.messageType === 'response' && msg.requestId) {
      channel._receiveResponse(msg.payload, originalPeer, msg.requestId)
    }

    this.emit('relay:received', {
      from: msg.originalFrom,
      channel: msg.channel,
      via: fromPeerId,
    })
  }

  /**
   * Get relay statistics (hub-side stats are most relevant).
   */
  getRelayStats(): RelayStats {
    return { ...this.relayStats }
  }

  /**
   * Reset relay statistics.
   */
  resetRelayStats(): void {
    this.relayStats = {
      messagesRelayed: 0,
      relayRequestsReceived: 0,
      relayFailures: 0,
      messagesQueuedForRelay: 0,
    }
  }

  /**
   * Get hub offline queue stats (hub-side only).
   */
  getHubQueueStats(): { total: number; byChannel: Map<string, number> } | null {
    if (!this.hubOfflineQueue) {
      return null
    }
    return this.hubOfflineQueue.getStats()
  }
}
