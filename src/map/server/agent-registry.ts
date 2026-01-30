/**
 * Agent Registry
 *
 * Manages the lifecycle and state of agents within the MAP server.
 */

import { EventEmitter } from 'events'
import type {
  Agent,
  AgentId,
  ParticipantId,
  AgentState,
  AgentVisibility,
  ScopeId,
  ParticipantCapabilities,
  AgentRelationship,
  AgentLifecycle,
  AgentPermissions,
} from '../types'
import type { AgentFilter } from '../types'

/**
 * Parameters for registering an agent.
 */
export interface AgentRegisterParams {
  agentId?: AgentId
  ownerId: ParticipantId
  name?: string
  description?: string
  role?: string
  parent?: AgentId
  scopes?: ScopeId[]
  visibility?: AgentVisibility
  capabilities?: ParticipantCapabilities
  metadata?: Record<string, unknown>
  permissionOverrides?: Partial<AgentPermissions>
}

/**
 * Parameters for updating an agent.
 */
export interface AgentUpdateParams {
  state?: AgentState
  metadata?: Record<string, unknown>
  permissionOverrides?: Partial<AgentPermissions>
}

/**
 * Events emitted by the agent registry.
 */
export interface AgentRegistryEvents {
  'agent:registered': (agent: Agent) => void
  'agent:unregistered': (agent: Agent) => void
  'agent:state:changed': (agent: Agent, previousState: AgentState) => void
  'agent:orphaned': (agent: Agent) => void
}

/**
 * Agent Registry - manages agent lifecycle.
 */
export class AgentRegistry extends EventEmitter {
  private readonly agents = new Map<AgentId, Agent>()
  private readonly agentsByOwner = new Map<ParticipantId, Set<AgentId>>()
  private readonly agentsByScope = new Map<ScopeId, Set<AgentId>>()
  private readonly agentsByRole = new Map<string, Set<AgentId>>()

