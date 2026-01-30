/**
 * MAP Protocol Integration Tests
 *
 * End-to-end tests for the Multi-Agent Protocol integration
 * testing agents, scopes, events, and messaging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MapServer } from '../../src/map/server/map-server'
import { AgentRegistry } from '../../src/map/server/agent-registry'
import { ScopeManager } from '../../src/map/server/scope-manager'
import { EventBus } from '../../src/map/server/event-bus'
import { MessageRouter } from '../../src/map/server/message-router'
import type {
  Agent,
  AgentId,
  ParticipantId,
  Message,
  Event,
  Scope,
  SubscriptionFilter,
} from '../../src/map/types'
import { EVENT_TYPES } from '../../src/map/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('MAP Protocol Integration', () => {
  describe('MapServer Full Flow', () => {
    let server: MapServer

    beforeEach(async () => {
      server = new MapServer({
        systemId: 'test-system',
        systemName: 'Test System',
        systemVersion: '1.0.0',
      })
      await server.start()
    })

    afterEach(async () => {
      await server.stop()
    })

    describe('Agent Lifecycle', () => {
      it('should register and unregister agents', () => {
        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Test Agent',
          role: 'worker',
        })

        expect(agent).toBeDefined()
        expect(agent.id).toBeDefined()
        expect(agent.name).toBe('Test Agent')
        expect(agent.role).toBe('worker')
        expect(agent.state).toBe('registered')
        expect(agent.ownerId).toBe('client-1')

        // List agents
        const agents = server.listAgents()
        expect(agents).toHaveLength(1)
        expect(agents[0].id).toBe(agent.id)

        // Unregister
        const unregistered = server.unregisterAgent(agent.id, 'test complete')
        expect(unregistered.id).toBe(agent.id)

        // Should no longer be listed
        expect(server.listAgents()).toHaveLength(0)
      })

      it('should update agent state', () => {
        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Stateful Agent',
        })

        expect(agent.state).toBe('registered')

        const updated = server.updateAgent(agent.id, { state: 'active' })
        expect(updated.state).toBe('active')

        const updated2 = server.updateAgent(agent.id, { state: 'busy' })
        expect(updated2.state).toBe('busy')
      })

      it('should emit events on agent lifecycle changes', async () => {
        const events: Event[] = []

        // Subscribe to all events
        const subscription = server.subscribe('observer', undefined, {
          excludeOwnEvents: false,
        })

        // Start collecting events
        const eventCollector = (async () => {
          for await (const event of subscription.events()) {
            events.push(event)
            if (events.length >= 3) break
          }
        })()

        // Trigger events
        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Event Agent',
        })

        await sleep(10)

        server.updateAgent(agent.id, { state: 'active' })
        await sleep(10)

        server.unregisterAgent(agent.id)
        await sleep(10)

        // Wait for events or timeout
        await Promise.race([eventCollector, sleep(500)])
        subscription.unsubscribe()

        // Verify events
        expect(events.length).toBeGreaterThanOrEqual(2)

        const eventTypes = events.map((e) => e.type)
        expect(eventTypes).toContain(EVENT_TYPES.AGENT_REGISTERED)
      })

      it('should handle agent hierarchy (parent-child)', () => {
        const parent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Parent Agent',
          role: 'coordinator',
        })

        const child1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Child Agent 1',
          parent: parent.id,
          role: 'worker',
        })

        const child2 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Child Agent 2',
          parent: parent.id,
          role: 'worker',
        })

        // Verify hierarchy
        const hierarchy = server.getAgentHierarchy(parent.id, {
          includeChildren: true,
        })

        expect(hierarchy.agent.id).toBe(parent.id)
        expect(hierarchy.children).toBeDefined()
        expect(hierarchy.children).toHaveLength(2)
        expect(hierarchy.children!.map((c) => c.id)).toContain(child1.id)
        expect(hierarchy.children!.map((c) => c.id)).toContain(child2.id)

        // Child hierarchy
        const childHierarchy = server.getAgentHierarchy(child1.id, {
          includeParent: true,
          includeSiblings: true,
        })

        expect(childHierarchy.parent?.id).toBe(parent.id)
        expect(childHierarchy.siblings).toHaveLength(1)
        expect(childHierarchy.siblings![0].id).toBe(child2.id)
      })

      it('should filter agents by state and role', () => {
        // Create agents with different states and roles
        const agent1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Active Worker',
          role: 'worker',
        })
        server.updateAgent(agent1.id, { state: 'active' })

        const agent2 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Busy Worker',
          role: 'worker',
        })
        server.updateAgent(agent2.id, { state: 'busy' })

        const agent3 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Active Coordinator',
          role: 'coordinator',
        })
        server.updateAgent(agent3.id, { state: 'active' })

        // Filter by state
        const activeAgents = server.listAgents({ states: ['active'] })
        expect(activeAgents).toHaveLength(2)

        // Filter by role
        const workers = server.listAgents({ roles: ['worker'] })
        expect(workers).toHaveLength(2)

        // Filter by both
        const activeWorkers = server.listAgents({
          states: ['active'],
          roles: ['worker'],
        })
        expect(activeWorkers).toHaveLength(1)
        expect(activeWorkers[0].id).toBe(agent1.id)
      })
    })

    describe('Scope Management', () => {
      it('should create and delete scopes', () => {
        const scope = server.createScope({
          scopeId: 'test-scope',
          name: 'Test Scope',
          joinPolicy: 'open',
        })

        expect(scope.id).toBe('test-scope')
        expect(scope.name).toBe('Test Scope')
        expect(scope.joinPolicy).toBe('open')

        // List scopes
        const scopes = server.listScopes()
        expect(scopes).toHaveLength(1)

        // Delete scope
        const deleted = server.deleteScope('test-scope')
        expect(deleted.id).toBe('test-scope')
        expect(server.listScopes()).toHaveLength(0)
      })

      it('should manage scope membership', () => {
        const scope = server.createScope({
          scopeId: 'team-scope',
          name: 'Team Scope',
        })

        const agent1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Team Member 1',
        })

        const agent2 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Team Member 2',
        })

        // Join scope
        server.joinScope('team-scope', agent1.id)
        server.joinScope('team-scope', agent2.id)

        // Check members
        const members = server.getScopeMembers('team-scope')
        expect(members).toHaveLength(2)
        expect(members).toContain(agent1.id)
        expect(members).toContain(agent2.id)

        // Leave scope
        server.leaveScope('team-scope', agent1.id)
        expect(server.getScopeMembers('team-scope')).toHaveLength(1)
      })

      it('should auto-join agents to initial scopes', () => {
        server.createScope({ scopeId: 'auto-scope' })

        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Auto-join Agent',
          scopes: ['auto-scope'],
        })

        expect(agent.scopes).toContain('auto-scope')
        expect(server.getScopeMembers('auto-scope')).toContain(agent.id)
      })

      it('should create scope on-demand when agent joins non-existent scope', () => {
        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Agent',
          scopes: ['new-scope'],
        })

        // Scope should be auto-created
        const scope = server.getScope('new-scope')
        expect(scope).toBeDefined()
        expect(server.getScopeMembers('new-scope')).toContain(agent.id)
      })

      it('should support hierarchical scopes', () => {
        const parentScope = server.createScope({
          scopeId: 'parent-scope',
          name: 'Parent Scope',
        })

        const childScope = server.createScope({
          scopeId: 'child-scope',
          name: 'Child Scope',
          parent: 'parent-scope',
        })

        expect(childScope.parent).toBe('parent-scope')

        // Filter by parent
        const childScopes = server.listScopes({ parent: 'parent-scope' })
        expect(childScopes).toHaveLength(1)
        expect(childScopes[0].id).toBe('child-scope')
      })
    })

    describe('Messaging', () => {
      it('should send message to direct agent address', async () => {
        const receivedMessages: Message[] = []

        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Receiver',
        })

        // Set message handler
        server.setMessageHandler(agent.id, (agentId, message) => {
          receivedMessages.push(message)
        })

        // Send message
        const result = await server.send(
          'sender-1',
          { agent: agent.id },
          { type: 'greeting', text: 'Hello!' }
        )

        expect(result.messageId).toBeDefined()
        expect(result.delivered).toContain(agent.id)
        expect(receivedMessages).toHaveLength(1)
        expect((receivedMessages[0].payload as any).text).toBe('Hello!')
      })

      it('should send message to scope address', async () => {
        const receivedMessages: Array<{ agentId: AgentId; message: Message }> = []

        server.createScope({ scopeId: 'broadcast-scope' })

        const agent1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Member 1',
          scopes: ['broadcast-scope'],
        })

        const agent2 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Member 2',
          scopes: ['broadcast-scope'],
        })

        // Set message handlers
        server.setMessageHandler(agent1.id, (agentId, message) => {
          receivedMessages.push({ agentId, message })
        })
        server.setMessageHandler(agent2.id, (agentId, message) => {
          receivedMessages.push({ agentId, message })
        })

        // Send to scope
        const result = await server.send(
          'sender-1',
          { scope: 'broadcast-scope' },
          { type: 'announcement', text: 'Hello team!' }
        )

        expect(result.delivered).toContain(agent1.id)
        expect(result.delivered).toContain(agent2.id)
        expect(receivedMessages).toHaveLength(2)
      })

      it('should send message by role', async () => {
        const receivedMessages: Array<{ agentId: AgentId; message: Message }> = []

        const worker1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Worker 1',
          role: 'worker',
        })

        const worker2 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Worker 2',
          role: 'worker',
        })

        const coordinator = server.registerAgent({
          ownerId: 'client-1',
          name: 'Coordinator',
          role: 'coordinator',
        })

        // Set handlers
        for (const agent of [worker1, worker2, coordinator]) {
          server.setMessageHandler(agent.id, (agentId, message) => {
            receivedMessages.push({ agentId, message })
          })
        }

        // Send to workers only
        const result = await server.send(
          'sender-1',
          { role: 'worker' },
          { type: 'task', task: 'process data' }
        )

        expect(result.delivered).toContain(worker1.id)
        expect(result.delivered).toContain(worker2.id)
        expect(result.delivered).not.toContain(coordinator.id)
        expect(receivedMessages).toHaveLength(2)
      })

      it('should send message to children in hierarchy', async () => {
        const receivedMessages: Array<{ agentId: AgentId; message: Message }> = []

        const parent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Parent',
        })

        const child1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Child 1',
          parent: parent.id,
        })

        const child2 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Child 2',
          parent: parent.id,
        })

        for (const agent of [parent, child1, child2]) {
          server.setMessageHandler(agent.id, (agentId, message) => {
            receivedMessages.push({ agentId, message })
          })
        }

        // Parent sends to children
        const result = await server.send(
          parent.id,
          { children: true },
          { type: 'delegation', work: 'process' }
        )

        expect(result.delivered).toContain(child1.id)
        expect(result.delivered).toContain(child2.id)
        expect(result.delivered).not.toContain(parent.id)
        expect(receivedMessages).toHaveLength(2)
      })

      it('should send broadcast to all agents', async () => {
        const receivedMessages: Array<{ agentId: AgentId; message: Message }> = []

        const agents = [
          server.registerAgent({ ownerId: 'client-1', name: 'Agent 1' }),
          server.registerAgent({ ownerId: 'client-1', name: 'Agent 2' }),
          server.registerAgent({ ownerId: 'client-1', name: 'Agent 3' }),
        ]

        for (const agent of agents) {
          server.setMessageHandler(agent.id, (agentId, message) => {
            receivedMessages.push({ agentId, message })
          })
        }

        const result = await server.send(
          'system',
          { broadcast: true },
          { type: 'shutdown', reason: 'maintenance' }
        )

        expect(result.delivered).toHaveLength(3)
        expect(receivedMessages).toHaveLength(3)
      })

      it('should handle message delivery failure gracefully', async () => {
        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Failing Agent',
        })

        // Set handler that throws
        server.setMessageHandler(agent.id, () => {
          throw new Error('Handler error')
        })

        // Should not throw, but report failure
        const result = await server.send(
          'sender',
          { agent: agent.id },
          { type: 'test' }
        )

        // Message was attempted but handler failed
        expect(result.messageId).toBeDefined()
      })
    })

    describe('Event Subscriptions', () => {
      it('should filter events by type', async () => {
        const events: Event[] = []

        // Subscribe to agent registered events only
        const subscription = server.subscribe(
          'observer',
          { eventTypes: [EVENT_TYPES.AGENT_REGISTERED] },
          { excludeOwnEvents: false }
        )

        const collector = (async () => {
          for await (const event of subscription.events()) {
            events.push(event)
            if (events.length >= 1) break
          }
        })()

        // Trigger various events
        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Test',
        })
        await sleep(10)

        server.updateAgent(agent.id, { state: 'active' }) // Should not be captured
        await sleep(10)

        await Promise.race([collector, sleep(200)])
        subscription.unsubscribe()

        // Should only have registration event
        expect(events).toHaveLength(1)
        expect(events[0].type).toBe(EVENT_TYPES.AGENT_REGISTERED)
      })

      it('should filter events by scope membership', async () => {
        const events: Event[] = []

        // Create scopes
        server.createScope({ scopeId: 'scope-1' })
        server.createScope({ scopeId: 'scope-2' })

        // Subscribe to events in scope-1 only
        const subscription = server.subscribe(
          'observer',
          { scopes: ['scope-1'] },
          { excludeOwnEvents: false }
        )

        const collector = (async () => {
          for await (const event of subscription.events()) {
            events.push(event)
            if (events.length >= 1) break
          }
        })()

        const agent1 = server.registerAgent({
          ownerId: 'client-1',
          name: 'Agent 1',
        })

        // Join scope-2 first (should not trigger subscription)
        server.joinScope('scope-2', agent1.id)
        await sleep(10)

        // Join scope-1 (should trigger subscription)
        server.joinScope('scope-1', agent1.id)
        await sleep(10)

        await Promise.race([collector, sleep(200)])
        subscription.unsubscribe()

        // Should have scope-1 events only
        expect(events.length).toBeGreaterThanOrEqual(1)
        const scope1Events = events.filter((e) => {
          const data = e.data as { scopeId?: string }
          return data?.scopeId === 'scope-1'
        })
        expect(scope1Events.length).toBeGreaterThanOrEqual(1)
      })

      it('should exclude own events when option set', async () => {
        const events: Event[] = []
        const observerId = 'observer-client'

        // Subscribe with excludeOwnEvents
        const subscription = server.subscribe(
          observerId,
          undefined,
          { excludeOwnEvents: true }
        )

        const collector = (async () => {
          for await (const event of subscription.events()) {
            events.push(event)
            if (events.length >= 1) break
          }
        })()

        // Register agent owned by observer
        const ownAgent = server.registerAgent({
          ownerId: observerId, // Same as subscriber
          name: 'Own Agent',
        })
        await sleep(10)

        // Register agent owned by someone else
        const otherAgent = server.registerAgent({
          ownerId: 'other-client',
          name: 'Other Agent',
        })
        await sleep(10)

        await Promise.race([collector, sleep(200)])
        subscription.unsubscribe()

        // Should only see events from other agents
        const ownEvents = events.filter((e) => e.source === observerId)
        expect(ownEvents).toHaveLength(0)
      })

      it('should support multiple concurrent subscriptions', async () => {
        const events1: Event[] = []
        const events2: Event[] = []

        const sub1 = server.subscribe(
          'observer-1',
          { eventTypes: [EVENT_TYPES.AGENT_REGISTERED] }
        )

        const sub2 = server.subscribe(
          'observer-2',
          { eventTypes: [EVENT_TYPES.AGENT_STATE_CHANGED] }
        )

        const collector1 = (async () => {
          for await (const event of sub1.events()) {
            events1.push(event)
            if (events1.length >= 1) break
          }
        })()

        const collector2 = (async () => {
          for await (const event of sub2.events()) {
            events2.push(event)
            if (events2.length >= 1) break
          }
        })()

        const agent = server.registerAgent({
          ownerId: 'client-1',
          name: 'Test',
        })
        await sleep(10)

        server.updateAgent(agent.id, { state: 'active' })
        await sleep(10)

        await Promise.race([
          Promise.all([collector1, collector2]),
          sleep(300),
        ])

        sub1.unsubscribe()
        sub2.unsubscribe()

        expect(events1.length).toBeGreaterThanOrEqual(1)
        expect(events1[0].type).toBe(EVENT_TYPES.AGENT_REGISTERED)

        expect(events2.length).toBeGreaterThanOrEqual(1)
        expect(events2[0].type).toBe(EVENT_TYPES.AGENT_STATE_CHANGED)
      })
    })

    describe('Complex Scenarios', () => {
      it('should handle multi-agent task delegation', async () => {
        const taskResults: Array<{ agentId: string; task: string }> = []

        // Create coordinator and workers
        const coordinator = server.registerAgent({
          ownerId: 'client-1',
          name: 'Coordinator',
          role: 'coordinator',
        })

        const workers = [
          server.registerAgent({
            ownerId: 'client-1',
            name: 'Worker 1',
            role: 'worker',
            parent: coordinator.id,
          }),
          server.registerAgent({
            ownerId: 'client-1',
            name: 'Worker 2',
            role: 'worker',
            parent: coordinator.id,
          }),
          server.registerAgent({
            ownerId: 'client-1',
            name: 'Worker 3',
            role: 'worker',
            parent: coordinator.id,
          }),
        ]

        // Set up workers to process tasks
        for (const worker of workers) {
          server.setMessageHandler(worker.id, (agentId, message) => {
            const payload = message.payload as { task: string }
            taskResults.push({ agentId, task: payload.task })
          })
        }

        // Coordinator delegates tasks to children
        await server.send(
          coordinator.id,
          { children: true },
          { task: 'process-batch-1' }
        )

        expect(taskResults).toHaveLength(3)
        expect(taskResults.every((r) => r.task === 'process-batch-1')).toBe(true)
      })

      it('should handle scope-based collaboration', async () => {
        const messages: Array<{ scopeId: string; from: string; content: string }> = []

        // Create project scope
        server.createScope({
          scopeId: 'project-alpha',
          name: 'Project Alpha',
        })

        // Create team members
        const designer = server.registerAgent({
          ownerId: 'client-1',
          name: 'Designer',
          role: 'designer',
          scopes: ['project-alpha'],
        })

        const developer = server.registerAgent({
          ownerId: 'client-2',
          name: 'Developer',
          role: 'developer',
          scopes: ['project-alpha'],
        })

        const tester = server.registerAgent({
          ownerId: 'client-3',
          name: 'Tester',
          role: 'tester',
          scopes: ['project-alpha'],
        })

        // Set up message handlers
        for (const agent of [designer, developer, tester]) {
          server.setMessageHandler(agent.id, (agentId, message) => {
            const payload = message.payload as { content: string }
            messages.push({
              scopeId: 'project-alpha',
              from: message.from,
              content: payload.content,
            })
          })
        }

        // Designer broadcasts design update to project scope
        await server.send(
          designer.id,
          { scope: 'project-alpha' },
          { content: 'New design ready for review' }
        )

        // All team members should receive (including designer since self-delivery is on by default)
        expect(messages).toHaveLength(3)
        expect(messages.every((m) => m.content === 'New design ready for review')).toBe(true)
      })

      it('should handle agent orphaning and reclaiming', async () => {
        const clientId = 'client-to-disconnect'

        // Create agents for client
        const agent1 = server.registerAgent({
          ownerId: clientId,
          name: 'Agent 1',
        })

        const agent2 = server.registerAgent({
          ownerId: clientId,
          name: 'Agent 2',
        })

        // Simulate client disconnect - orphan agents
        const orphaned = server.orphanAgentsByOwner(clientId)
        expect(orphaned).toHaveLength(2)

        // Verify agents are orphaned
        const agent1After = server.getAgent(agent1.id)
        expect(agent1After?.ownerId).toBeNull()
        expect(agent1After?.state).toBe('orphaned')

        // Client reconnects and reclaims agents
        const reclaimed = server.reclaimAgents('new-client-id', [agent1.id, agent2.id])
        expect(reclaimed).toHaveLength(2)

        // Verify agents are reclaimed
        const agent1Reclaimed = server.getAgent(agent1.id)
        expect(agent1Reclaimed?.ownerId).toBe('new-client-id')
        expect(agent1Reclaimed?.state).toBe('registered')
      })

      it('should maintain consistency under concurrent operations', async () => {
        const concurrentOps = 10

        // Run multiple concurrent registrations
        const registrations = Array.from({ length: concurrentOps }, (_, i) =>
          server.registerAgent({
            ownerId: `client-${i}`,
            name: `Agent ${i}`,
          })
        )

        // All should succeed
        expect(registrations).toHaveLength(concurrentOps)
        expect(server.listAgents()).toHaveLength(concurrentOps)

        // Concurrent updates
        await Promise.all(
          registrations.map((agent) =>
            server.updateAgent(agent.id, { state: 'active' })
          )
        )

        // All should be active
        const activeAgents = server.listAgents({ states: ['active'] })
        expect(activeAgents).toHaveLength(concurrentOps)

        // Concurrent unregistrations
        await Promise.all(
          registrations.map((agent) =>
            server.unregisterAgent(agent.id)
          )
        )

        expect(server.listAgents()).toHaveLength(0)
      })
    })
  })

  describe('Component Integration', () => {
    describe('AgentRegistry + ScopeManager Integration', () => {
      let registry: AgentRegistry
      let scopeManager: ScopeManager

      beforeEach(() => {
        registry = new AgentRegistry()
        scopeManager = new ScopeManager()
      })

      it('should track agents across both registry and scopes', () => {
        // Create scope
        const scope = scopeManager.create({ scopeId: 'team' })

        // Register agent
        const agent = registry.register({
          ownerId: 'client-1',
          name: 'Team Member',
          scopes: ['team'],
        })

        // Add to scope
        scopeManager.join('team', agent.id)
        registry.addToScope(agent.id, 'team')

        // Verify in both
        expect(scopeManager.getMembers('team')).toContain(agent.id)
        expect(registry.get(agent.id)?.scopes).toContain('team')

        // Remove from scope
        scopeManager.leave('team', agent.id)
        registry.removeFromScope(agent.id, 'team')

        expect(scopeManager.getMembers('team')).not.toContain(agent.id)
        expect(registry.get(agent.id)?.scopes).not.toContain('team')
      })

      it('should clean up agent from all scopes on unregister', () => {
        const agent = registry.register({
          ownerId: 'client-1',
          name: 'Multi-scope Agent',
          scopes: ['scope-1', 'scope-2', 'scope-3'],
        })

        for (const scopeId of ['scope-1', 'scope-2', 'scope-3']) {
          scopeManager.create({ scopeId })
          scopeManager.join(scopeId, agent.id)
        }

        // Remove agent from all scopes
        scopeManager.removeAgentFromAllScopes(agent.id)

        expect(scopeManager.getMembers('scope-1')).not.toContain(agent.id)
        expect(scopeManager.getMembers('scope-2')).not.toContain(agent.id)
        expect(scopeManager.getMembers('scope-3')).not.toContain(agent.id)
      })
    })

    describe('EventBus + MessageRouter Integration', () => {
      let eventBus: EventBus
      let registry: AgentRegistry
      let scopeManager: ScopeManager
      let router: MessageRouter

      beforeEach(() => {
        eventBus = new EventBus({ maxHistorySize: 100 })
        registry = new AgentRegistry()
        scopeManager = new ScopeManager()

        router = new MessageRouter({
          systemId: 'test-system',
          agentRegistry: registry,
          scopeManager,
          eventBus,
          deliveryHandler: {
            deliverToAgent: async (agentId, message) => true,
            forwardToPeer: async (peerId, agentIds, message) => false,
          },
        })
      })

      it('should emit message events through event bus', async () => {
        const events: Event[] = []

        const subscription = eventBus.subscribe({
          participantId: 'observer',
          filter: { eventTypes: [EVENT_TYPES.MESSAGE_SENT] },
        })

        const collector = (async () => {
          for await (const event of subscription.events()) {
            events.push(event)
            if (events.length >= 1) break
          }
        })()

        // Register agent and send message
        const agent = registry.register({
          ownerId: 'client-1',
          name: 'Test Agent',
        })

        await router.send('sender', { agent: agent.id }, { test: 'data' })
        await sleep(50)

        await Promise.race([collector, sleep(200)])
        subscription.unsubscribe()

        expect(events.length).toBeGreaterThanOrEqual(1)
        expect(events[0].type).toBe(EVENT_TYPES.MESSAGE_SENT)
      })
    })
  })
})
