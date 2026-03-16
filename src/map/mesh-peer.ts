/**
 * Mesh Peer
 *
 * The main entry point for agentic-mesh with MAP protocol support.
 * Integrates the transport layer with the MAP server for a unified experience.
 */

import { EventEmitter } from 'events'
import type { TransportAdapter, PeerEndpoint } from '../transports/types'
import type {
  Agent,
  AgentId,
  ScopeId,
  Scope,
  Message,
  Address,
  MessageMeta,
  Event,
  SubscriptionFilter,
  SubscriptionOptions,
  MeshPeerConfig,
  MeshPeerEvents,
  SendResult,
  EventSubscription,
  MapAgentConnectionConfig,
  MapGatewayConfig,
  FederateConfig,
} from './types'
import { MapServer } from './server/map-server'
import { AgentConnection, createAgentConnection } from './connection/agent'
import { PeerConnection, createPeerConnection } from './connection/peer'
import { FederationGateway, createFederationGateway } from './federation/gateway'
import { TunnelStream } from './stream/tunnel-stream'
import { BaseConnection } from './connection/base'
import {
  GitTransportService,
  createGitTransportService,
  type PeerMessageSender,
} from '../git/transport-service'
import type { AnyGitMessage } from '../git/types'

/**
 * Factory for creating transport adapters.
 */
export type TransportFactory = (config: NonNullable<MeshPeerConfig['transport']>) => TransportAdapter

/**
 * Configuration for creating an embedded MeshPeer.
 * Transport is optional — the peer works fully in-process without one.
 */
export interface EmbeddedMeshPeerConfig {
  peerId: string
  peerName?: string
  transport?: MeshPeerConfig['transport']
  map?: MeshPeerConfig['map']
}

/**
 * Mesh Peer - the unified mesh node with MAP protocol support.
 */
export class MeshPeer extends EventEmitter {
  readonly peerId: string
  readonly peerName: string

  private readonly config: MeshPeerConfig
  private readonly mapServer: MapServer
  private transport: TransportAdapter | null = null
  private transportFactory: TransportFactory | null = null
  private readonly peerConnections = new Map<string, PeerConnection>()
  private readonly agentConnections = new Map<AgentId, AgentConnection>()
  private readonly federationGateways = new Map<string, FederationGateway>()
  private gitService: GitTransportService | null = null
  private running = false

  constructor(config: MeshPeerConfig, transportFactory?: TransportFactory) {
    super()
    this.config = config
    this.peerId = config.peerId
    this.peerName = config.peerName ?? config.peerId
    this.transportFactory = transportFactory ?? null

    // Initialize MAP server
    this.mapServer = new MapServer({
      systemId: config.peerId,
      systemName: config.peerName,
      ...config.map,
    })

    // Initialize git transport if enabled
    if (config.git?.enabled) {
      this.gitService = createGitTransportService({
        httpPort: config.git.httpPort ?? 3456,
        httpHost: config.git.httpHost ?? '127.0.0.1',
        git: {
          ...config.git.options,
          repoPath: config.git.repoPath ?? process.cwd(),
        },
      })
    }

    this.setupServerEvents()
  }

  /**
   * Create an embedded MeshPeer that runs in-process without a transport.
   * The MAP server, agent registration, and local messaging all work
   * without binding a server port or requiring a network transport.
   *
   * Transport can be added later via `start(transport)` for P2P connectivity.
   */
  static createEmbedded(config: EmbeddedMeshPeerConfig): MeshPeer {
    return new MeshPeer({
      ...config,
      embedded: true,
    })
  }

  /**
   * Get the MAP server instance.
   */
  get server(): MapServer {
    return this.mapServer
  }

  /**
   * Whether the peer is running.
   */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * Get all connected peer IDs.
   */
  get connectedPeers(): string[] {
    return Array.from(this.peerConnections.keys()).filter(
      (id) => this.peerConnections.get(id)?.isConnected
    )
  }

