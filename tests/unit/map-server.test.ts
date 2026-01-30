import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MapServer } from '../../src/map/server/map-server'
import type { Agent, Scope, Event } from '../../src/map/types'
import { EVENT_TYPES } from '../../src/map/types'

describe('MapServer', () => {
  let server: MapServer

  beforeEach(async () => {
    server = new MapServer({
      systemId: 'test-server',
      systemName: 'Test Server',
      systemVersion: '1.0.0',
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('Lifecycle', () => {
    it('should start and stop', async () => {
      const newServer = new MapServer({ systemId: 'lifecycle-test' })

      expect(newServer.isRunning).toBe(false)

      await newServer.start()
      expect(newServer.isRunning).toBe(true)

      await newServer.stop()
      expect(newServer.isRunning).toBe(false)
    })

    it('should emit started event', async () => {
      const newServer = new MapServer({ systemId: 'event-test' })
      const handler = vi.fn()
      newServer.on('started', handler)

      await newServer.start()

      expect(handler).toHaveBeenCalled()
      await newServer.stop()
    })

    it('should emit stopped event', async () => {
      const handler = vi.fn()
      server.on('stopped', handler)

      await server.stop()

      expect(handler).toHaveBeenCalled()
    })
  })

  describe('Agent Management', () => {
    it('should register an agent', () => {
      const agent = server.registerAgent({
        ownerId: 'owner-1',
        name: 'Test Agent',
        role: 'worker',
      })

      expect(agent.id).toBeDefined()
      expect(agent.name).toBe('Test Agent')
      expect(server.getAgent(agent.id)).toBeDefined()
    })

    it('should unregister an agent', () => {
      const agent = server.registerAgent({
        agentId: 'agent-to-remove',
        ownerId: 'owner-1',
      })

      const removed = server.unregisterAgent('agent-to-remove')

      expect(removed.id).toBe('agent-to-remove')
      expect(server.getAgent('agent-to-remove')).toBeUndefined()
    })

    it('should list agents', () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1', role: 'worker' })
      server.registerAgent({ agentId: 'agent-2', ownerId: 'owner-1', role: 'worker' })
      server.registerAgent({ agentId: 'agent-3', ownerId: 'owner-1', role: 'coordinator' })

      const allAgents = server.listAgents()
      expect(allAgents).toHaveLength(3)

      const workers = server.listAgents({ roles: ['worker'] })
      expect(workers).toHaveLength(2)
    })

    it('should update agent', () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })

      const updated = server.updateAgent('agent-1', { state: 'active' })

      expect(updated.state).toBe('active')
    })

    it('should emit agent:registered event', () => {
      const handler = vi.fn()
      server.on('agent:registered', handler)

      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }))
    })

    it('should emit agent:unregistered event', () => {
      const handler = vi.fn()
      server.on('agent:unregistered', handler)

      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.unregisterAgent('agent-1')

      expect(handler).toHaveBeenCalled()
    })

    it('should get agent hierarchy', () => {
      server.registerAgent({ agentId: 'parent', ownerId: 'owner-1' })
      server.registerAgent({ agentId: 'child-1', ownerId: 'owner-1', parent: 'parent' })
      server.registerAgent({ agentId: 'child-2', ownerId: 'owner-1', parent: 'parent' })

      const hierarchy = server.getAgentHierarchy('parent', {
        includeChildren: true,
      })

      expect(hierarchy.agent.id).toBe('parent')
      expect(hierarchy.children?.map((c) => c.id).sort()).toEqual(['child-1', 'child-2'])
    })

    it('should orphan agents by owner', () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.registerAgent({ agentId: 'agent-2', ownerId: 'owner-1' })

      const orphaned = server.orphanAgentsByOwner('owner-1')

      expect(orphaned).toHaveLength(2)
      expect(server.getAgent('agent-1')?.ownerId).toBeNull()
    })

    it('should reclaim agents', () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.orphanAgentsByOwner('owner-1')

      const reclaimed = server.reclaimAgents('owner-2', ['agent-1'])

      expect(reclaimed).toHaveLength(1)
      expect(server.getAgent('agent-1')?.ownerId).toBe('owner-2')
    })
  })

  describe('Scope Management', () => {
    it('should create a scope', () => {
      const scope = server.createScope({
        scopeId: 'scope-1',
        name: 'Test Scope',
      })

      expect(scope.id).toBe('scope-1')
      expect(server.getScope('scope-1')).toBeDefined()
    })

    it('should delete a scope', () => {
      server.createScope({ scopeId: 'scope-1' })

      const deleted = server.deleteScope('scope-1')

      expect(deleted.id).toBe('scope-1')
      expect(server.getScope('scope-1')).toBeUndefined()
    })

    it('should list scopes', () => {
      server.createScope({ scopeId: 'scope-1' })
      server.createScope({ scopeId: 'scope-2' })

      const scopes = server.listScopes()
      expect(scopes).toHaveLength(2)
    })

    it('should join scope', () => {
      server.createScope({ scopeId: 'scope-1' })
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })

      server.joinScope('scope-1', 'agent-1')

      const members = server.getScopeMembers('scope-1')
      expect(members).toContain('agent-1')
    })

    it('should leave scope', () => {
      server.createScope({ scopeId: 'scope-1' })
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.joinScope('scope-1', 'agent-1')

      server.leaveScope('scope-1', 'agent-1')

      const members = server.getScopeMembers('scope-1')
      expect(members).not.toContain('agent-1')
    })

    it('should emit scope:created event', () => {
      const handler = vi.fn()
      server.on('scope:created', handler)

      server.createScope({ scopeId: 'scope-1' })

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'scope-1' }))
    })

    it('should auto-join agent to scopes on registration', () => {
      server.createScope({ scopeId: 'scope-1' })

      server.registerAgent({
        agentId: 'agent-1',
        ownerId: 'owner-1',
        scopes: ['scope-1'],
      })

      const members = server.getScopeMembers('scope-1')
      expect(members).toContain('agent-1')
    })

    it('should create scope if not exists on registration', () => {
      server.registerAgent({
        agentId: 'agent-1',
        ownerId: 'owner-1',
        scopes: ['new-scope'],
      })

      expect(server.getScope('new-scope')).toBeDefined()
    })
  })

  describe('Messaging', () => {
    beforeEach(() => {
      server.registerAgent({ agentId: 'sender', ownerId: 'owner-1' })
      server.registerAgent({ agentId: 'receiver', ownerId: 'owner-1' })
    })

    it('should send message to agent', async () => {
      const messageHandler = vi.fn()
      server.setMessageHandler('receiver', messageHandler)

      const result = await server.send('sender', { agent: 'receiver' }, { data: 'test' })

      expect(result.messageId).toBeDefined()
      expect(messageHandler).toHaveBeenCalledWith(
        'receiver',
        expect.objectContaining({ payload: { data: 'test' } })
      )
    })

    it('should emit message:sent event', async () => {
      const handler = vi.fn()
      server.on('message:sent', handler)

      server.setMessageHandler('receiver', vi.fn())
      await server.send('sender', { agent: 'receiver' }, { data: 'test' })

      expect(handler).toHaveBeenCalled()
    })

    it('should remove message handler', async () => {
      const messageHandler = vi.fn()
      server.setMessageHandler('receiver', messageHandler)
      server.removeMessageHandler('receiver')

      const result = await server.send('sender', { agent: 'receiver' }, { data: 'test' })

      expect(messageHandler).not.toHaveBeenCalled()
    })
  })

  describe('Subscriptions', () => {
    it('should subscribe to events', () => {
      const subscription = server.subscribe('participant-1')

      expect(subscription.id).toBeDefined()
    })

    it('should receive events through subscription', async () => {
      const subscription = server.subscribe('participant-1', {
        eventTypes: [EVENT_TYPES.AGENT_REGISTERED],
      })

      // Register agent (triggers event)
      server.registerAgent({ agentId: 'new-agent', ownerId: 'owner-1' })

      const iterator = subscription.events()[Symbol.asyncIterator]()
      const result = await iterator.next()

      expect(result.value.type).toBe(EVENT_TYPES.AGENT_REGISTERED)
    })

    it('should unsubscribe', () => {
      const subscription = server.subscribe('participant-1')
      server.unsubscribe(subscription.id)

      // Should not throw
    })

    it('should unsubscribe all for participant', () => {
      server.subscribe('participant-1')
      server.subscribe('participant-1')

      server.unsubscribeAll('participant-1')

      // Should not throw
    })
  })

  describe('Event Publishing', () => {
    it('should publish custom events', async () => {
      const subscription = server.subscribe('participant-1')

      server.publishEvent({
        id: 'custom-event-1',
        type: 'agent_registered',
        timestamp: Date.now(),
        data: { custom: 'data' },
      })

      const iterator = subscription.events()[Symbol.asyncIterator]()
      const result = await iterator.next()

      expect(result.value.data).toEqual({ custom: 'data' })
    })
  })

  describe('Replay', () => {
    it('should replay events', async () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.registerAgent({ agentId: 'agent-2', ownerId: 'owner-1' })

      const result = server.replay({})

      expect(result.events.length).toBeGreaterThanOrEqual(2)
    })

    it('should replay with filter', async () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.updateAgent('agent-1', { state: 'active' })

      const result = server.replay({
        filter: {
          eventTypes: [EVENT_TYPES.AGENT_REGISTERED],
        },
      })

      expect(result.events.every((e) => e.type === EVENT_TYPES.AGENT_REGISTERED)).toBe(true)
    })
  })

  describe('Remote Agent Management', () => {
    it('should register remote agent', () => {
      server.registerRemoteAgent('remote-1', 'peer-1')

      // Remote agents can be messaged
    })

    it('should unregister remote agent', () => {
      server.registerRemoteAgent('remote-1', 'peer-1')
      server.unregisterRemoteAgent('remote-1')
    })

    it('should unregister all agents on peer', () => {
      server.registerRemoteAgent('remote-1', 'peer-1')
      server.registerRemoteAgent('remote-2', 'peer-1')

      server.unregisterPeerAgents('peer-1')
    })
  })

  describe('System Info', () => {
    it('should return system info', () => {
      server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })
      server.createScope({ scopeId: 'scope-1' })

      const info = server.getSystemInfo()

      expect(info.systemId).toBe('test-server')
      expect(info.systemName).toBe('Test Server')
      expect(info.systemVersion).toBe('1.0.0')
      expect(info.protocolVersion).toBe(1)
      expect(info.agentCount).toBe(1)
      expect(info.scopeCount).toBe(1)
    })
  })
})
