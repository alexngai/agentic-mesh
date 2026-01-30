/**
 * Base Agent
 *
 * Abstract base class for built-in MAP agents.
 */

import { EventEmitter } from 'events'
import type {
  Agent,
  AgentId,
  AgentState,
  ScopeId,
  Message,
  Address,
  MessageMeta,
  SendResult,
} from '../types'
import type { AgentConnection } from '../connection/agent'

/**
 * Configuration for a base agent.
 */
export interface BaseAgentConfig {
  /** Agent name */
  name: string

  /** Agent role */
  role?: string

  /** Agent description */
  description?: string

  /** Initial scopes to join */
  scopes?: ScopeId[]

  /** Custom metadata */
  metadata?: Record<string, unknown>
}

/**
 * Base Agent - foundation for built-in agents.
 */
export abstract class BaseAgent extends EventEmitter {
  protected connection: AgentConnection
  protected readonly config: BaseAgentConfig
  protected running = false

  constructor(connection: AgentConnection, config: BaseAgentConfig) {
    super()
    this.connection = connection
    this.config = config
  }

  /**
   * Agent ID.
   */
  get agentId(): AgentId {
    return this.connection.agentId
  }

  /**
   * Current agent state.
   */
  get state(): AgentState | undefined {
    return this.connection.state
  }

  /**
   * Whether the agent is running.
   */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * Start the agent.
   */
  async start(): Promise<void> {
    if (this.running) return

    // Register if not already registered
    if (!this.connection.isRegistered) {
      await this.connection.register()
    }

    // Set up message handler
    this.connection.on('message', (message) => {
      this.handleMessage(message).catch((err) => {
        this.emit('error', err)
      })
    })

    // Update state to active
    await this.connection.updateState('active')

    this.running = true
    await this.onStart()
    this.emit('started')
  }

  /**
   * Stop the agent.
   */
  async stop(): Promise<void> {
    if (!this.running) return

    await this.onStop()

    // Update state to stopped
    await this.connection.updateState('stopped')

    // Unregister
    await this.connection.unregister('agent stopped')

    this.running = false
    this.emit('stopped')
  }

  /**
   * Send a message.
   */
  protected async send(to: Address, payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    return this.connection.send(to, payload, meta)
  }

  /**
   * Send to parent agent.
   */
  protected async sendToParent(payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    return this.connection.sendToParent(payload, meta)
  }

  /**
   * Send to child agents.
   */
  protected async sendToChildren(payload: unknown, meta?: MessageMeta): Promise<SendResult> {
    return this.connection.sendToChildren(payload, meta)
  }

  /**
   * Broadcast to a scope.
   */
  protected async broadcastToScope(
    scopeId: ScopeId,
    payload: unknown,
    meta?: MessageMeta
  ): Promise<SendResult> {
    return this.connection.broadcastToScope(scopeId, payload, meta)
  }

  /**
   * Join a scope.
   */
  protected async joinScope(scopeId: ScopeId): Promise<void> {
    await this.connection.joinScope(scopeId)
  }

  /**
   * Leave a scope.
   */
  protected async leaveScope(scopeId: ScopeId): Promise<void> {
    await this.connection.leaveScope(scopeId)
  }

  /**
   * Update metadata.
   */
  protected async updateMetadata(metadata: Record<string, unknown>): Promise<void> {
    await this.connection.updateMetadata(metadata)
  }

  /**
   * Called when the agent starts. Override in subclasses.
   */
  protected async onStart(): Promise<void> {
    // Override in subclasses
  }

  /**
   * Called when the agent stops. Override in subclasses.
   */
  protected async onStop(): Promise<void> {
    // Override in subclasses
  }

  /**
   * Handle an incoming message. Override in subclasses.
   */
  protected abstract handleMessage(message: Message): Promise<void>
}
