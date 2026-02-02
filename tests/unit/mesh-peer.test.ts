/**
 * MeshPeer Unit Tests
 *
 * Tests for the MeshPeer class, focusing on agent lifecycle management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MeshPeer } from '../../src/map/mesh-peer'
import type { TransportAdapter } from '../../src/transports/types'

// Mock transport adapter
function createMockTransport(): TransportAdapter {
  const emitter = new (require('events').EventEmitter)()
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    getConnectedPeers: vi.fn().mockReturnValue([]),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    eventNames: emitter.eventNames.bind(emitter),
    addListener: emitter.addListener.bind(emitter),
    prependListener: emitter.prependListener.bind(emitter),
    prependOnceListener: emitter.prependOnceListener.bind(emitter),
    rawListeners: emitter.rawListeners.bind(emitter),
    setMaxListeners: emitter.setMaxListeners.bind(emitter),
    getMaxListeners: emitter.getMaxListeners.bind(emitter),
  } as TransportAdapter
}

describe('MeshPeer', () => {
  let peer: MeshPeer
  let transport: TransportAdapter

  beforeEach(async () => {
    transport = createMockTransport()
    peer = new MeshPeer({
      peerId: 'test-peer',
      peerName: 'Test Peer',
    })
    await peer.start(transport)
  })

  afterEach(async () => {
    await peer.stop()
  })

  describe('Agent Lifecycle', () => {
    it('should create and register an agent', async () => {
      const conn = await peer.createAgent({
        name: 'Test Agent',
        role: 'worker',
      })

      expect(conn).toBeDefined()
      expect(conn.isRegistered).toBe(true)
      expect(conn.agent).toBeDefined()
      expect(conn.agent?.name).toBe('Test Agent')
    })

    it('should track agent in agentConnections map', async () => {
      const conn = await peer.createAgent({
        name: 'Tracked Agent',
        role: 'worker',
      })

      const retrieved = peer.getAgentConnection(conn.agentId)
      expect(retrieved).toBe(conn)
    })

    it('should unregister agent without throwing race condition error', async () => {
      // This test verifies the fix for the race condition where:
      // 1. AgentConnection.unregister() sets _agent = null
      // 2. Then emits 'unregistered' event
      // 3. MeshPeer's listener tried to access conn.agentId which threw
      //
      // The fix uses the agent object passed to the event instead of conn.agentId

      const conn = await peer.createAgent({
        name: 'Agent To Unregister',
        role: 'worker',
      })

      const agentId = conn.agentId

      // This should NOT throw "Agent not registered" error
      await expect(conn.unregister()).resolves.toBeUndefined()

      // Agent should be removed from the map
      expect(peer.getAgentConnection(agentId)).toBeUndefined()

      // Connection should no longer be registered
      expect(conn.isRegistered).toBe(false)
      expect(conn.agent).toBeNull()
    })

    it('should handle multiple agent unregistrations', async () => {
      const conn1 = await peer.createAgent({
        name: 'Agent 1',
        role: 'worker',
      })
      const conn2 = await peer.createAgent({
        name: 'Agent 2',
        role: 'worker',
      })
      const conn3 = await peer.createAgent({
        name: 'Agent 3',
        role: 'worker',
      })

      const id1 = conn1.agentId
      const id2 = conn2.agentId
      const id3 = conn3.agentId

      // Unregister in different order
      await conn2.unregister()
      expect(peer.getAgentConnection(id2)).toBeUndefined()
      expect(peer.getAgentConnection(id1)).toBeDefined()
      expect(peer.getAgentConnection(id3)).toBeDefined()

      await conn1.unregister()
      expect(peer.getAgentConnection(id1)).toBeUndefined()
      expect(peer.getAgentConnection(id3)).toBeDefined()

      await conn3.unregister()
      expect(peer.getAgentConnection(id3)).toBeUndefined()
    })

    it('should emit unregistered event with agent data', async () => {
      const conn = await peer.createAgent({
        name: 'Event Agent',
        role: 'worker',
      })

      const agentId = conn.agentId
      let emittedAgent: any = null

      conn.on('unregistered', (agent) => {
        emittedAgent = agent
      })

      await conn.unregister()

      expect(emittedAgent).toBeDefined()
      expect(emittedAgent.id).toBe(agentId)
      expect(emittedAgent.name).toBe('Event Agent')
    })

    it('should handle unregister called multiple times', async () => {
      const conn = await peer.createAgent({
        name: 'Double Unregister Agent',
        role: 'worker',
      })

      // First unregister should succeed
      await expect(conn.unregister()).resolves.toBeUndefined()

      // Second unregister should be a no-op (not throw)
      await expect(conn.unregister()).resolves.toBeUndefined()
    })
  })

  describe('Agent Queries', () => {
    it('should list local agents', async () => {
      await peer.createAgent({ name: 'Agent 1' })
      await peer.createAgent({ name: 'Agent 2' })

      const agents = peer.getLocalAgents()
      expect(agents).toHaveLength(2)
    })

    it('should return undefined for non-existent agent connection', () => {
      const conn = peer.getAgentConnection('non-existent-id')
      expect(conn).toBeUndefined()
    })
  })
})
