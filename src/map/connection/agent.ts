/**
 * Agent Connection
 *
 * Represents a local agent's connection to the MAP server.
 */

import { EventEmitter } from 'events'
import type {
  Agent,
  AgentId,
  AgentState,
  ScopeId,
  Scope,
  Message,
  Address,
  MessageMeta,
  ParticipantCapabilities,
  SubscriptionFilter,
  SubscriptionOptions,
  MapAgentConnectionConfig,
  SendResult,
  EventSubscription,
} from '../types'
import type { MapServer } from '../server/map-server'

/**
 * Events emitted by an agent connection.
 */
export interface AgentConnectionEvents {
  'registered': (agent: Agent) => void
  'unregistered': (agent: Agent) => void
  'state:changed': (state: AgentState, previousState: AgentState) => void
  'message': (message: Message) => void
  'scope:joined': (scope: Scope) => void
  'scope:left': (scope: Scope) => void
  'error': (error: Error) => void
}

/**
 * Agent Connection - manages a local agent's lifecycle and communication.
 */
export class AgentConnection extends EventEmitter {
  private readonly server: MapServer
  private readonly config: MapAgentConnectionConfig
  private _agent: Agent | null = null
  private _registered = false
  private subscription: EventSubscription | null = null

  constructor(server: MapServer, config: MapAgentConnectionConfig) {
    super()
    this.server = server
    this.config = config
  }

  /**
   * The agent instance (null if not registered).
   */
  get agent(): Agent | null {
    return this._agent
  }

  /**
   * Agent ID (throws if not registered).
   */
  get agentId(): AgentId {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }
    return this._agent.id
  }

  /**
   * Whether the agent is registered.
   */
  get isRegistered(): boolean {
    return this._registered
  }

  /**
   * Current agent state.
   */
  get state(): AgentState | undefined {
    return this._agent?.state
  }

  /**
   * Register the agent with the MAP server.
   */
  async register(): Promise<Agent> {
    if (this._registered) {
      throw new Error('Agent already registered')
    }

    // Register with the server
    this._agent = this.server.registerAgent({
      agentId: this.config.agentId,
      ownerId: this.config.agentId ?? `agent-${Date.now()}`, // Self-owned for local agents
      name: this.config.name,
      description: this.config.description,
      role: this.config.role,
      parent: this.config.parent,
      scopes: this.config.scopes,
      visibility: this.config.visibility,
      capabilities: this.config.capabilities,
      metadata: this.config.metadata,
    })

    this._registered = true

    // Set up message handler
    this.server.setMessageHandler(this._agent.id, (agentId, message) => {
      this.emit('message', message)
    })

    // Subscribe to events for this agent
    this.subscription = this.server.subscribe(this._agent.id, {
      agents: [this._agent.id],
    })

    // Forward relevant events
    this.forwardEvents()

    this.emit('registered', this._agent)
    return this._agent
  }

  /**
   * Unregister the agent.
   */
  async unregister(reason?: string): Promise<void> {
    if (!this._registered || !this._agent) {
      return
    }

    // Clean up subscription
    if (this.subscription) {
      this.subscription.unsubscribe()
      this.subscription = null
    }

    // Unregister from server
    const agent = this.server.unregisterAgent(this._agent.id, reason)

    this._registered = false
    this._agent = null

    this.emit('unregistered', agent)
  }

  /**
   * Update agent state.
   */
  async updateState(state: AgentState): Promise<Agent> {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    const previousState = this._agent.state
    this._agent = this.server.updateAgent(this._agent.id, { state })

    if (state !== previousState) {
      this.emit('state:changed', state, previousState)
    }

    return this._agent
  }

  /**
   * Update agent metadata.
   */
  async updateMetadata(metadata: Record<string, unknown>): Promise<Agent> {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    this._agent = this.server.updateAgent(this._agent.id, { metadata })
    return this._agent
  }

  /**
   * Send a message.
   */
  async send(to: Address, payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    return this.server.send(this._agent.id, to, payload, meta)
  }

  /**
   * Send a message to parent.
   */
  async sendToParent(payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    return this.send({ parent: true }, payload, meta)
  }

  /**
   * Send a message to children.
   */
  async sendToChildren(payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    return this.send({ children: true }, payload, meta)
  }

  /**
   * Broadcast to a scope.
   */
  async broadcastToScope(scopeId: ScopeId, payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    return this.send({ scope: scopeId }, payload, meta)
  }

  /**
   * Join a scope.
   */
  async joinScope(scopeId: ScopeId): Promise<Scope> {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    const scope = this.server.joinScope(scopeId, this._agent.id)

    // Update local agent reference
    this._agent = this.server.getAgent(this._agent.id) ?? this._agent

    this.emit('scope:joined', scope)
    return scope
  }

  /**
   * Leave a scope.
   */
  async leaveScope(scopeId: ScopeId): Promise<Scope> {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    const scope = this.server.leaveScope(scopeId, this._agent.id)

    // Update local agent reference
    this._agent = this.server.getAgent(this._agent.id) ?? this._agent

    this.emit('scope:left', scope)
    return scope
  }

  /**
   * Get scopes this agent belongs to.
   */
  getScopes(): ScopeId[] {
    return this._agent?.scopes ?? []
  }

  /**
   * Subscribe to events.
   */
  subscribe(filter?: SubscriptionFilter, options?: SubscriptionOptions): EventSubscription {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    return this.server.subscribe(this._agent.id, filter, options)
  }

  /**
   * Get agent hierarchy.
   */
  getHierarchy(options?: {
    includeParent?: boolean
    includeChildren?: boolean
    includeSiblings?: boolean
    includeAncestors?: boolean
    includeDescendants?: boolean
    maxDepth?: number
  }): ReturnType<MapServer['getAgentHierarchy']> {
    if (!this._agent) {
      throw new Error('Agent not registered')
    }

    return this.server.getAgentHierarchy(this._agent.id, options)
  }

  /**
   * Forward events from the subscription to this emitter.
   */
  private async forwardEvents(): Promise<void> {
    if (!this.subscription) return

    try {
      for await (const event of this.subscription.events()) {
        // Already forwarded via direct handlers
      }
    } catch (err) {
      if (this._registered) {
        this.emit('error', err as Error)
      }
    }
  }
}

/**
 * Create an agent connection.
 */
export function createAgentConnection(
  server: MapServer,
  config: MapAgentConnectionConfig
): AgentConnection {
  return new AgentConnection(server, config)
}
