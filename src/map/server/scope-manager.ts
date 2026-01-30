/**
 * Scope Manager
 *
 * Manages scopes for grouping agents in the MAP server.
 */

import { EventEmitter } from 'events'
import type {
  Scope,
  ScopeId,
  AgentId,
  JoinPolicy,
  ScopeVisibility,
  MessageVisibility,
  SendPolicy,
} from '../types'
import type { ScopeFilter } from '../types'

/**
 * Parameters for creating a scope.
 */
export interface ScopeCreateParams {
  scopeId?: ScopeId
  name?: string
  description?: string
  parent?: ScopeId
  joinPolicy?: JoinPolicy
  autoJoinRoles?: string[]
  visibility?: ScopeVisibility
  messageVisibility?: MessageVisibility
  sendPolicy?: SendPolicy
  persistent?: boolean
  autoDelete?: boolean
  metadata?: Record<string, unknown>
}

/**
 * Events emitted by the scope manager.
 */
export interface ScopeManagerEvents {
  'scope:created': (scope: Scope) => void
  'scope:deleted': (scope: Scope) => void
  'scope:member:joined': (scopeId: ScopeId, agentId: AgentId) => void
  'scope:member:left': (scopeId: ScopeId, agentId: AgentId) => void
}

/**
 * Scope Manager - manages scope lifecycle and membership.
 */
export class ScopeManager extends EventEmitter {
  private readonly scopes = new Map<ScopeId, Scope>()
  private readonly scopeMembers = new Map<ScopeId, Set<AgentId>>()
  private readonly agentScopes = new Map<AgentId, Set<ScopeId>>()

  /**
   * Generate a unique scope ID.
   */
  private generateScopeId(): ScopeId {
    return `scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Create a new scope.
   */
  create(params: ScopeCreateParams): Scope {
    const scopeId = params.scopeId ?? this.generateScopeId()

    if (this.scopes.has(scopeId)) {
      throw new Error(`Scope already exists: ${scopeId}`)
    }

    // Validate parent exists if specified
    if (params.parent && !this.scopes.has(params.parent)) {
      throw new Error(`Parent scope not found: ${params.parent}`)
    }

    const scope: Scope = {
      id: scopeId,
      name: params.name,
      description: params.description,
      parent: params.parent,
      joinPolicy: params.joinPolicy ?? 'open',
      autoJoinRoles: params.autoJoinRoles,
      visibility: params.visibility ?? 'public',
      messageVisibility: params.messageVisibility ?? 'members',
      sendPolicy: params.sendPolicy ?? 'members',
      persistent: params.persistent ?? false,
      autoDelete: params.autoDelete ?? true,
      metadata: params.metadata,
    }

    this.scopes.set(scopeId, scope)
    this.scopeMembers.set(scopeId, new Set())

    this.emit('scope:created', scope)
    return scope
  }

  /**
   * Delete a scope.
   */
  delete(scopeId: ScopeId): Scope {
    const scope = this.scopes.get(scopeId)
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`)
    }

    // Remove all members
    const members = this.scopeMembers.get(scopeId)
    if (members) {
      for (const agentId of members) {
        this.agentScopes.get(agentId)?.delete(scopeId)
      }
    }

    this.scopes.delete(scopeId)
    this.scopeMembers.delete(scopeId)

    this.emit('scope:deleted', scope)
    return scope
  }

  /**
   * Get a scope by ID.
   */
  get(scopeId: ScopeId): Scope | undefined {
    return this.scopes.get(scopeId)
  }

  /**
   * Check if a scope exists.
   */
  has(scopeId: ScopeId): boolean {
    return this.scopes.has(scopeId)
  }

  /**
   * List scopes with optional filtering.
   */
  list(filter?: ScopeFilter): Scope[] {
    let scopes = Array.from(this.scopes.values())

    if (!filter) return scopes

    if (filter.parent !== undefined) {
      scopes = scopes.filter((s) => s.parent === filter.parent)
    }

    if (filter.visibility !== undefined) {
      scopes = scopes.filter((s) => s.visibility === filter.visibility)
    }

    return scopes
  }

  /**
   * Add an agent to a scope.
   */
  join(scopeId: ScopeId, agentId: AgentId): void {
    const scope = this.scopes.get(scopeId)
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`)
    }

    const members = this.scopeMembers.get(scopeId)!
    if (members.has(agentId)) {
      return // Already a member
    }

    members.add(agentId)

    if (!this.agentScopes.has(agentId)) {
      this.agentScopes.set(agentId, new Set())
    }
    this.agentScopes.get(agentId)!.add(scopeId)

    this.emit('scope:member:joined', scopeId, agentId)
  }

  /**
   * Remove an agent from a scope.
   */
  leave(scopeId: ScopeId, agentId: AgentId): void {
    const scope = this.scopes.get(scopeId)
    if (!scope) {
      throw new Error(`Scope not found: ${scopeId}`)
    }

    const members = this.scopeMembers.get(scopeId)!
    if (!members.has(agentId)) {
      return // Not a member
    }

    members.delete(agentId)
    this.agentScopes.get(agentId)?.delete(scopeId)

    this.emit('scope:member:left', scopeId, agentId)

    // Auto-delete if enabled and empty
    if (scope.autoDelete && members.size === 0 && !scope.persistent) {
      this.delete(scopeId)
    }
  }

  /**
   * Get members of a scope.
   */
  getMembers(scopeId: ScopeId): AgentId[] {
    const members = this.scopeMembers.get(scopeId)
    return members ? Array.from(members) : []
  }

  /**
   * Get scopes an agent belongs to.
   */
  getAgentScopes(agentId: AgentId): ScopeId[] {
    const scopes = this.agentScopes.get(agentId)
    return scopes ? Array.from(scopes) : []
  }

  /**
   * Check if an agent is a member of a scope.
   */
  isMember(scopeId: ScopeId, agentId: AgentId): boolean {
    return this.scopeMembers.get(scopeId)?.has(agentId) ?? false
  }

  /**
   * Get member count for a scope.
   */
  getMemberCount(scopeId: ScopeId): number {
    return this.scopeMembers.get(scopeId)?.size ?? 0
  }

  /**
   * Remove agent from all scopes.
   */
  removeAgentFromAllScopes(agentId: AgentId): void {
    const scopes = this.agentScopes.get(agentId)
    if (!scopes) return

    for (const scopeId of scopes) {
      this.scopeMembers.get(scopeId)?.delete(agentId)
      this.emit('scope:member:left', scopeId, agentId)

      // Check auto-delete
      const scope = this.scopes.get(scopeId)
      const members = this.scopeMembers.get(scopeId)
      if (scope?.autoDelete && members?.size === 0 && !scope.persistent) {
        this.delete(scopeId)
      }
    }

    this.agentScopes.delete(agentId)
  }

  /**
   * Get or create a scope (useful for ad-hoc scopes).
   */
  getOrCreate(scopeId: ScopeId, params?: Omit<ScopeCreateParams, 'scopeId'>): Scope {
    let scope = this.scopes.get(scopeId)
    if (!scope) {
      scope = this.create({ ...params, scopeId })
    }
    return scope
  }

  /**
   * Get total scope count.
   */
  get size(): number {
    return this.scopes.size
  }

  /**
   * Clear all scopes.
   */
  clear(): void {
    this.scopes.clear()
    this.scopeMembers.clear()
    this.agentScopes.clear()
  }
}
