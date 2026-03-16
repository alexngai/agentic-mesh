/**
 * MAP Server
 *
 * The main MAP protocol server that orchestrates agent registry,
 * scope management, event distribution, and message routing.
 */

import { EventEmitter } from 'events'
import type {
  Agent,
  AgentId,
  ParticipantId,
  ScopeId,
  Scope,
  Address,
  Message,
  MessageMeta,
  Event,
  SubscriptionFilter,
  SubscriptionOptions,
  ParticipantCapabilities,
  AgentState,
  MapServerConfig,
  SendResult,
  EventSubscription,
} from '../types'
import {
  EVENT_TYPES,
  PROTOCOL_VERSION,
} from '../types'
import { AgentRegistry, type AgentRegisterParams, type AgentUpdateParams } from './agent-registry'
import { ScopeManager, type ScopeCreateParams } from './scope-manager'
import { EventBus } from './event-bus'
import { MessageRouter, type DeliveryHandler } from './message-router'

/**
 * Events emitted by the MAP server.
 */
export interface MapServerEvents {
  'started': () => void
  'stopped': () => void
  'agent:registered': (agent: Agent) => void
  'agent:unregistered': (agent: Agent) => void
  'agent:state:changed': (agent: Agent, previousState: AgentState) => void
  'scope:created': (scope: Scope) => void
  'scope:deleted': (scope: Scope) => void
  'message:sent': (messageId: string, from: ParticipantId, to: Address) => void
  'event': (event: Event) => void
  'error': (error: Error) => void
}

/**
 * Message handler for incoming messages to agents.
 */
export type MessageHandler = (agentId: AgentId, message: Message) => Promise<void> | void

/**
 * MAP Server - the core protocol server.
 */
export class MapServer extends EventEmitter {
  readonly systemId: string
  readonly systemName?: string
  readonly systemVersion?: string

  private readonly agentRegistry: AgentRegistry
  private readonly scopeManager: ScopeManager
  private readonly eventBus: EventBus
  private readonly messageRouter: MessageRouter
  private readonly messageHandlers = new Map<AgentId, MessageHandler>()
  private readonly config: MapServerConfig
  private running = false

  constructor(config: MapServerConfig) {
    super()
    this.config = config
    this.systemId = config.systemId
    this.systemName = config.systemName
    this.systemVersion = config.systemVersion

    // Initialize components
    this.agentRegistry = new AgentRegistry()
    this.scopeManager = new ScopeManager()
    this.eventBus = new EventBus({
      maxHistorySize: config.maxRetainedEvents,
      retentionMs: config.eventRetentionMs,
    })

    // Create delivery handler
    const deliveryHandler: DeliveryHandler = {
      deliverToAgent: (agentId, message) => this.deliverToAgent(agentId, message),
      forwardToPeer: (peerId, agentIds, message) => this.forwardToPeer(peerId, agentIds, message),
      routeToFederation: config.federation?.enabled
        ? (systemId, agentIds, message) => this.routeToFederation(systemId, agentIds, message)
        : undefined,
    }

    this.messageRouter = new MessageRouter({
      systemId: config.systemId,
      agentRegistry: this.agentRegistry,
      scopeManager: this.scopeManager,
      eventBus: this.eventBus,
      deliveryHandler,
    })

    this.setupEventForwarding()
  }