  /**
   * Get the git transport service (if enabled).
   */
  get git(): GitTransportService | null {
    return this.gitService
  }

  /**
   * Forward server events to this emitter.
   */
  private setupServerEvents(): void {
    this.mapServer.on('agent:registered', (agent) => {
      this.emit('agent:registered', agent)
    })

    this.mapServer.on('agent:unregistered', (agent) => {
      this.emit('agent:unregistered', agent)
    })

    this.mapServer.on('scope:created', (scope) => {
      this.emit('scope:created', scope)
    })

    this.mapServer.on('scope:deleted', (scope) => {
      this.emit('scope:deleted', scope)
    })

    this.mapServer.on('error', (error) => {
      this.emit('error', error)
    })
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the mesh peer.
   *
   * In embedded mode, transport is optional. The MAP server, agent registration,
   * and local message routing all work without a transport. If a transport is
   * provided (either as parameter or via factory), it will be started for P2P connectivity.
   */
  async start(transport?: TransportAdapter): Promise<void> {
    if (this.running) return

    // Create or use provided transport
    if (transport) {
      this.transport = transport
    } else if (this.transportFactory && this.config.transport) {
      this.transport = this.transportFactory(this.config.transport)
    } else if (!this.config.embedded) {
      throw new Error('No transport provided and no transport factory configured. Use embedded mode for in-process operation without transport.')
    }

    // Start transport if available
    if (this.transport) {
      await this.transport.start()
      this.setupTransportHandlers()
    }

    // Start MAP server
    await this.mapServer.start()

    // Start git transport service if enabled
    if (this.gitService && this.transport) {
      this.gitService.setPeerSender(this.createGitPeerSender())
      await this.gitService.start()
    }

    // Connect to initial peers
    if (this.config.peers && this.transport) {
      for (const endpoint of this.config.peers) {
        this.connectToPeer(endpoint).catch((err) => {
          this.emit('error', err)
        })
      }
    }

    this.running = true
    this.emit('started')
  }

  /**
   * Stop the mesh peer.
   */
  async stop(): Promise<void> {
    if (!this.running) return

    // Stop git transport service
    if (this.gitService) {
      await this.gitService.stop()
    }

    // Disconnect federation gateways
    for (const [systemId, gateway] of this.federationGateways) {
      await gateway.disconnect('shutting down')
    }
    this.federationGateways.clear()

    // Disconnect from all peers
    for (const [peerId, conn] of this.peerConnections) {
      await conn.disconnect('shutting down')
    }
    this.peerConnections.clear()

    // Unregister all agents
    for (const [agentId, conn] of this.agentConnections) {
      await conn.unregister('shutting down')
    }
    this.agentConnections.clear()

    // Stop MAP server
    await this.mapServer.stop()

    // Stop transport
    if (this.transport) {
      await this.transport.stop()
    }

    this.running = false
    this.emit('stopped')
  }

  /**
   * Create a peer message sender for git transport.
   */
  private createGitPeerSender(): PeerMessageSender {
    return {
      sendToPeer: async (peerId: string, message: AnyGitMessage): Promise<void> => {
        const conn = this.peerConnections.get(peerId)
        if (!conn) {
          throw new Error(`Peer ${peerId} not connected`)
        }
        // Send git message via the peer connection's message channel
        await conn.sendGitMessage(message)
      },
      isConnected: (peerId: string): boolean => {
        const conn = this.peerConnections.get(peerId)
        return conn?.isConnected ?? false
      },
    }
  }

  /**
   * Set up transport event handlers.
   */
  private setupTransportHandlers(): void {
    if (!this.transport) return

    this.transport.on('peer:connected', (peerId, endpoint) => {
      this.handlePeerConnected(peerId, endpoint)
    })

    this.transport.on('peer:disconnected', (peerId, reason) => {
      this.handlePeerDisconnected(peerId, reason)
    })

    this.transport.on('data', (peerId, data) => {
      this.handlePeerData(peerId, data)
    })

    this.transport.on('error', (error) => {
      this.emit('error', error)
    })
  }

  /**
   * Handle transport peer connection.
   */
  private handlePeerConnected(peerId: string, endpoint: PeerEndpoint): void {
    this.emit('peer:connected', peerId, endpoint)
  }

  /**
   * Handle transport peer disconnection.
   */
  private handlePeerDisconnected(peerId: string, reason?: string): void {
    // Remove peer connection
    const conn = this.peerConnections.get(peerId)
    if (conn) {
      this.peerConnections.delete(peerId)
    }

    // Unregister remote agents from this peer
    this.mapServer.unregisterPeerAgents(peerId)

    this.emit('peer:disconnected', peerId, reason)
  }

  /**
   * Handle incoming data from a peer.
   * Note: This is handled by the TunnelStream in PeerConnection
   */
  private handlePeerData(peerId: string, data: Buffer): void {
    // Data is processed by the peer connection's stream
  }

  // ==========================================================================
  // Peer Connections
  // ==========================================================================

  /**
   * Connect to a remote peer.
   */
  async connectToPeer(endpoint: PeerEndpoint): Promise<PeerConnection> {
    if (!this.transport) {
      throw new Error('Transport not started')
    }

    const peerId = endpoint.peerId

    // Check if already connected
    let conn = this.peerConnections.get(peerId)
    if (conn?.isConnected) {
      return conn
    }

    // Create peer connection
    conn = createPeerConnection({
      localPeerId: this.peerId,
      remotePeerId: peerId,
      remoteEndpoint: endpoint,
      transport: this.transport,
      reconnection: {
        enabled: true,
        maxRetries: 10,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
      },
    })

    // Set up event handlers
    conn.on('connected', () => {
      this.emit('peer:connected', peerId, endpoint)
    })

    conn.on('disconnected', (reason) => {
      this.emit('peer:disconnected', peerId, reason)
    })

    conn.on('agent:discovered', (agent) => {
      this.mapServer.registerRemoteAgent(agent.id, peerId)
    })

    conn.on('agent:removed', (agentId) => {
      this.mapServer.unregisterRemoteAgent(agentId)
    })

    conn.on('message', (message) => {
      // Forward messages to local agents
      this.handleRemoteMessage(peerId, message)
    })

    conn.on('git:message', (gitMessage) => {
      // Forward git messages to git service
      if (this.gitService) {
        this.gitService.handleRemoteMessage(peerId, gitMessage).catch((err) => {
          this.emit('error', err)
        })
      }
    })

    conn.on('error', (error) => {
      this.emit('error', error)
    })

    this.peerConnections.set(peerId, conn)

    // Connect
    await conn.connect()

    return conn
  }

  /**
   * Disconnect from a peer.
   */
  async disconnectFromPeer(peerId: string, reason?: string): Promise<void> {
    const conn = this.peerConnections.get(peerId)
    if (!conn) return

    await conn.disconnect(reason)
    this.peerConnections.delete(peerId)
  }

  /**
   * Get a peer connection.
   */
  getPeerConnection(peerId: string): PeerConnection | undefined {
    return this.peerConnections.get(peerId)
  }

  /**
   * Handle a message from a remote peer.
   */
  private async handleRemoteMessage(peerId: string, message: Message): Promise<void> {
    // The message is addressed to local agents
    // Extract the target from the message's 'to' field and deliver locally
    const to = message.to

    if (typeof to === 'string') {
      // Direct agent address
      const agent = this.mapServer.getAgent(to)
      if (agent) {
        await this.mapServer.send(message.from, to, message.payload, message.meta)
      }
    } else if (to && typeof to === 'object' && 'agent' in to) {
      // DirectAddress
      const agentId = (to as { agent: string }).agent
      const agent = this.mapServer.getAgent(agentId)
      if (agent) {
        await this.mapServer.send(message.from, agentId, message.payload, message.meta)
      }
    }
    // Other address types would need more sophisticated handling
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  /**
   * Create and register a local agent.
   */
  async createAgent(config: MapAgentConnectionConfig): Promise<AgentConnection> {
    const conn = createAgentConnection(this.mapServer, config)
    await conn.register()

    this.agentConnections.set(conn.agentId, conn)

    // Clean up when agent is unregistered
    conn.on('unregistered', (agent) => {
      this.agentConnections.delete(agent.id)
    })

    return conn
  }

  /**
   * Get an agent connection.
   */
  getAgentConnection(agentId: AgentId): AgentConnection | undefined {
    return this.agentConnections.get(agentId)
  }

  /**
   * Get all local agents.
   */
  getLocalAgents(): Agent[] {
    return this.mapServer.listAgents()
  }

  /**
   * Get all known agents (local and remote).
   */
  getAllAgents(): Agent[] {
    const agents = [...this.mapServer.listAgents()]

    // Add remote agents from peer connections
    for (const conn of this.peerConnections.values()) {
      agents.push(...conn.agents)
    }

    return agents
  }

  // ==========================================================================
  // Messaging
  // ==========================================================================

  /**
   * Send a message (convenience method).
   */
  async send(from: AgentId, to: Address, payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    // Check if target is local or remote
    const result = await this.mapServer.send(from, to, payload, meta)

    // If there were failed deliveries, try peer connections
    if (result.failed && result.failed.length > 0) {
      for (const failure of result.failed) {
        // Find which peer has this agent
        for (const [peerId, conn] of this.peerConnections) {
          if (conn.hasAgent(failure.participantId)) {
            try {
              await conn.sendMessage(failure.participantId, payload, meta)
              // Move from failed to delivered
              result.delivered.push(failure.participantId)
            } catch {
              // Keep in failed
            }
            break
          }
        }
      }
    }

    return result
  }

  // ==========================================================================
  // Scopes
  // ==========================================================================

  /**
   * Create a scope.
   */
  createScope(params: Parameters<MapServer['createScope']>[0]): Scope {
    return this.mapServer.createScope(params)
  }

  /**
   * Get a scope.
   */
  getScope(scopeId: ScopeId): Scope | undefined {
    return this.mapServer.getScope(scopeId)
  }

  /**
   * List scopes.
   */
  listScopes(): Scope[] {
    return this.mapServer.listScopes()
  }

  // ==========================================================================
  // Federation
  // ==========================================================================

  /**
   * Establish a federation link with a remote MAP system.
   * Creates a FederationGateway if one doesn't exist for this system.
   *
   * The gateway handles:
   * - Envelope wrapping (federation headers, system identification)
   * - Hop counting (configurable maxHops, default 5)
   * - Loop detection (path tracking to prevent circular routing)
   * - Message buffering (configurable queue for offline peers)
   * - JSON-RPC handshake on connect()
   *
   * After calling `federateWith()`, the caller must provide a transport
   * by calling `gateway.connect(stream)` with a MapStream — unless a peer
   * connection already exists, in which case auto-connect is attempted.
   *
   * Accepts either the simplified `FederateConfig` or the full `MapGatewayConfig`.
   *
   * @param remoteSystemId - The system ID of the remote MAP system
   * @param config - Optional gateway configuration
   * @returns The FederationGateway instance
   *
   * @example
   * ```typescript
   * // Create gateway with simplified config
   * const gw = await peer.federateWith("remote-system", {
   *   buffer: { enabled: true, maxMessages: 1000 },
   *   routing: { maxHops: 5, trackPath: true },
   * });
   *
   * // Connect via linked streams (test) or let auto-connect handle it (production)
   * await gw.connect(stream);
   * ```
   */
  async federateWith(
    remoteSystemId: string,
    config?: FederateConfig | Partial<MapGatewayConfig>
  ): Promise<FederationGateway> {
    // Return existing gateway if already federated
    let gateway = this.federationGateways.get(remoteSystemId)
    if (gateway) {
      return gateway
    }

    // Normalize config to MapGatewayConfig
    const gatewayConfig = this.toGatewayConfig(remoteSystemId, config)

    // Create gateway
    gateway = createFederationGateway(this.mapServer, gatewayConfig)

    // Forward gateway events
    gateway.on('connected', (systemId) => {
      this.emit('federation:connected', systemId)
    })

    gateway.on('disconnected', (systemId, reason) => {
      this.emit('federation:disconnected', systemId)
    })

    gateway.on('error', (error) => {
      this.emit('error', error)
    })

    this.federationGateways.set(remoteSystemId, gateway)

    // If we have a peer connection to this system, auto-connect via TunnelStream
    if (this.transport) {
      const peerConn = this.peerConnections.get(remoteSystemId)
      if (peerConn?.isConnected) {
        const stream = new TunnelStream({
          transport: this.transport,
          peerId: remoteSystemId,
          streamId: `federation-${remoteSystemId}`,
        })
        await stream.open()
        await gateway.connect(stream)
      }
    }

    return gateway
  }

  /**
   * Get an existing federation gateway by remote system ID.
   * Returns undefined if no gateway exists for the given system.
   */
  getFederationGateway(remoteSystemId: string): FederationGateway | undefined {
    return this.federationGateways.get(remoteSystemId)
  }

  /**
   * List all active federation gateways.
   */
  getFederationGateways(): FederationGateway[] {
    return Array.from(this.federationGateways.values())
  }

  /**
   * Disconnect a federation link and clean up the gateway.
   * @param remoteSystemId - The system to defederate from
   * @param reason - Optional reason for defederation
   */
  async defederate(remoteSystemId: string, reason?: string): Promise<void> {
    const gateway = this.federationGateways.get(remoteSystemId)
    if (!gateway) return

    await gateway.disconnect(reason)
    this.federationGateways.delete(remoteSystemId)
  }

  /**
   * Normalize FederateConfig or partial MapGatewayConfig to a full MapGatewayConfig.
   */
  private toGatewayConfig(
    remoteSystemId: string,
    config?: FederateConfig | Partial<MapGatewayConfig>
  ): MapGatewayConfig {
    if (!config) {
      return {
        localSystemId: this.peerId,
        remoteSystemId,
        remoteEndpoint: '',
      }
    }

    // If it has remoteEndpoint, treat as MapGatewayConfig
    if ('remoteEndpoint' in config && config.remoteEndpoint !== undefined) {
      return {
        localSystemId: this.peerId,
        remoteSystemId,
        remoteEndpoint: '',
        ...config,
      }
    }

    // Treat as FederateConfig
    const fc = config as FederateConfig
    return {
      localSystemId: fc.localSystemId ?? this.peerId,
      remoteSystemId: fc.remoteSystemId ?? remoteSystemId,
      remoteEndpoint: '',
      buffer: fc.buffer ? {
        enabled: fc.buffer.enabled,
        maxMessages: fc.buffer.maxMessages,
      } : undefined,
      routing: fc.routing ? {
        maxHops: fc.routing.maxHops,
        trackPath: fc.routing.trackPath,
      } : undefined,
    }
  }

  // ==========================================================================
  // Subscriptions
  // ==========================================================================

  /**
   * Subscribe to events.
   */
  subscribe(
    participantId: string,
    filter?: SubscriptionFilter,
    options?: SubscriptionOptions
  ): EventSubscription {
    return this.mapServer.subscribe(participantId, filter, options)
  }

  // ==========================================================================
  // System Info
  // ==========================================================================

  /**
   * Get system information.
   */
  getSystemInfo(): ReturnType<MapServer['getSystemInfo']> & { connectedPeers: number } {
    return {
      ...this.mapServer.getSystemInfo(),
      connectedPeers: this.connectedPeers.length,
    }
  }
}

/**
 * Create a mesh peer.
 */
export function createMeshPeer(
  config: MeshPeerConfig,
  transportFactory?: TransportFactory
): MeshPeer {
  return new MeshPeer(config, transportFactory)
}
