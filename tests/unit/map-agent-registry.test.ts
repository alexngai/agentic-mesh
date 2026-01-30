import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentRegistry } from '../../src/map/server/agent-registry'
import type { Agent, AgentState, AgentId } from '../../src/map/types'

describe('AgentRegistry', () => {
  let registry: AgentRegistry

  beforeEach(() => {
    registry = new AgentRegistry()
  })

  describe('Registration', () => {
    it('should register an agent with generated ID', () => {
      const agent = registry.register({
        ownerId: 'owner-1',
        name: 'Test Agent',
        role: 'worker',
      })

      expect(agent.id).toBeDefined()
      expect(agent.name).toBe('Test Agent')
      expect(agent.role).toBe('worker')
      expect(agent.state).toBe('registered')
      expect(agent.ownerId).toBe('owner-1')
    })

    it('should register an agent with provided ID', () => {
      const agent = registry.register({
        agentId: 'custom-id',
        ownerId: 'owner-1',
        name: 'Custom Agent',
      })

      expect(agent.id).toBe('custom-id')
    })

    it('should throw if agent ID already exists', () => {
      registry.register({
        agentId: 'duplicate-id',
        ownerId: 'owner-1',
      })

      expect(() => {
        registry.register({
          agentId: 'duplicate-id',
          ownerId: 'owner-2',
        })
      }).toThrow('Agent already exists')
    })

    it('should emit agent:registered event', () => {
      const handler = vi.fn()
      registry.on('agent:registered', handler)

      const agent = registry.register({
        ownerId: 'owner-1',
        name: 'Test',
      })

      expect(handler).toHaveBeenCalledWith(agent)
    })

    it('should set lifecycle timestamps', () => {
      const agent = registry.register({
        ownerId: 'owner-1',
      })

      expect(agent.lifecycle?.createdAt).toBeDefined()
      expect(agent.lifecycle?.createdAt).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('Unregistration', () => {
    it('should unregister an agent', () => {
      const agent = registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      const unregistered = registry.unregister('agent-1')

      expect(unregistered.id).toBe('agent-1')
      expect(unregistered.state).toBe('stopped')
      expect(registry.has('agent-1')).toBe(false)
    })

    it('should throw if agent not found', () => {
      expect(() => {
        registry.unregister('non-existent')
      }).toThrow('Agent not found')
    })

    it('should emit agent:unregistered event', () => {
      const handler = vi.fn()
      registry.on('agent:unregistered', handler)

      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      registry.unregister('agent-1')

      expect(handler).toHaveBeenCalled()
    })
  })

  describe('Update', () => {
    it('should update agent state', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      const updated = registry.update('agent-1', { state: 'active' })

      expect(updated.state).toBe('active')
    })

    it('should update agent metadata', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      const updated = registry.update('agent-1', {
        metadata: { key: 'value' },
      })

      expect(updated.metadata).toEqual({ key: 'value' })
    })

    it('should emit agent:state:changed event', () => {
      const handler = vi.fn()
      registry.on('agent:state:changed', handler)

      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      registry.update('agent-1', { state: 'busy' })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'busy' }),
        'registered'
      )
    })

    it('should not emit event if state unchanged', () => {
      const handler = vi.fn()
      registry.on('agent:state:changed', handler)

      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      handler.mockClear()
      registry.update('agent-1', { metadata: { foo: 'bar' } })

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('Hierarchy', () => {
    beforeEach(() => {
      // Create a hierarchy: parent -> [child1, child2]
      registry.register({
        agentId: 'parent',
        ownerId: 'owner-1',
        name: 'Parent',
      })
      registry.register({
        agentId: 'child1',
        ownerId: 'owner-1',
        parent: 'parent',
        name: 'Child 1',
      })
      registry.register({
        agentId: 'child2',
        ownerId: 'owner-1',
        parent: 'parent',
        name: 'Child 2',
      })
    })

    it('should get parent agent', () => {
      const parent = registry.getParent('child1')
      expect(parent?.id).toBe('parent')
    })

    it('should get children agents', () => {
      const children = registry.getChildren('parent')
      expect(children.map((c) => c.id).sort()).toEqual(['child1', 'child2'])
    })

    it('should get siblings', () => {
      const siblings = registry.getSiblings('child1')
      expect(siblings.map((s) => s.id)).toEqual(['child2'])
    })

    it('should return empty array for no parent', () => {
      const parent = registry.getParent('parent')
      expect(parent).toBeUndefined()
    })

    it('should get ancestors', () => {
      registry.register({
        agentId: 'grandchild',
        ownerId: 'owner-1',
        parent: 'child1',
      })

      const ancestors = registry.getAncestors('grandchild')
      expect(ancestors.map((a) => a.id)).toEqual(['child1', 'parent'])
    })

    it('should get descendants', () => {
      registry.register({
        agentId: 'grandchild',
        ownerId: 'owner-1',
        parent: 'child1',
      })

      const descendants = registry.getDescendants('parent')
      expect(descendants.map((d) => d.id).sort()).toEqual(['child1', 'child2', 'grandchild'])
    })

    it('should respect depth limit for ancestors', () => {
      registry.register({
        agentId: 'grandchild',
        ownerId: 'owner-1',
        parent: 'child1',
      })

      const ancestors = registry.getAncestors('grandchild', 1)
      expect(ancestors.map((a) => a.id)).toEqual(['child1'])
    })

    it('should respect depth limit for descendants', () => {
      registry.register({
        agentId: 'grandchild',
        ownerId: 'owner-1',
        parent: 'child1',
      })

      const descendants = registry.getDescendants('parent', 1)
      expect(descendants.map((d) => d.id).sort()).toEqual(['child1', 'child2'])
    })
  })

  describe('Query', () => {
    beforeEach(() => {
      registry.register({
        agentId: 'worker-1',
        ownerId: 'owner-1',
        role: 'worker',
        scopes: ['scope-a'],
      })
      registry.register({
        agentId: 'worker-2',
        ownerId: 'owner-1',
        role: 'worker',
        scopes: ['scope-b'],
      })
      registry.register({
        agentId: 'coordinator-1',
        ownerId: 'owner-2',
        role: 'coordinator',
        scopes: ['scope-a'],
      })
      registry.update('worker-1', { state: 'active' })
      registry.update('worker-2', { state: 'busy' })
    })

    it('should list all agents', () => {
      const agents = registry.list()
      expect(agents).toHaveLength(3)
    })

    it('should filter by role', () => {
      const workers = registry.list({ roles: ['worker'] })
      expect(workers).toHaveLength(2)
      expect(workers.every((a) => a.role === 'worker')).toBe(true)
    })

    it('should filter by state', () => {
      const activeAgents = registry.list({ states: ['active'] as AgentState[] })
      expect(activeAgents).toHaveLength(1)
      expect(activeAgents[0].id).toBe('worker-1')
    })

    it('should filter by scope', () => {
      const scopeAAgents = registry.list({ scopes: ['scope-a'] })
      expect(scopeAAgents).toHaveLength(2)
    })

    it('should filter by owner', () => {
      const owner1Agents = registry.list({ ownerId: 'owner-1' })
      expect(owner1Agents).toHaveLength(2)
    })

    it('should get agents by role', () => {
      const coordinators = registry.getByRole('coordinator')
      expect(coordinators).toHaveLength(1)
      expect(coordinators[0].id).toBe('coordinator-1')
    })
  })

  describe('Scopes', () => {
    it('should add agent to scope', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      registry.addToScope('agent-1', 'scope-1')

      const agent = registry.get('agent-1')
      expect(agent?.scopes).toContain('scope-1')
    })

    it('should remove agent from scope', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
        scopes: ['scope-1', 'scope-2'],
      })

      registry.removeFromScope('agent-1', 'scope-1')

      const agent = registry.get('agent-1')
      expect(agent?.scopes).toEqual(['scope-2'])
    })
  })

  describe('Orphaning', () => {
    it('should orphan agents by owner', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })
      registry.register({
        agentId: 'agent-2',
        ownerId: 'owner-1',
      })
      registry.register({
        agentId: 'agent-3',
        ownerId: 'owner-2',
      })

      const orphaned = registry.orphanByOwner('owner-1')

      expect(orphaned).toHaveLength(2)
      expect(registry.get('agent-1')?.ownerId).toBeNull()
      expect(registry.get('agent-1')?.state).toBe('orphaned')
      expect(registry.get('agent-3')?.ownerId).toBe('owner-2')
    })

    it('should emit agent:orphaned event', () => {
      const handler = vi.fn()
      registry.on('agent:orphaned', handler)

      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      registry.orphanByOwner('owner-1')

      expect(handler).toHaveBeenCalled()
    })

    it('should reclaim orphaned agents', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })
      registry.orphanByOwner('owner-1')

      const reclaimed = registry.reclaimAgents('owner-2', ['agent-1'])

      expect(reclaimed).toHaveLength(1)
      expect(registry.get('agent-1')?.ownerId).toBe('owner-2')
      expect(registry.get('agent-1')?.state).toBe('registered')
    })

    it('should not reclaim non-orphaned agents', () => {
      registry.register({
        agentId: 'agent-1',
        ownerId: 'owner-1',
      })

      const reclaimed = registry.reclaimAgents('owner-2', ['agent-1'])

      expect(reclaimed).toHaveLength(0)
      expect(registry.get('agent-1')?.ownerId).toBe('owner-1')
    })
  })

  describe('Clear', () => {
    it('should clear all agents', () => {
      registry.register({ agentId: 'agent-1', ownerId: 'owner-1' })
      registry.register({ agentId: 'agent-2', ownerId: 'owner-1' })

      registry.clear()

      expect(registry.size).toBe(0)
      expect(registry.list()).toHaveLength(0)
    })
  })
})