  /**
   * Forward internal events to external listeners.
   */
  private setupEventForwarding(): void {
    this.agentRegistry.on('agent:registered', (agent) => {
      this.eventBus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agent }, agent.ownerId ?? undefined)
      this.emit('agent:registered', agent)
    })

    this.agentRegistry.on('agent:unregistered', (agent) => {
      this.eventBus.emitEvent(EVENT_TYPES.AGENT_UNREGISTERED, { agent }, agent.ownerId ?? undefined)
      this.emit('agent:unregistered', agent)
    })

    this.agentRegistry.on('agent:state:changed', (agent, previousState) => {
      this.eventBus.emitEvent(EVENT_TYPES.AGENT_STATE_CHANGED, {
        agent,
        previousState,
        newState: agent.state,
      }, agent.ownerId ?? undefined)
      this.emit('agent:state:changed', agent, previousState)
    })

    this.agentRegistry.on('agent:orphaned', (agent) => {
      this.eventBus.emitEvent(EVENT_TYPES.AGENT_ORPHANED, { agent })
    })

    this.scopeManager.on('scope:created', (scope) => {
      this.eventBus.emitEvent(EVENT_TYPES.SCOPE_CREATED, { scope })
      this.emit('scope:created', scope)
    })

    this.scopeManager.on('scope:deleted', (scope) => {
      this.eventBus.emitEvent(EVENT_TYPES.SCOPE_DELETED, { scope })
      this.emit('scope:deleted', scope)
    })

    this.scopeManager.on('scope:member:joined', (scopeId, agentId) => {
      this.eventBus.emitEvent(EVENT_TYPES.SCOPE_MEMBER_JOINED, { scopeId, agentId })
    })

    this.scopeManager.on('scope:member:left', (scopeId, agentId) => {
      this.eventBus.emitEvent(EVENT_TYPES.SCOPE_MEMBER_LEFT, { scopeId, agentId })
    })

    this.eventBus.on('event', (event) => {
      this.emit('event', event)
    })
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the server.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.emit('started')
  }

  /**
   * Stop the server.
   */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false

    // Clean up
    this.agentRegistry.clear()
    this.scopeManager.clear()
    this.eventBus.clear()
    this.messageHandlers.clear()

    this.emit('stopped')
  }

  /**
   * Whether the server is running.
   */
  get isRunning(): boolean {
    return this.running
  }

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  /**
   * Register an agent.
   */
  registerAgent(params: AgentRegisterParams): Agent {
    const agent = this.agentRegistry.register(params)

    // Join initial scopes
    if (params.scopes) {
      for (const scopeId of params.scopes) {
        // Create scope if it doesn't exist
        if (!this.scopeManager.has(scopeId)) {
          this.scopeManager.create({ scopeId })
        }
        this.scopeManager.join(scopeId, agent.id)
      }
    }

    return agent
  }

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: AgentId, reason?: string): Agent {
    // Remove from all scopes
    this.scopeManager.removeAgentFromAllScopes(agentId)

    // Remove message handler
    this.messageHandlers.delete(agentId)

    return this.agentRegistry.unregister(agentId, reason)
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: AgentId): Agent | undefined {
    return this.agentRegistry.get(agentId)
  }

  /**
   * List agents with optional filtering.
   */
  listAgents(filter?: import('../types').AgentFilter): Agent[] {
    return this.agentRegistry.list(filter)
  }

  /**
   * Update an agent.
   */
  updateAgent(agentId: AgentId, params: AgentUpdateParams): Agent {
    return this.agentRegistry.update(agentId, params)
  }

  /**
   * Get agent hierarchy.
   */
  getAgentHierarchy(agentId: AgentId, options?: {
    includeParent?: boolean
    includeChildren?: boolean
    includeSiblings?: boolean
    includeAncestors?: boolean
    includeDescendants?: boolean
    maxDepth?: number
  }): {
    agent: Agent
    parent?: Agent
    children?: Agent[]
    siblings?: Agent[]
    ancestors?: Agent[]
    descendants?: Agent[]
  } {
    const agent = this.agentRegistry.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const result: ReturnType<MapServer['getAgentHierarchy']> = { agent }

    if (options?.includeParent) {
      result.parent = this.agentRegistry.getParent(agentId)
    }

    if (options?.includeChildren) {
      result.children = this.agentRegistry.getChildren(agentId)
    }

    if (options?.includeSiblings) {
      result.siblings = this.agentRegistry.getSiblings(agentId)
    }

    if (options?.includeAncestors) {
      result.ancestors = this.agentRegistry.getAncestors(agentId, options.maxDepth)
    }

    if (options?.includeDescendants) {
      result.descendants = this.agentRegistry.getDescendants(agentId, options.maxDepth)
    }

    return result
  }

  /**
   * Orphan all agents owned by a participant.
   */
  orphanAgentsByOwner(ownerId: ParticipantId): Agent[] {
    return this.agentRegistry.orphanByOwner(ownerId)
  }

  /**
   * Reclaim orphaned agents.
   */
  reclaimAgents(ownerId: ParticipantId, agentIds: AgentId[]): Agent[] {
    return this.agentRegistry.reclaimAgents(ownerId, agentIds)
  }

  // ==========================================================================
  // Scope Management
  // ==========================================================================

  /**
   * Create a scope.
   */
  createScope(params: ScopeCreateParams): Scope {
    return this.scopeManager.create(params)
  }

  /**
   * Delete a scope.
   */
  deleteScope(scopeId: ScopeId): Scope {
    return this.scopeManager.delete(scopeId)
  }

  /**
   * Get a scope.
   */
  getScope(scopeId: ScopeId): Scope | undefined {
    return this.scopeManager.get(scopeId)
  }

  /**
   * List scopes.
   */
  listScopes(filter?: import('../types').ScopeFilter): Scope[] {
    return this.scopeManager.list(filter)
  }

  /**
   * Join a scope.
   */
  joinScope(scopeId: ScopeId, agentId: AgentId): Scope {
    const scope = this.scopeManager.get(scopeId)
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`)
    }

    this.scopeManager.join(scopeId, agentId)
    this.agentRegistry.addToScope(agentId, scopeId)

    return scope
  }

  /**
   * Leave a scope.
   */
  leaveScope(scopeId: ScopeId, agentId: AgentId): Scope {
    const scope = this.scopeManager.get(scopeId)
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`)
    }

    this.scopeManager.leave(scopeId, agentId)
    this.agentRegistry.removeFromScope(agentId, scopeId)

    return scope
  }

  /**
   * Get scope members.
   */
  getScopeMembers(scopeId: ScopeId): AgentId[] {
    return this.scopeManager.getMembers(scopeId)
  }

  // ==========================================================================
  // Messaging
  // ==========================================================================

  /**
   * Send a message.
   */
  async send(
    from: ParticipantId,
    to: Address,
    payload: unknown,
    meta?: MessageMeta
  ): Promise<SendResult> {
    const result = await this.messageRouter.send(from, to, payload, meta)
    this.emit('message:sent', result.messageId, from, to)
    return result
  }

  /**
   * Register a message handler for an agent.
   */
  setMessageHandler(agentId: AgentId, handler: MessageHandler): void {
    this.messageHandlers.set(agentId, handler)
  }

  /**
   * Remove a message handler for an agent.
   */
  removeMessageHandler(agentId: AgentId): void {
    this.messageHandlers.delete(agentId)
  }

  /**
   * Replace the default delivery handler with a custom implementation.
   *
   * The custom handler receives all messages after address resolution
   * and is responsible for final delivery. This allows external systems
   * (e.g. agent-inbox) to intercept message delivery for custom storage,
   * threading, read tracking, and other message processing.
   *
   * Returns the previous handler so it can be used as a fallback
   * for operations the custom handler doesn't want to override.
   *
   * @param handler - Custom delivery handler
   * @returns The previous delivery handler
   *
   * @example
   * ```typescript
   * const previous = server.setDeliveryHandler({
   *   async deliverToAgent(agentId, message) {
   *     // Custom delivery logic (e.g. store in inbox)
   *     storage.putMessage(message);
   *     return true;
   *   },
   *   async forwardToPeer(peerId, agentIds, message) {
   *     // Delegate to default handler
   *     return previous.forwardToPeer(peerId, agentIds, message);
   *   },
   *   async routeToFederation(systemId, agentIds, message) {
   *     return previous.routeToFederation?.(systemId, agentIds, message) ?? false;
   *   },
   * });
   * ```
   */
  setDeliveryHandler(handler: DeliveryHandler): DeliveryHandler {
    return this.messageRouter.setDeliveryHandler(handler)
  }

  /**
   * Deliver a message to a local agent.
   */
  private async deliverToAgent(agentId: AgentId, message: Message): Promise<boolean> {
    const handler = this.messageHandlers.get(agentId)
    if (!handler) {
      // No handler registered - agent may not be listening
      return false
    }

    try {
      await handler(agentId, message)
      return true
    } catch (err) {
      this.emit('error', err as Error)
      return false
    }
  }

  /**
   * Forward a message to a remote peer.
   * This should be overridden by subclasses that support peer connections.
   */
  protected async forwardToPeer(
    peerId: string,
    agentIds: AgentId[],
    message: Message
  ): Promise<boolean> {
    // Default implementation - subclasses should override
    return false
  }

  /**
   * Route a message to a federated system.
   * This should be overridden by subclasses that support federation.
   */
  protected async routeToFederation(
    systemId: string,
    agentIds: AgentId[],
    message: Message
  ): Promise<boolean> {
    // Default implementation - subclasses should override
    return false
  }

  // ==========================================================================
  // Subscriptions & Events
  // ==========================================================================

  /**
   * Subscribe to events.
   */
  subscribe(
    participantId: ParticipantId,
    filter?: SubscriptionFilter,
    options?: SubscriptionOptions
  ): EventSubscription {
    return this.eventBus.subscribe({ participantId, filter, options })
  }

  /**
   * Unsubscribe.
   */
  unsubscribe(subscriptionId: string): void {
    this.eventBus.unsubscribe(subscriptionId)
  }

  /**
   * Unsubscribe all subscriptions for a participant.
   */
  unsubscribeAll(participantId: ParticipantId): void {
    this.eventBus.unsubscribeAll(participantId)
  }

  /**
   * Publish a custom event.
   */
  publishEvent(event: Event): void {
    this.eventBus.publish(event)
  }

  /**
   * Replay events from history.
   */
  replay(params: {
    afterEventId?: string
    fromTimestamp?: number
    toTimestamp?: number
    filter?: SubscriptionFilter
    limit?: number
  }): { events: Event[]; hasMore: boolean } {
    return this.eventBus.replay(params)
  }

  // ==========================================================================
  // Remote Agent Management
  // ==========================================================================

  /**
   * Register a remote agent's location.
   */
  registerRemoteAgent(agentId: AgentId, peerId: string): void {
    this.messageRouter.registerRemoteAgent(agentId, peerId)
  }

  /**
   * Unregister a remote agent.
   */
  unregisterRemoteAgent(agentId: AgentId): void {
    this.messageRouter.unregisterRemoteAgent(agentId)
  }

  /**
   * Unregister all agents on a peer.
   */
  unregisterPeerAgents(peerId: string): void {
    this.messageRouter.unregisterPeerAgents(peerId)
  }

  // ==========================================================================
  // System Info
  // ==========================================================================

  /**
   * Get system information.
   */
  getSystemInfo(): {
    systemId: string
    systemName?: string
    systemVersion?: string
    protocolVersion: number
    agentCount: number
    scopeCount: number
    subscriptionCount: number
  } {
    return {
      systemId: this.systemId,
      systemName: this.systemName,
      systemVersion: this.systemVersion,
      protocolVersion: PROTOCOL_VERSION,
      agentCount: this.agentRegistry.size,
      scopeCount: this.scopeManager.size,
      subscriptionCount: this.eventBus.subscriptionCount,
    }
  }
}
