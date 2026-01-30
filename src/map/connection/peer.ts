/**
 * Peer Connection
 *
 * Manages a MAP protocol connection to a remote peer over an agentic-mesh transport.
 */

import { EventEmitter } from 'events'
import type { TransportAdapter, PeerEndpoint } from '../../transports/types'
import type {
  Agent,
  AgentId,
  ParticipantId,
  Message,
  MessageMeta,
  Event,
  MapConnectionState,
  MapPeerConnectionConfig,
} from '../types'
import {
  CORE_METHODS,
  LIFECYCLE_METHODS,
  NOTIFICATION_METHODS,
  PROTOCOL_VERSION,
  type ConnectResponseResult,
  type AgentsListResponseResult,
} from '../types'
import { BaseConnection } from './base'
import { TunnelStream } from '../stream/tunnel-stream'

/**
 * Events emitted by a peer connection.
 */
export interface PeerConnectionEvents {
  'connected': (result: ConnectResponseResult) => void
  'disconnected': (reason?: string) => void
  'message': (message: Message) => void
  'event': (event: Event) => void
  'agent:discovered': (agent: Agent) => void
  'agent:removed': (agentId: AgentId) => void
  'error': (error: Error) => void
  'reconnecting': (attempt: number) => void
  'reconnected': () => void
}

/**
 * Peer Connection - manages communication with a remote mesh peer.
 */
export class PeerConnection extends EventEmitter {
  readonly localPeerId: string
  readonly remotePeerId: string
  readonly remoteEndpoint: PeerEndpoint

  private readonly transport: TransportAdapter
  private readonly config: MapPeerConnectionConfig
  private connection: BaseConnection | null = null
  private stream: TunnelStream | null = null
  private _state: MapConnectionState = 'disconnected'
  private remoteAgents = new Map<AgentId, Agent>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sessionId: string | null = null

  constructor(config: MapPeerConnectionConfig) {
    super()
    this.localPeerId = config.localPeerId
    this.remotePeerId = config.remotePeerId
    this.remoteEndpoint = config.remoteEndpoint
    this.transport = config.transport
    this.config = config
  }

  /**
   * Current connection state.
   */
  get state(): MapConnectionState {
    return this._state
  }

  /**
   * Whether connected to the remote peer.
   */
  get isConnected(): boolean {
    return this._state === 'connected'
  }

  /**
   * Get all discovered remote agents.
   */
  get agents(): Agent[] {
    return Array.from(this.remoteAgents.values())
  }

  /**
   * Connect to the remote peer.
   */
  async connect(): Promise<ConnectResponseResult> {
    if (this._state === 'connected') {
      throw new Error('Already connected')
    }

    this._state = 'connecting'

    try {
      // Ensure transport connection
      if (!this.transport.isConnected(this.remotePeerId)) {
        await this.transport.connect(this.remoteEndpoint)
      }

      // Create stream
      this.stream = new TunnelStream({
        transport: this.transport,
        peerId: this.remotePeerId,
      })
      await this.stream.open()

      // Create base connection
      this.connection = new BaseConnection({
        stream: this.stream,
        requestTimeout: this.config.connectionTimeout,
        onNotification: (method, params) => this.handleNotification(method, params),
      })
      await this.connection.start()

      // Send connect request
      const result = await this.connection.request<ConnectResponseResult>(
        CORE_METHODS.CONNECT,
        {
          protocolVersion: PROTOCOL_VERSION,
          participantType: 'agent',
          participantId: this.localPeerId,
          name: `Peer ${this.localPeerId}`,
          sessionId: this.sessionId ?? undefined,
        }
      )

      this.sessionId = result.sessionId
      this._state = 'connected'
      this.reconnectAttempts = 0

      // Discover remote agents
      await this.discoverAgents()

      this.emit('connected', result)
      return result
    } catch (err) {
      this._state = 'error'
      this.emit('error', err as Error)

      // Attempt reconnection if enabled
      if (this.config.reconnection?.enabled) {
        this.scheduleReconnect()
      }

      throw err
    }
  }

  /**
   * Disconnect from the remote peer.
   */
  async disconnect(reason?: string): Promise<void> {
    if (this._state === 'disconnected') return

    this._state = 'disconnecting'
    this.cancelReconnect()

    try {
      if (this.connection?.isConnected) {
        await this.connection.request(CORE_METHODS.DISCONNECT, { reason })
      }
    } catch {
      // Ignore disconnect errors
    }

    await this.cleanup()
    this._state = 'disconnected'
    this.emit('disconnected', reason)
  }

