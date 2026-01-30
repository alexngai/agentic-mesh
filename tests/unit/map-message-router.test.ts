import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MessageRouter, type DeliveryHandler } from '../../src/map/server/message-router'
import { AgentRegistry } from '../../src/map/server/agent-registry'
import { ScopeManager } from '../../src/map/server/scope-manager'
import { EventBus } from '../../src/map/server/event-bus'
import type { Address, Message } from '../../src/map/types'

describe('MessageRouter', () => {
  let router: MessageRouter
  let agentRegistry: AgentRegistry
  let scopeManager: ScopeManager
  let eventBus: EventBus
  let deliveryHandler: DeliveryHandler

  beforeEach(() => {
    agentRegistry = new AgentRegistry()
    scopeManager = new ScopeManager()
    eventBus = new EventBus()

    // Create mock delivery handler
    deliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
      routeToFederation: vi.fn().mockResolvedValue(true),
    }

    router = new MessageRouter({
      systemId: 'test-system',
      agentRegistry,
      scopeManager,
      eventBus,
      deliveryHandler,
    })

    // Set up test data
    agentRegistry.register({
      agentId: 'agent-1',
      ownerId: 'owner-1',
      role: 'worker',
      scopes: ['scope-a'],
    })
    agentRegistry.register({
      agentId: 'agent-2',
      ownerId: 'owner-1',
      role: 'worker',
      scopes: ['scope-a', 'scope-b'],
    })
    agentRegistry.register({
      agentId: 'agent-3',
      ownerId: 'owner-1',
      role: 'coordinator',
      scopes: ['scope-b'],
    })

    scopeManager.create({ scopeId: 'scope-a' })
    scopeManager.create({ scopeId: 'scope-b' })
    scopeManager.join('scope-a', 'agent-1')
    scopeManager.join('scope-a', 'agent-2')
    scopeManager.join('scope-b', 'agent-2')
    scopeManager.join('scope-b', 'agent-3')
  })

  describe('Address Resolution', () => {
    describe('String shorthand', () => {
      it('should resolve string as direct agent address', () => {
        const resolved = router.resolveAddress('agent-1')
        expect(resolved.localAgents).toContain('agent-1')
      })
    })

    describe('DirectAddress', () => {
      it('should resolve direct agent address', () => {
        const resolved = router.resolveAddress({ agent: 'agent-2' })
        expect(resolved.localAgents).toContain('agent-2')
      })
    })

    describe('MultiAddress', () => {
      it('should resolve multiple agents', () => {
        const resolved = router.resolveAddress({ agents: ['agent-1', 'agent-2'] })
        expect(resolved.localAgents).toContain('agent-1')
        expect(resolved.localAgents).toContain('agent-2')
      })
    })

    describe('ScopeAddress', () => {
      it('should resolve all agents in scope', () => {
        const resolved = router.resolveAddress({ scope: 'scope-a' })
        expect(resolved.localAgents.sort()).toEqual(['agent-1', 'agent-2'])
      })

      it('should resolve different scope', () => {
        const resolved = router.resolveAddress({ scope: 'scope-b' })
        expect(resolved.localAgents.sort()).toEqual(['agent-2', 'agent-3'])
      })
    })

    describe('RoleAddress', () => {
      it('should resolve agents by role', () => {
        const resolved = router.resolveAddress({ role: 'worker' })
        expect(resolved.localAgents.sort()).toEqual(['agent-1', 'agent-2'])
      })

      it('should resolve coordinator role', () => {
        const resolved = router.resolveAddress({ role: 'coordinator' })
        expect(resolved.localAgents).toEqual(['agent-3'])
      })

      it('should filter by role within scope', () => {
        const resolved = router.resolveAddress({ role: 'worker', within: 'scope-b' })
        expect(resolved.localAgents).toEqual(['agent-2'])
      })
    })

    describe('HierarchicalAddress', () => {
      beforeEach(() => {
        // Create hierarchy: parent -> child1, child2
        agentRegistry.register({
          agentId: 'parent',
          ownerId: 'owner-1',
        })
        agentRegistry.register({
          agentId: 'child-1',
          ownerId: 'owner-1',
          parent: 'parent',
        })
        agentRegistry.register({
          agentId: 'child-2',
          ownerId: 'owner-1',
          parent: 'parent',
        })
      })

      it('should resolve parent', () => {
        const resolved = router.resolveAddress({ parent: true }, 'child-1')
        expect(resolved.localAgents).toContain('parent')
      })

      it('should resolve children', () => {
        const resolved = router.resolveAddress({ children: true }, 'parent')
        expect(resolved.localAgents.sort()).toEqual(['child-1', 'child-2'])
      })

      it('should resolve siblings', () => {
        const resolved = router.resolveAddress({ siblings: true }, 'child-1')
        expect(resolved.localAgents).toContain('child-2')
        expect(resolved.localAgents).not.toContain('child-1')
      })
    })

    describe('BroadcastAddress', () => {
      it('should resolve all agents', () => {
        const resolved = router.resolveAddress({ broadcast: true })
        expect(resolved.localAgents.length).toBeGreaterThanOrEqual(3)
      })
    })

    describe('FederatedAddress', () => {
      it('should resolve federated address', () => {
        const resolved = router.resolveAddress({
          system: 'remote-system',
          agent: 'remote-agent',
        })
        expect(resolved.federatedSystems).toHaveLength(1)
        expect(resolved.federatedSystems![0].systemId).toBe('remote-system')
        expect(resolved.federatedSystems![0].agentIds).toContain('remote-agent')
      })
    })

    describe('Remote agents', () => {
      it('should route to remote peer for unknown agent', () => {
        router.registerRemoteAgent('remote-agent-1', 'peer-1')

        const resolved = router.resolveAddress({ agent: 'remote-agent-1' })

        expect(resolved.localAgents).toHaveLength(0)
        expect(resolved.remotePeers).toHaveLength(1)
        expect(resolved.remotePeers[0].peerId).toBe('peer-1')
        expect(resolved.remotePeers[0].agentIds).toContain('remote-agent-1')
      })
    })
  })

  describe('Message Sending', () => {
    it('should send message to local agent', async () => {
      const result = await router.send('sender', { agent: 'agent-1' }, { data: 'test' })

      expect(result.messageId).toBeDefined()
      expect(result.delivered).toContain('agent-1')
      expect(deliveryHandler.deliverToAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ payload: { data: 'test' } })
      )
    })

    it('should send message to multiple agents', async () => {
      const result = await router.send(
        'sender',
        { agents: ['agent-1', 'agent-2'] },
        { data: 'test' }
      )

      expect(result.delivered).toHaveLength(2)
      expect(deliveryHandler.deliverToAgent).toHaveBeenCalledTimes(2)
    })

    it('should send message to scope', async () => {
      const result = await router.send('sender', { scope: 'scope-a' }, { data: 'test' })

      expect(result.delivered).toHaveLength(2)
      expect(result.delivered.sort()).toEqual(['agent-1', 'agent-2'])
    })

    it('should include message metadata', async () => {
      await router.send('sender', { agent: 'agent-1' }, { data: 'test' }, {
        priority: 'high',
        correlationId: 'corr-123',
      })

      expect(deliveryHandler.deliverToAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          meta: expect.objectContaining({
            priority: 'high',
            correlationId: 'corr-123',
          }),
        })
      )
    })

    it('should report failed deliveries', async () => {
      ;(deliveryHandler.deliverToAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

      const result = await router.send('sender', { agent: 'agent-1' }, { data: 'test' })

      expect(result.failed).toHaveLength(1)
      expect(result.failed![0].participantId).toBe('agent-1')
    })

    it('should forward to remote peer', async () => {
      router.registerRemoteAgent('remote-agent', 'peer-1')

      const result = await router.send('sender', { agent: 'remote-agent' }, { data: 'test' })

      expect(deliveryHandler.forwardToPeer).toHaveBeenCalledWith(
        'peer-1',
        ['remote-agent'],
        expect.any(Object)
      )
    })
  })

  describe('Remote Agent Management', () => {
    it('should register remote agent', () => {
      router.registerRemoteAgent('remote-1', 'peer-1')
      expect(router.getAgentPeer('remote-1')).toBe('peer-1')
    })

    it('should unregister remote agent', () => {
      router.registerRemoteAgent('remote-1', 'peer-1')
      router.unregisterRemoteAgent('remote-1')
      expect(router.getAgentPeer('remote-1')).toBeUndefined()
    })

    it('should unregister all agents on peer', () => {
      router.registerRemoteAgent('remote-1', 'peer-1')
      router.registerRemoteAgent('remote-2', 'peer-1')
      router.registerRemoteAgent('remote-3', 'peer-2')

      router.unregisterPeerAgents('peer-1')

      expect(router.getAgentPeer('remote-1')).toBeUndefined()
      expect(router.getAgentPeer('remote-2')).toBeUndefined()
      expect(router.getAgentPeer('remote-3')).toBe('peer-2')
    })
  })
})