  /**
   * Generate a unique agent ID.
   */
  private generateAgentId(): AgentId {
    return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Register a new agent.
   */
  register(params: AgentRegisterParams): Agent {
    const agentId = params.agentId ?? this.generateAgentId()

    if (this.agents.has(agentId)) {
      throw new Error(`Agent already exists: ${agentId}`)
    }

    // Validate parent exists if specified
    if (params.parent && !this.agents.has(params.parent)) {
      throw new Error(`Parent agent not found: ${params.parent}`)
    }

    const now = Date.now()
    const agent: Agent = {
      id: agentId,
      ownerId: params.ownerId,
      name: params.name,
      description: params.description,
      state: 'registered',
      role: params.role,
      parent: params.parent,
      scopes: params.scopes ?? [],
      visibility: params.visibility ?? 'public',
      capabilities: params.capabilities,
      metadata: params.metadata,
      permissionOverrides: params.permissionOverrides,
      lifecycle: {
        createdAt: now,
      },
    }

    // Store agent
    this.agents.set(agentId, agent)

    // Index by owner
    if (!this.agentsByOwner.has(params.ownerId)) {
      this.agentsByOwner.set(params.ownerId, new Set())
    }
    this.agentsByOwner.get(params.ownerId)!.add(agentId)

    // Index by scopes
    for (const scopeId of agent.scopes ?? []) {
      if (!this.agentsByScope.has(scopeId)) {
        this.agentsByScope.set(scopeId, new Set())
      }
      this.agentsByScope.get(scopeId)!.add(agentId)
    }

    // Index by role
    if (agent.role) {
      if (!this.agentsByRole.has(agent.role)) {
        this.agentsByRole.set(agent.role, new Set())
      }
      this.agentsByRole.get(agent.role)!.add(agentId)
    }

    this.emit('agent:registered', agent)
    return agent
  }

  /**
   * Unregister an agent.
   */
  unregister(agentId: AgentId, reason?: string): Agent {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Update lifecycle
    agent.state = 'stopped'
    agent.lifecycle = {
      ...agent.lifecycle,
      stoppedAt: Date.now(),
      exitReason: reason,
    }

    // Remove from indexes
    if (agent.ownerId) {
      this.agentsByOwner.get(agent.ownerId)?.delete(agentId)
    }
    for (const scopeId of agent.scopes ?? []) {
      this.agentsByScope.get(scopeId)?.delete(agentId)
    }
    if (agent.role) {
      this.agentsByRole.get(agent.role)?.delete(agentId)
    }

    this.agents.delete(agentId)
    this.emit('agent:unregistered', agent)
    return agent
  }

  /**
   * Get an agent by ID.
   */
  get(agentId: AgentId): Agent | undefined {
    return this.agents.get(agentId)
  }

  /**
   * Check if an agent exists.
   */
  has(agentId: AgentId): boolean {
    return this.agents.has(agentId)
  }

  /**
   * Update an agent.
   */
  update(agentId: AgentId, params: AgentUpdateParams): Agent {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const previousState = agent.state

    if (params.state !== undefined) {
      agent.state = params.state
      agent.lifecycle = {
        ...agent.lifecycle,
        lastActiveAt: Date.now(),
      }

      if (params.state === 'active' && !agent.lifecycle?.startedAt) {
        agent.lifecycle.startedAt = Date.now()
      }
    }

    if (params.metadata !== undefined) {
      agent.metadata = { ...agent.metadata, ...params.metadata }
    }

    if (params.permissionOverrides !== undefined) {
      agent.permissionOverrides = { ...agent.permissionOverrides, ...params.permissionOverrides }
    }

    if (params.state !== undefined && params.state !== previousState) {
      this.emit('agent:state:changed', agent, previousState)
    }

    return agent
  }

  /**
   * List agents with optional filtering.
   */
  list(filter?: AgentFilter): Agent[] {
    let agents = Array.from(this.agents.values())

    if (!filter) return agents

    if (filter.states && filter.states.length > 0) {
      agents = agents.filter((a) => filter.states!.includes(a.state))
    }

    if (filter.roles && filter.roles.length > 0) {
      agents = agents.filter((a) => a.role && filter.roles!.includes(a.role))
    }

    if (filter.scopes && filter.scopes.length > 0) {
      agents = agents.filter((a) =>
        a.scopes?.some((s) => filter.scopes!.includes(s))
      )
    }

    if (filter.parent !== undefined) {
      agents = agents.filter((a) => a.parent === filter.parent)
    }

    if (filter.hasChildren !== undefined) {
      const parentsWithChildren = new Set<AgentId>()
      for (const a of this.agents.values()) {
        if (a.parent) parentsWithChildren.add(a.parent)
      }
      agents = agents.filter((a) =>
        filter.hasChildren ? parentsWithChildren.has(a.id) : !parentsWithChildren.has(a.id)
      )
    }

    if (filter.ownerId !== undefined) {
      agents = agents.filter((a) => a.ownerId === filter.ownerId)
    }

    return agents
  }

  /**
   * Get agents by owner.
   */
  getByOwner(ownerId: ParticipantId): Agent[] {
    const agentIds = this.agentsByOwner.get(ownerId)
    if (!agentIds) return []
    return Array.from(agentIds)
      .map((id) => this.agents.get(id))
      .filter((a): a is Agent => a !== undefined)
  }

  /**
   * Get agents by scope.
   */
  getByScope(scopeId: ScopeId): Agent[] {
    const agentIds = this.agentsByScope.get(scopeId)
    if (!agentIds) return []
    return Array.from(agentIds)
      .map((id) => this.agents.get(id))
      .filter((a): a is Agent => a !== undefined)
  }

  /**
   * Get agents by role.
   */
  getByRole(role: string): Agent[] {
    const agentIds = this.agentsByRole.get(role)
    if (!agentIds) return []
    return Array.from(agentIds)
      .map((id) => this.agents.get(id))
      .filter((a): a is Agent => a !== undefined)
  }

  /**
   * Get children of an agent.
   */
  getChildren(agentId: AgentId): Agent[] {
    return Array.from(this.agents.values()).filter((a) => a.parent === agentId)
  }

  /**
   * Get the parent of an agent.
   */
  getParent(agentId: AgentId): Agent | undefined {
    const agent = this.agents.get(agentId)
    if (!agent?.parent) return undefined
    return this.agents.get(agent.parent)
  }

  /**
   * Get ancestors of an agent (parent, grandparent, etc.).
   */
  getAncestors(agentId: AgentId, maxDepth?: number): Agent[] {
    const ancestors: Agent[] = []
    let current = this.getParent(agentId)
    let depth = 0

    while (current && (maxDepth === undefined || depth < maxDepth)) {
      ancestors.push(current)
      current = this.getParent(current.id)
      depth++
    }

    return ancestors
  }

  /**
   * Get descendants of an agent (children, grandchildren, etc.).
   */
  getDescendants(agentId: AgentId, maxDepth?: number): Agent[] {
    const descendants: Agent[] = []
    const queue: Array<{ agent: Agent; depth: number }> = this.getChildren(agentId).map((a) => ({
      agent: a,
      depth: 1,
    }))

    while (queue.length > 0) {
      const { agent, depth } = queue.shift()!
      if (maxDepth !== undefined && depth > maxDepth) continue

      descendants.push(agent)

      const children = this.getChildren(agent.id)
      for (const child of children) {
        queue.push({ agent: child, depth: depth + 1 })
      }
    }

    return descendants
  }

  /**
   * Get siblings of an agent (same parent).
   */
  getSiblings(agentId: AgentId): Agent[] {
    const agent = this.agents.get(agentId)
    if (!agent) return []

    return Array.from(this.agents.values()).filter(
      (a) => a.id !== agentId && a.parent === agent.parent
    )
  }

  /**
   * Add agent to a scope.
   */
  addToScope(agentId: AgentId, scopeId: ScopeId): void {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!agent.scopes) {
      agent.scopes = []
    }

    if (!agent.scopes.includes(scopeId)) {
      agent.scopes.push(scopeId)

      if (!this.agentsByScope.has(scopeId)) {
        this.agentsByScope.set(scopeId, new Set())
      }
      this.agentsByScope.get(scopeId)!.add(agentId)
    }
  }