  /**
   * Send a message to a remote agent.
   */
  async sendMessage(to: AgentId, payload: unknown, meta?: MessageMeta): Promise<void> {
    if (!this.connection?.isConnected) {
      throw new Error('Not connected to peer')
    }

    await this.connection.request(CORE_METHODS.SEND, {
      to: { agent: to },
      payload,
      meta,
    })
  }

  /**
   * Forward a message to remote agents.
   */
  async forwardMessage(agentIds: AgentId[], message: Message): Promise<boolean> {
    if (!this.connection?.isConnected) {
      return false
    }

    try {
      for (const agentId of agentIds) {
        await this.connection.request(CORE_METHODS.SEND, {
          to: { agent: agentId },
          payload: message.payload,
          meta: message.meta,
        })
      }
      return true
    } catch (err) {
      this.emit('error', err as Error)
      return false
    }
  }

  /**
   * Discover agents on the remote peer.
   */
  async discoverAgents(): Promise<Agent[]> {
    if (!this.connection?.isConnected) {
      return []
    }

    try {
      const result = await this.connection.request<AgentsListResponseResult>(
        'map/agents/list',
        {}
      )

      // Update local cache
      this.remoteAgents.clear()
      for (const agent of result.agents) {
        this.remoteAgents.set(agent.id, agent)
        this.emit('agent:discovered', agent)
      }

      return result.agents
    } catch (err) {
      this.emit('error', err as Error)
      return []
    }
  }

  /**
   * Get a remote agent by ID.
   */
  getAgent(agentId: AgentId): Agent | undefined {
    return this.remoteAgents.get(agentId)
  }

  /**
   * Check if a remote agent exists.
   */
  hasAgent(agentId: AgentId): boolean {
    return this.remoteAgents.has(agentId)
  }

  /**
   * Handle incoming notifications from the remote peer.
   */
  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case NOTIFICATION_METHODS.MESSAGE: {
        const { message } = params as { message: Message }
        this.emit('message', message)
        break
      }

      case NOTIFICATION_METHODS.EVENT: {
        const { event } = params as { event: Event }
        this.handleEvent(event)
        break
      }
    }
  }

  /**
   * Handle an event from the remote peer.
   */
  private handleEvent(event: Event): void {
    this.emit('event', event)

    // Update local agent cache based on events
    const data = event.data as Record<string, unknown> | undefined
    if (!data) return

    switch (event.type) {
      case 'agent_registered': {
        const agent = data.agent as Agent
        if (agent) {
          this.remoteAgents.set(agent.id, agent)
          this.emit('agent:discovered', agent)
        }
        break
      }

      case 'agent_unregistered': {
        const agent = data.agent as Agent
        if (agent) {
          this.remoteAgents.delete(agent.id)
          this.emit('agent:removed', agent.id)
        }
        break
      }

      case 'agent_state_changed': {
        const agent = data.agent as Agent
        if (agent) {
          this.remoteAgents.set(agent.id, agent)
        }
        break
      }
    }
  }

  /**
   * Clean up resources.
   */
  private async cleanup(): Promise<void> {
    if (this.connection) {
      await this.connection.stop()
      this.connection = null
    }

    if (this.stream) {
      await this.stream.close()
      this.stream = null
    }

    this.remoteAgents.clear()
  }

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    const reconnection = this.config.reconnection
    if (!reconnection?.enabled) return

    const maxRetries = reconnection.maxRetries ?? Infinity
    if (this.reconnectAttempts >= maxRetries) {
      this.emit('error', new Error('Max reconnection attempts reached'))
      return
    }

    const initialDelay = reconnection.initialDelayMs ?? 1000
    const maxDelay = reconnection.maxDelayMs ?? 30000
    const multiplier = reconnection.backoffMultiplier ?? 2

    const delay = Math.min(initialDelay * Math.pow(multiplier, this.reconnectAttempts), maxDelay)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attemptReconnect()
    }, delay)
  }

  /**
   * Attempt reconnection.
   */
  private async attemptReconnect(): Promise<void> {
    this.reconnectAttempts++
    this.emit('reconnecting', this.reconnectAttempts)

    try {
      await this.connect()
      this.emit('reconnected')
    } catch {
      // connect() already schedules next reconnect on failure
    }
  }

  /**
   * Cancel scheduled reconnection.
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

/**
 * Create a peer connection.
 */
export function createPeerConnection(config: MapPeerConnectionConfig): PeerConnection {
  return new PeerConnection(config)
}
