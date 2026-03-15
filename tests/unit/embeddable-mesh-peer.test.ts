/**
 * Embeddable MeshPeer Tests
 *
 * Tests for R1-R5: Embedded MeshPeer mode, custom DeliveryHandler,
 * federation gateway API, in-process agent registration, and _meta passthrough.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MeshPeer } from '../../src/map/mesh-peer'
import { MapServer } from '../../src/map/server/map-server'
import { MessageRouter, type DeliveryHandler } from '../../src/map/server/message-router'
import { AgentRegistry } from '../../src/map/server/agent-registry'
import { ScopeManager } from '../../src/map/server/scope-manager'
import { EventBus } from '../../src/map/server/event-bus'
import { FederationGateway } from '../../src/map/federation/gateway'
import type { TransportAdapter } from '../../src/transports/types'
import type { Message } from '../../src/map/types'

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

// =============================================================================
// R1: Embedded MeshPeer Mode
// =============================================================================

describe('R1: Embedded MeshPeer Mode', () => {
  describe('MeshPeer.createEmbedded()', () => {
    it('should create an embedded peer without transport config', () => {
      const peer = MeshPeer.createEmbedded({
        peerId: 'embedded-peer',
        peerName: 'Embedded Peer',
      })

      expect(peer).toBeInstanceOf(MeshPeer)
      expect(peer.peerId).toBe('embedded-peer')
      expect(peer.peerName).toBe('Embedded Peer')
    })

    it('should start without a transport in embedded mode', async () => {
      const peer = MeshPeer.createEmbedded({
        peerId: 'embedded-peer',
      })

      await peer.start()

      expect(peer.isRunning).toBe(true)

      await peer.stop()
    })

    it('should provide access to MapServer in embedded mode', async () => {
      const peer = MeshPeer.createEmbedded({
        peerId: 'embedded-peer',
      })

      await peer.start()

      expect(peer.server).toBeInstanceOf(MapServer)
      expect(peer.server.systemId).toBe('embedded-peer')

      await peer.stop()
    })

    it('should accept a transport later in embedded mode', async () => {
      const peer = MeshPeer.createEmbedded({
        peerId: 'embedded-peer',
      })

      const transport = createMockTransport()
      await peer.start(transport)

      expect(peer.isRunning).toBe(true)
      expect(transport.start).toHaveBeenCalled()

      await peer.stop()
    })

    it('should support MAP server config overrides', async () => {
      const peer = MeshPeer.createEmbedded({
        peerId: 'embedded-peer',
        map: {
          systemName: 'Custom Name',
          systemVersion: '2.0.0',
        },
      })

      await peer.start()

      const info = peer.getSystemInfo()
      expect(info.systemName).toBe('Custom Name')
      expect(info.systemVersion).toBe('2.0.0')

      await peer.stop()
    })
  })

  describe('Embedded mode via config flag', () => {
    it('should start with embedded: true config', async () => {
      const peer = new MeshPeer({
        peerId: 'embedded-peer',
        embedded: true,
      })

      await peer.start()
      expect(peer.isRunning).toBe(true)

      await peer.stop()
    })

    it('should throw without transport in non-embedded mode', async () => {
      const peer = new MeshPeer({
        peerId: 'non-embedded',
      })

      await expect(peer.start()).rejects.toThrow(
        'No transport provided and no transport factory configured'
      )
    })
  })

  describe('Embedded peer stop', () => {
    it('should stop cleanly without transport', async () => {
      const peer = MeshPeer.createEmbedded({ peerId: 'embedded-peer' })
      await peer.start()

      await peer.stop()
      expect(peer.isRunning).toBe(false)
    })

    it('should emit started and stopped events', async () => {
      const peer = MeshPeer.createEmbedded({ peerId: 'embedded-peer' })
      const startedHandler = vi.fn()
      const stoppedHandler = vi.fn()

      peer.on('started', startedHandler)
      peer.on('stopped', stoppedHandler)

      await peer.start()
      expect(startedHandler).toHaveBeenCalled()

      await peer.stop()
      expect(stoppedHandler).toHaveBeenCalled()
    })
  })
})

// =============================================================================
// R2: Custom DeliveryHandler on MapServer
// =============================================================================

describe('R2: MapServer.setDeliveryHandler()', () => {
  let server: MapServer

  beforeEach(async () => {
    server = new MapServer({
      systemId: 'test-server',
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should allow setting a custom delivery handler', async () => {
    const customHandler: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    const previousHandler = server.setDeliveryHandler(customHandler)

    expect(previousHandler).toBeDefined()
    expect(previousHandler.deliverToAgent).toBeInstanceOf(Function)
  })

  it('should return the previous handler for fallback use', async () => {
    const handler1: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    const handler2: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    const original = server.setDeliveryHandler(handler1)
    const returned = server.setDeliveryHandler(handler2)

    expect(returned).toBe(handler1)
  })

  it('should route messages through the custom handler', async () => {
    const customHandler: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    server.setDeliveryHandler(customHandler)

    // Register agent and send message
    server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })

    await server.send('sender', { agent: 'agent-1' }, { data: 'test' })

    expect(customHandler.deliverToAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        payload: { data: 'test' },
      })
    )
  })

  it('should support delegating to previous handler as fallback', async () => {
    const receivedMessages: Message[] = []

    server.registerAgent({ agentId: 'agent-1', ownerId: 'owner-1' })

    // Set up default message handler
    server.setMessageHandler('agent-1', (agentId, message) => {
      receivedMessages.push(message)
    })

    // Get the original handler and set custom one
    const previousHandler = server.setDeliveryHandler({
      async deliverToAgent(agentId, message) {
        // Custom logic: store/intercept the message
        // Then delegate to original handler for actual delivery
        return previousHandler.deliverToAgent(agentId, message)
      },
      async forwardToPeer(peerId, agentIds, message) {
        return previousHandler.forwardToPeer(peerId, agentIds, message)
      },
    })

    await server.send('sender', { agent: 'agent-1' }, { data: 'intercepted' })

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0].payload).toEqual({ data: 'intercepted' })
  })

  it('should work with embedded MeshPeer', async () => {
    const peer = MeshPeer.createEmbedded({ peerId: 'embedded' })
    await peer.start()

    const customHandler: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    const previous = peer.server.setDeliveryHandler(customHandler)
    expect(previous).toBeDefined()

    // Register agent and send
    const agent = await peer.createAgent({ name: 'worker' })
    await peer.send(agent.agentId, { agent: agent.agentId }, { text: 'hello' })

    expect(customHandler.deliverToAgent).toHaveBeenCalled()

    await peer.stop()
  })
})

// =============================================================================
// R3: Federation Gateway Public API
// =============================================================================

describe('R3: Federation Gateway Public API', () => {
  let peer: MeshPeer

  beforeEach(async () => {
    peer = MeshPeer.createEmbedded({ peerId: 'local-system' })
    await peer.start()
  })

  afterEach(async () => {
    await peer.stop()
  })

  it('should create a federation gateway via federateWith()', async () => {
    const gateway = await peer.federateWith('remote-system')

    expect(gateway).toBeInstanceOf(FederationGateway)
    expect(gateway.localSystemId).toBe('local-system')
    expect(gateway.remoteSystemId).toBe('remote-system')
  })

  it('should return existing gateway for same remote system', async () => {
    const gateway1 = await peer.federateWith('remote-system')
    const gateway2 = await peer.federateWith('remote-system')

    expect(gateway1).toBe(gateway2)
  })

  it('should create separate gateways for different remote systems', async () => {
    const gateway1 = await peer.federateWith('remote-1')
    const gateway2 = await peer.federateWith('remote-2')

    expect(gateway1).not.toBe(gateway2)
    expect(gateway1.remoteSystemId).toBe('remote-1')
    expect(gateway2.remoteSystemId).toBe('remote-2')
  })

  it('should retrieve gateway by remote system ID', async () => {
    await peer.federateWith('remote-system')

    const retrieved = peer.getFederationGateway('remote-system')
    expect(retrieved).toBeInstanceOf(FederationGateway)
    expect(retrieved?.remoteSystemId).toBe('remote-system')
  })

  it('should return undefined for non-existent gateway', () => {
    const gateway = peer.getFederationGateway('non-existent')
    expect(gateway).toBeUndefined()
  })

  it('should list all federation gateways', async () => {
    await peer.federateWith('remote-1')
    await peer.federateWith('remote-2')
    await peer.federateWith('remote-3')

    const gateways = peer.getFederationGateways()
    expect(gateways).toHaveLength(3)
  })

  it('should defederate by remote system ID', async () => {
    await peer.federateWith('remote-system')
    expect(peer.getFederationGateway('remote-system')).toBeDefined()

    await peer.defederate('remote-system', 'no longer needed')

    expect(peer.getFederationGateway('remote-system')).toBeUndefined()
    expect(peer.getFederationGateways()).toHaveLength(0)
  })

  it('should handle defederate for non-existent system gracefully', async () => {
    await expect(peer.defederate('non-existent')).resolves.toBeUndefined()
  })

  it('should accept gateway config overrides', async () => {
    const gateway = await peer.federateWith('remote-system', {
      localSystemId: 'local-system',
      remoteSystemId: 'remote-system',
      remoteEndpoint: 'wss://remote.example.com',
      buffer: { enabled: true, maxMessages: 500 },
      routing: { maxHops: 3, trackPath: true },
    })

    expect(gateway).toBeInstanceOf(FederationGateway)
  })

  it('should clean up gateways on stop', async () => {
    await peer.federateWith('remote-1')
    await peer.federateWith('remote-2')

    await peer.stop()

    expect(peer.getFederationGateways()).toHaveLength(0)
  })
})

// =============================================================================
// R4: Programmatic Agent Registration (In-Process)
// =============================================================================

describe('R4: In-Process Agent Registration', () => {
  let peer: MeshPeer

  beforeEach(async () => {
    peer = MeshPeer.createEmbedded({ peerId: 'agent-host' })
    await peer.start()
  })

  afterEach(async () => {
    await peer.stop()
  })

  it('should create agent without network transport', async () => {
    const conn = await peer.createAgent({
      agentId: 'worker-1',
      name: 'Worker Agent',
      capabilities: { messaging: { canSend: true, canReceive: true } },
    })

    expect(conn.isRegistered).toBe(true)
    expect(conn.agentId).toBe('worker-1')
    expect(conn.agent?.name).toBe('Worker Agent')
  })

  it('should receive messages through agent connection', async () => {
    const conn = await peer.createAgent({ agentId: 'receiver' })

    const messages: Message[] = []
    conn.on('message', (msg) => messages.push(msg))

    // Register sender and send
    await peer.createAgent({ agentId: 'sender' })
    await peer.send('sender', { agent: 'receiver' }, { text: 'hello' })

    expect(messages).toHaveLength(1)
    expect(messages[0].payload).toEqual({ text: 'hello' })
  })

  it('should send messages from agent connection', async () => {
    const receiver = await peer.createAgent({ agentId: 'receiver' })
    const sender = await peer.createAgent({ agentId: 'sender' })

    const messages: Message[] = []
    receiver.on('message', (msg) => messages.push(msg))

    const result = await sender.send({ agent: 'receiver' }, { text: 'from sender' })

    expect(result.delivered).toContain('receiver')
    expect(messages).toHaveLength(1)
    expect(messages[0].payload).toEqual({ text: 'from sender' })
  })

  it('should unregister agent cleanly', async () => {
    const conn = await peer.createAgent({
      agentId: 'temp-agent',
      name: 'Temporary',
    })

    await conn.unregister()

    expect(conn.isRegistered).toBe(false)
    expect(conn.agent).toBeNull()
    expect(peer.getAgentConnection('temp-agent')).toBeUndefined()
  })

  it('should support agent hierarchies in-process', async () => {
    const parent = await peer.createAgent({
      agentId: 'coordinator',
      name: 'Coordinator',
      role: 'coordinator',
    })

    const child1 = await peer.createAgent({
      agentId: 'worker-1',
      name: 'Worker 1',
      role: 'worker',
      parent: 'coordinator',
    })

    const child2 = await peer.createAgent({
      agentId: 'worker-2',
      name: 'Worker 2',
      role: 'worker',
      parent: 'coordinator',
    })

    const hierarchy = parent.getHierarchy({ includeChildren: true })
    expect(hierarchy.children).toHaveLength(2)
    expect(hierarchy.children?.map((c) => c.id).sort()).toEqual(['worker-1', 'worker-2'])
  })

  it('should support scope-based messaging in-process', async () => {
    const scope = peer.createScope({ scopeId: 'team-scope', name: 'Team' })

    const agent1 = await peer.createAgent({ agentId: 'member-1' })
    const agent2 = await peer.createAgent({ agentId: 'member-2' })

    await agent1.joinScope('team-scope')
    await agent2.joinScope('team-scope')

    const messages: Message[] = []
    agent2.on('message', (msg) => messages.push(msg))

    await agent1.broadcastToScope('team-scope', { announcement: 'hello team' })

    // agent2 should receive it (agent1 also gets it as a member)
    expect(messages).toHaveLength(1)
    expect(messages[0].payload).toEqual({ announcement: 'hello team' })
  })

  it('should list local agents', async () => {
    await peer.createAgent({ agentId: 'a1', name: 'Agent 1' })
    await peer.createAgent({ agentId: 'a2', name: 'Agent 2' })
    await peer.createAgent({ agentId: 'a3', name: 'Agent 3' })

    const agents = peer.getLocalAgents()
    expect(agents).toHaveLength(3)
    expect(agents.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3'])
  })
})

// =============================================================================
// R5: _meta Field Passthrough
// =============================================================================

describe('R5: _meta Field Passthrough', () => {
  describe('Local delivery', () => {
    let server: MapServer

    beforeEach(async () => {
      server = new MapServer({ systemId: 'test-server' })
      await server.start()
    })

    afterEach(async () => {
      await server.stop()
    })

    it('should preserve _meta through local delivery via MessageMeta', async () => {
      server.registerAgent({ agentId: 'sender', ownerId: 'owner' })
      server.registerAgent({ agentId: 'receiver', ownerId: 'owner' })

      let receivedMessage: Message | null = null
      server.setMessageHandler('receiver', (agentId, message) => {
        receivedMessage = message
      })

      await server.send('sender', { agent: 'receiver' }, { data: 'test' }, {
        _meta: {
          subject: 'Code review request',
          thread_tag: 'review-pr-42',
          recipientKind: 'cc',
          importance: 'high',
          inboxMessageId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
      })

      expect(receivedMessage).not.toBeNull()
      // _meta should be preserved on the message
      expect(receivedMessage!._meta).toEqual({
        subject: 'Code review request',
        thread_tag: 'review-pr-42',
        recipientKind: 'cc',
        importance: 'high',
        inboxMessageId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      })
      // _meta should also be in meta._meta
      expect(receivedMessage!.meta?._meta).toEqual({
        subject: 'Code review request',
        thread_tag: 'review-pr-42',
        recipientKind: 'cc',
        importance: 'high',
        inboxMessageId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      })
    })

    it('should preserve _meta with custom DeliveryHandler', async () => {
      server.registerAgent({ agentId: 'sender', ownerId: 'owner' })
      server.registerAgent({ agentId: 'receiver', ownerId: 'owner' })

      let interceptedMessage: Message | null = null
      server.setDeliveryHandler({
        async deliverToAgent(agentId, message) {
          interceptedMessage = message
          return true
        },
        async forwardToPeer() {
          return false
        },
      })

      await server.send('sender', { agent: 'receiver' }, { data: 'test' }, {
        _meta: { customField: 'preserved' },
      })

      expect(interceptedMessage).not.toBeNull()
      expect(interceptedMessage!._meta).toEqual({ customField: 'preserved' })
    })
  })

  describe('MessageRouter _meta passthrough', () => {
    let router: MessageRouter
    let agentRegistry: AgentRegistry
    let deliveryHandler: DeliveryHandler
    let deliveredMessages: Array<{ agentId: string; message: Message }>

    beforeEach(() => {
      agentRegistry = new AgentRegistry()
      const scopeManager = new ScopeManager()
      const eventBus = new EventBus()
      deliveredMessages = []

      deliveryHandler = {
        deliverToAgent: vi.fn(async (agentId, message) => {
          deliveredMessages.push({ agentId, message })
          return true
        }),
        forwardToPeer: vi.fn().mockResolvedValue(true),
      }

      router = new MessageRouter({
        systemId: 'test',
        agentRegistry,
        scopeManager,
        eventBus,
        deliveryHandler,
      })

      agentRegistry.register({ agentId: 'agent-1', ownerId: 'owner' })
    })

    it('should pass _meta from MessageMeta to Message._meta', async () => {
      await router.send('sender', 'agent-1', { data: 'test' }, {
        _meta: { inbox: 'metadata' },
      })

      expect(deliveredMessages).toHaveLength(1)
      expect(deliveredMessages[0].message._meta).toEqual({ inbox: 'metadata' })
    })

    it('should handle undefined _meta gracefully', async () => {
      await router.send('sender', 'agent-1', { data: 'test' })

      expect(deliveredMessages).toHaveLength(1)
      expect(deliveredMessages[0].message._meta).toBeUndefined()
    })

    it('should preserve _meta alongside other meta fields', async () => {
      await router.send('sender', 'agent-1', { data: 'test' }, {
        priority: 'high',
        correlationId: 'corr-123',
        _meta: { thread: 'abc' },
      })

      expect(deliveredMessages).toHaveLength(1)
      const msg = deliveredMessages[0].message
      expect(msg.meta?.priority).toBe('high')
      expect(msg.meta?.correlationId).toBe('corr-123')
      expect(msg._meta).toEqual({ thread: 'abc' })
      expect(msg.meta?._meta).toEqual({ thread: 'abc' })
    })
  })

  describe('In-process end-to-end via MeshPeer', () => {
    it('should preserve _meta through embedded MeshPeer messaging', async () => {
      const peer = MeshPeer.createEmbedded({ peerId: 'meta-test' })
      await peer.start()

      const sender = await peer.createAgent({ agentId: 'sender' })
      const receiver = await peer.createAgent({ agentId: 'receiver' })

      let receivedMessage: Message | null = null
      receiver.on('message', (msg) => {
        receivedMessage = msg
      })

      await sender.send(
        { agent: 'receiver' },
        { text: 'hello' },
        {
          priority: 'high',
          _meta: {
            subject: 'Test Subject',
            thread_tag: 'thread-1',
          },
        }
      )

      expect(receivedMessage).not.toBeNull()
      expect(receivedMessage!._meta).toEqual({
        subject: 'Test Subject',
        thread_tag: 'thread-1',
      })

      await peer.stop()
    })
  })
})

// =============================================================================
// Integration: All requirements working together
// =============================================================================

describe('Integration: Embedded MeshPeer with custom delivery and agents', () => {
  it('should support the agent-inbox use case end-to-end', async () => {
    // Create embedded peer (R1)
    const peer = MeshPeer.createEmbedded({
      peerId: 'agent-system',
      peerName: 'Agent System',
    })
    await peer.start()

    // Set up custom delivery handler (R2) — simulates agent-inbox storage
    const inboxStorage: Message[] = []
    const previousHandler = peer.server.setDeliveryHandler({
      async deliverToAgent(agentId, message) {
        // Store in inbox (agent-inbox would do threading, read tracking, etc.)
        inboxStorage.push(message)
        // Also deliver to the agent's handler for real-time notification
        return previousHandler.deliverToAgent(agentId, message)
      },
      async forwardToPeer(peerId, agentIds, message) {
        return previousHandler.forwardToPeer(peerId, agentIds, message)
      },
    })

    // Register agents programmatically (R4)
    const coordinator = await peer.createAgent({
      agentId: 'coordinator',
      name: 'Coordinator',
      role: 'coordinator',
    })

    const worker = await peer.createAgent({
      agentId: 'worker-1',
      name: 'Worker',
      role: 'worker',
      parent: 'coordinator',
    })

    // Worker receives messages
    const workerMessages: Message[] = []
    worker.on('message', (msg) => workerMessages.push(msg))

    // Send message with _meta (R5)
    await coordinator.send(
      { agent: 'worker-1' },
      { type: 'task', task: 'review PR #42' },
      {
        priority: 'high',
        _meta: {
          subject: 'Code review request',
          thread_tag: 'review-pr-42',
          importance: 'high',
        },
      }
    )

    // Verify message was stored in inbox (R2)
    expect(inboxStorage).toHaveLength(1)
    expect(inboxStorage[0].payload).toEqual({ type: 'task', task: 'review PR #42' })

    // Verify _meta was preserved (R5)
    expect(inboxStorage[0]._meta).toEqual({
      subject: 'Code review request',
      thread_tag: 'review-pr-42',
      importance: 'high',
    })

    // Verify worker also received the message in real-time (R4)
    expect(workerMessages).toHaveLength(1)

    // Verify federation API exists (R3)
    const gateway = await peer.federateWith('remote-system')
    expect(gateway).toBeInstanceOf(FederationGateway)
    expect(peer.getFederationGateways()).toHaveLength(1)

    await peer.stop()
  })
})