  /**
   * Remove agent from a scope.
   */
  removeFromScope(agentId: AgentId, scopeId: ScopeId): void {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (agent.scopes) {
      agent.scopes = agent.scopes.filter((s) => s !== scopeId)
    }

    this.agentsByScope.get(scopeId)?.delete(agentId)
  }

  /**
   * Orphan agents owned by a participant (set ownerId to null).
   */
  orphanByOwner(ownerId: ParticipantId): Agent[] {
    const agents = this.getByOwner(ownerId)
    const now = Date.now()

    for (const agent of agents) {
      agent.ownerId = null
      agent.state = 'orphaned'
      agent.lifecycle = {
        ...agent.lifecycle,
        orphanedAt: now,
      }
      this.emit('agent:orphaned', agent)
    }

    this.agentsByOwner.delete(ownerId)
    return agents
  }

  /**
   * Reclaim orphaned agents.
   */
  reclaimAgents(ownerId: ParticipantId, agentIds: AgentId[]): Agent[] {
    const reclaimed: Agent[] = []

    for (const agentId of agentIds) {
      const agent = this.agents.get(agentId)
      if (!agent) continue
      if (agent.ownerId !== null) continue // Not orphaned

      agent.ownerId = ownerId
      agent.state = 'registered'
      reclaimed.push(agent)

      if (!this.agentsByOwner.has(ownerId)) {
        this.agentsByOwner.set(ownerId, new Set())
      }
      this.agentsByOwner.get(ownerId)!.add(agentId)
    }

    return reclaimed
  }

  /**
   * Get total agent count.
   */
  get size(): number {
    return this.agents.size
  }

  /**
   * Clear all agents.
   */
  clear(): void {
    this.agents.clear()
    this.agentsByOwner.clear()
    this.agentsByScope.clear()
    this.agentsByRole.clear()
  }
}
