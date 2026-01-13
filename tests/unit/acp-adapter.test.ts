// AcpMeshAdapter unit tests
// Implements: s-4hjr, i-5ac2

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { AcpMeshAdapter } from '../../src/acp/adapter'
import type { AcpRequest, AcpNotification, AcpMeshEnvelope } from '../../src/acp/types'
import type { PeerInfo } from '../../src/types'

// =============================================================================
// Mock Infrastructure
// =============================================================================

// Global channel registry for cross-mesh communication
const channelRegistry = new Map<string, Map<string, MockMessageChannel>>()

class MockMessageChannel extends EventEmitter {
  private _opened = false
  private channelName: string
  private mesh: MockNebulaMesh

  constructor(mesh: MockNebulaMesh, channelName: string) {
    super()
    this.mesh = mesh
    this.channelName = channelName
  }

  async open(): Promise<void> {
    this._opened = true
    if (!channelRegistry.has(this.channelName)) {
      channelRegistry.set(this.channelName, new Map())
    }
    channelRegistry.get(this.channelName)!.set(this.mesh.peerId, this)
  }

  async close(): Promise<void> {
    this._opened = false
    channelRegistry.get(this.channelName)?.delete(this.mesh.peerId)
  }

  get isOpen(): boolean {
    return this._opened
  }

  send(peerId: string, message: unknown): boolean {
    const targetChannel = channelRegistry.get(this.channelName)?.get(peerId)
    if (targetChannel) {
      const from: PeerInfo = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }
      // Check if this is a response message (for request/response correlation)
      const envelope = message as { type?: string; message?: { id?: unknown; result?: unknown; method?: unknown } }
      const innerMsg = envelope?.message
      const isResponse = innerMsg && 'id' in innerMsg && ('result' in innerMsg || 'error' in innerMsg) && !('method' in innerMsg)

      // Always emit as message for regular handlers
      setImmediate(() => targetChannel.emit('message', message, from))

      if (isResponse) {
        // Also emit as _response for request/response correlation
        setImmediate(() => targetChannel.emit('_response', message))
      }
      return true
    }
    return false
  }

  broadcast(message: unknown): void {
    const channels = channelRegistry.get(this.channelName)
    if (channels) {
      const from: PeerInfo = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }
      for (const [peerId, channel] of channels) {
        if (peerId !== this.mesh.peerId) {
          setImmediate(() => channel.emit('message', message, from))
        }
      }
    }
  }

  async request<R>(peerId: string, message: unknown, timeout?: number): Promise<R> {
    return new Promise((resolve, reject) => {
      const targetChannel = channelRegistry.get(this.channelName)?.get(peerId)
      if (!targetChannel) {
        reject(new Error('Peer not found'))
        return
      }

      const from: PeerInfo = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      // Set up one-time response listener
      const responseHandler = (response: R) => {
        clearTimeout(timer)
        resolve(response)
      }
      this.once('_response', responseHandler)

      // Set timeout
      const timer = setTimeout(() => {
        this.off('_response', responseHandler)
        reject(new Error('Request timed out'))
      }, timeout || 5000)

      // Send request to target
      setImmediate(() => targetChannel.emit('message', message, from))
    })
  }

  // Helper to simulate receiving a response (for request/response correlation)
  _simulateResponse(response: unknown): void {
    this.emit('_response', response)
  }
}

class MockNebulaMesh extends EventEmitter {
  peerId: string
  groups: string[]
  private channels: Map<string, MockMessageChannel> = new Map()

  constructor(peerId: string, groups: string[] = []) {
    super()
    this.peerId = peerId
    this.groups = groups
  }

  createChannel<T>(name: string): MockMessageChannel {
    if (this.channels.has(name)) {
      return this.channels.get(name)!
    }
    const channel = new MockMessageChannel(this, name)
    this.channels.set(name, channel)
    return channel
  }

  getSelf(): PeerInfo {
    return {
      id: this.peerId,
      groups: this.groups,
      status: 'online',
      lastSeen: new Date(),
      activeNamespaces: [],
      isHub: false,
    }
  }

  getChannel(name: string): MockMessageChannel | undefined {
    return this.channels.get(name)
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('AcpMeshAdapter', () => {
  beforeEach(() => {
    channelRegistry.clear()
  })

  afterEach(() => {
    channelRegistry.clear()
  })

  describe('lifecycle', () => {
    it('should start and stop', async () => {
      const mesh = new MockNebulaMesh('peer-a')
      const adapter = new AcpMeshAdapter(mesh as any)

      expect(adapter.started).toBe(false)
      await adapter.start()
      expect(adapter.started).toBe(true)
      await adapter.stop()
      expect(adapter.started).toBe(false)
    })

    it('should be idempotent for start/stop', async () => {
      const mesh = new MockNebulaMesh('peer-a')
      const adapter = new AcpMeshAdapter(mesh as any)

      await adapter.start()
      await adapter.start() // Should not throw
      expect(adapter.started).toBe(true)

      await adapter.stop()
      await adapter.stop() // Should not throw
      expect(adapter.started).toBe(false)
    })

    it('should use custom channel name from config', async () => {
      const mesh = new MockNebulaMesh('peer-a')
      const adapter = new AcpMeshAdapter(mesh as any, { channel: 'custom-acp' })
      await adapter.start()

      expect(channelRegistry.has('custom-acp')).toBe(true)
      expect(channelRegistry.get('custom-acp')?.has('peer-a')).toBe(true)

      await adapter.stop()
    })
  })

  describe('send', () => {
    it('should send ACP message to peer', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)

      await adapterA.start()
      await adapterB.start()

      const received: Array<{ msg: unknown; from: PeerInfo }> = []
      adapterB.onMessage((msg, from) => {
        received.push({ msg, from })
      })

      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { status: 'working' },
      }

      const success = adapterA.send('peer-b', notification)
      expect(success).toBe(true)

      // Wait for async delivery
      await new Promise((r) => setTimeout(r, 10))

      expect(received.length).toBe(1)
      expect(received[0].msg).toEqual(notification)
      expect(received[0].from.id).toBe('peer-a')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should return false when sending to offline peer', async () => {
      const mesh = new MockNebulaMesh('peer-a')
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'test',
      }

      const success = adapter.send('nonexistent-peer', notification)
      expect(success).toBe(false)

      await adapter.stop()
    })

    it('should throw if not started', () => {
      const mesh = new MockNebulaMesh('peer-a')
      const adapter = new AcpMeshAdapter(mesh as any)

      expect(() => adapter.send('peer-b', { jsonrpc: '2.0', method: 'test' })).toThrow(
        'AcpMeshAdapter is not started'
      )
    })
  })

  describe('broadcast', () => {
    it('should broadcast to all peers', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const meshC = new MockNebulaMesh('peer-c')

      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      const adapterC = new AcpMeshAdapter(meshC as any)

      await Promise.all([adapterA.start(), adapterB.start(), adapterC.start()])

      const receivedB: unknown[] = []
      const receivedC: unknown[] = []
      adapterB.onMessage((msg) => receivedB.push(msg))
      adapterC.onMessage((msg) => receivedC.push(msg))

      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'broadcast/test',
      }

      adapterA.broadcast(notification)

      await new Promise((r) => setTimeout(r, 10))

      expect(receivedB.length).toBe(1)
      expect(receivedC.length).toBe(1)
      expect(receivedB[0]).toEqual(notification)
      expect(receivedC[0]).toEqual(notification)

      await Promise.all([adapterA.stop(), adapterB.stop(), adapterC.stop()])
    })

    it('should filter broadcast by group', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['admin'])
      const meshB = new MockNebulaMesh('peer-b', ['backend'])
      const meshC = new MockNebulaMesh('peer-c', ['frontend'])

      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      const adapterC = new AcpMeshAdapter(meshC as any)

      await Promise.all([adapterA.start(), adapterB.start(), adapterC.start()])

      const receivedB: unknown[] = []
      const receivedC: unknown[] = []
      adapterB.onMessage((msg) => receivedB.push(msg))
      adapterC.onMessage((msg) => receivedC.push(msg))

      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'backend/update',
      }

      // Broadcast only to backend group
      adapterA.broadcast(notification, { kind: 'group', groups: ['backend'] })

      await new Promise((r) => setTimeout(r, 10))

      expect(receivedB.length).toBe(1) // backend receives it
      expect(receivedC.length).toBe(0) // frontend does not

      await Promise.all([adapterA.stop(), adapterB.stop(), adapterC.stop()])
    })

    it('should throw if not started', () => {
      const mesh = new MockNebulaMesh('peer-a')
      const adapter = new AcpMeshAdapter(mesh as any)

      expect(() => adapter.broadcast({ jsonrpc: '2.0', method: 'test' })).toThrow(
        'AcpMeshAdapter is not started'
      )
    })
  })

  describe('request handling', () => {
    it('should emit request event for ACP requests', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)

      await adapterA.start()
      await adapterB.start()

      const requests: Array<{ request: AcpRequest; from: PeerInfo }> = []
      adapterB.onRequest((request, from, respond) => {
        requests.push({ request, from })
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: { success: true },
        })
      })

      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: '123',
        method: 'terminal/create',
        params: { command: 'npm test' },
      }

      adapterA.send('peer-b', request)

      await new Promise((r) => setTimeout(r, 10))

      expect(requests.length).toBe(1)
      expect(requests[0].request.method).toBe('terminal/create')
      expect(requests[0].request.id).toBe('123')
      expect(requests[0].from.id).toBe('peer-a')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should send response back via respond callback', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)

      await adapterA.start()
      await adapterB.start()

      // Set up responder on B
      adapterB.onRequest((request, from, respond) => {
        respond({
          jsonrpc: '2.0',
          id: request.id,
          result: { output: 'test passed' },
        })
      })

      // Listen for response on A
      const responses: unknown[] = []
      adapterA.onMessage((msg) => responses.push(msg))

      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-456',
        method: 'terminal/create',
        params: { command: 'echo hello' },
      }

      adapterA.send('peer-b', request)

      await new Promise((r) => setTimeout(r, 20))

      expect(responses.length).toBe(1)
      expect(responses[0]).toEqual({
        jsonrpc: '2.0',
        id: 'req-456',
        result: { output: 'test passed' },
      })

      await adapterA.stop()
      await adapterB.stop()
    })
  })

  describe('message and request event separation', () => {
    it('should emit both message and request events for requests', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)

      await adapterA.start()
      await adapterB.start()

      const messages: unknown[] = []
      const requests: unknown[] = []
      adapterB.onMessage((msg) => messages.push(msg))
      adapterB.onRequest((req, from, respond) => {
        requests.push(req)
        respond({ jsonrpc: '2.0', id: req.id, result: {} })
      })

      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: '789',
        method: 'test',
      }

      adapterA.send('peer-b', request)

      await new Promise((r) => setTimeout(r, 10))

      // Both events should fire
      expect(messages.length).toBe(1)
      expect(requests.length).toBe(1)

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should only emit message event for notifications', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)

      await adapterA.start()
      await adapterB.start()

      const messages: unknown[] = []
      const requests: unknown[] = []
      adapterB.onMessage((msg) => messages.push(msg))
      adapterB.onRequest((req) => requests.push(req))

      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { status: 'done' },
      }

      adapterA.send('peer-b', notification)

      await new Promise((r) => setTimeout(r, 10))

      // Only message event should fire (notification has no id)
      expect(messages.length).toBe(1)
      expect(requests.length).toBe(0)

      await adapterA.stop()
      await adapterB.stop()
    })
  })

  describe('handler management', () => {
    it('should allow removing handlers with offMessage', async () => {
      const meshA = new MockNebulaMesh('peer-a')
      const meshB = new MockNebulaMesh('peer-b')
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)

      await adapterA.start()
      await adapterB.start()

      const received: unknown[] = []
      const handler = (msg: unknown) => received.push(msg)
      adapterB.onMessage(handler)

      // Send first message
      adapterA.send('peer-b', { jsonrpc: '2.0', method: 'first' })
      await new Promise((r) => setTimeout(r, 10))
      expect(received.length).toBe(1)

      // Remove handler
      adapterB.offMessage(handler)

      // Send second message
      adapterA.send('peer-b', { jsonrpc: '2.0', method: 'second' })
      await new Promise((r) => setTimeout(r, 10))

      // Should not receive second message
      expect(received.length).toBe(1)

      await adapterA.stop()
      await adapterB.stop()
    })
  })

  describe('observer registry', () => {
    it('should track observers for sessions', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      // Register observer
      adapter.registerObserver('peer-b', 'session-1')

      expect(adapter.getObservers('session-1')).toContain('peer-b')

      await adapter.stop()
    })

    it('should track multiple observers for a session', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      adapter.registerObserver('peer-b', 'session-1')
      adapter.registerObserver('peer-c', 'session-1')
      adapter.registerObserver('peer-d', 'session-1')

      const observers = adapter.getObservers('session-1')
      expect(observers).toContain('peer-b')
      expect(observers).toContain('peer-c')
      expect(observers).toContain('peer-d')
      expect(observers.length).toBe(3)

      await adapter.stop()
    })

    it('should track a peer observing multiple sessions', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      adapter.registerObserver('peer-b', 'session-1')
      adapter.registerObserver('peer-b', 'session-2')
      adapter.registerObserver('peer-b', 'session-3')

      expect(adapter.getObservers('session-1')).toContain('peer-b')
      expect(adapter.getObservers('session-2')).toContain('peer-b')
      expect(adapter.getObservers('session-3')).toContain('peer-b')

      await adapter.stop()
    })

    it('should remove observer on unregister', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      adapter.registerObserver('peer-b', 'session-1')
      expect(adapter.getObservers('session-1')).toContain('peer-b')

      adapter.unregisterObserver('peer-b', 'session-1')
      expect(adapter.getObservers('session-1')).not.toContain('peer-b')

      await adapter.stop()
    })

    it('should remove all observers for a peer on disconnect', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      adapter.registerObserver('peer-b', 'session-1')
      adapter.registerObserver('peer-b', 'session-2')
      adapter.registerObserver('peer-b', 'session-3')

      // Simulate peer disconnect
      adapter.handlePeerDisconnect('peer-b')

      expect(adapter.getObservers('session-1')).not.toContain('peer-b')
      expect(adapter.getObservers('session-2')).not.toContain('peer-b')
      expect(adapter.getObservers('session-3')).not.toContain('peer-b')

      await adapter.stop()
    })

    it('should not affect other peers on disconnect', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      adapter.registerObserver('peer-b', 'session-1')
      adapter.registerObserver('peer-c', 'session-1')

      adapter.handlePeerDisconnect('peer-b')

      expect(adapter.getObservers('session-1')).not.toContain('peer-b')
      expect(adapter.getObservers('session-1')).toContain('peer-c')

      await adapter.stop()
    })

    it('should return empty array for session with no observers', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      expect(adapter.getObservers('nonexistent-session')).toEqual([])

      await adapter.stop()
    })

    it('should notify observers when session ends', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      // Register peer-b as observer
      adapterA.registerObserver('peer-b', 'session-1')

      const notifications: any[] = []
      adapterB.onMessage((msg) => {
        notifications.push(msg)
      })

      // End session
      adapterA.notifySessionEnded('session-1', 'completed')

      await new Promise((r) => setTimeout(r, 50))

      expect(notifications.length).toBe(1)
      expect(notifications[0].method).toBe('session/ended')
      expect(notifications[0].params.sessionId).toBe('session-1')
      expect(notifications[0].params.reason).toBe('completed')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should cleanup observers after session ends', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      adapter.registerObserver('peer-b', 'session-1')
      adapter.registerObserver('peer-c', 'session-1')

      expect(adapter.getObservers('session-1').length).toBe(2)

      adapter.notifySessionEnded('session-1', 'cancelled')

      expect(adapter.getObservers('session-1').length).toBe(0)

      await adapter.stop()
    })

    it('should notify multiple observers when session ends', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const meshC = new MockNebulaMesh('peer-c', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      const adapterC = new AcpMeshAdapter(meshC as any)
      await Promise.all([adapterA.start(), adapterB.start(), adapterC.start()])

      adapterA.registerObserver('peer-b', 'session-1')
      adapterA.registerObserver('peer-c', 'session-1')

      const notificationsB: any[] = []
      const notificationsC: any[] = []
      adapterB.onMessage((msg) => notificationsB.push(msg))
      adapterC.onMessage((msg) => notificationsC.push(msg))

      adapterA.notifySessionEnded('session-1', 'error')

      await new Promise((r) => setTimeout(r, 50))

      expect(notificationsB.length).toBe(1)
      expect(notificationsC.length).toBe(1)
      expect(notificationsB[0].params.reason).toBe('error')
      expect(notificationsC[0].params.reason).toBe('error')

      await Promise.all([adapterA.stop(), adapterB.stop(), adapterC.stop()])
    })
  })

  describe('access control', () => {
    it('should allow access when peers share a group', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1', 'group-2'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      const peer: PeerInfo = {
        id: 'peer-b',
        groups: ['group-2', 'group-3'],
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      expect(adapter.canAccess(peer)).toBe(true)

      await adapter.stop()
    })

    it('should deny access when peers share no groups', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1', 'group-2'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      const peer: PeerInfo = {
        id: 'peer-b',
        groups: ['group-3', 'group-4'],
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      expect(adapter.canAccess(peer)).toBe(false)

      await adapter.stop()
    })

    it('should allow access when allowAllGroups is true', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any, { allowAllGroups: true })
      await adapter.start()

      const peer: PeerInfo = {
        id: 'peer-b',
        groups: ['group-99'], // No shared groups
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      expect(adapter.canAccess(peer)).toBe(true)

      await adapter.stop()
    })

    it('should deny access for peer with empty groups', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)
      await adapter.start()

      const peer: PeerInfo = {
        id: 'peer-b',
        groups: [],
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      expect(adapter.canAccess(peer)).toBe(false)

      await adapter.stop()
    })

    it('should allow access when local peer has empty groups but allowAllGroups is true', async () => {
      const mesh = new MockNebulaMesh('peer-a', [])
      const adapter = new AcpMeshAdapter(mesh as any, { allowAllGroups: true })
      await adapter.start()

      const peer: PeerInfo = {
        id: 'peer-b',
        groups: ['group-1'],
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      expect(adapter.canAccess(peer)).toBe(true)

      await adapter.stop()
    })
  })

  describe('observeSession', () => {
    it('should send observe request and register callback', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      // Setup peer-b to handle observe requests
      adapterB.onRequest((request, from, respond) => {
        if (request.method === 'session/observe') {
          const params = request.params as { sessionId: string }
          adapterB.registerObserver(from.id, params.sessionId)
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: { success: true },
          })
        }
      })

      const updates: any[] = []
      await adapterA.observeSession('peer-b', 'session-1', (update) => {
        updates.push(update)
      })

      // Verify observer was registered
      expect(adapterB.getObservers('session-1')).toContain('peer-a')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should call callback when session update received', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      adapterB.onRequest((request, from, respond) => {
        if (request.method === 'session/observe') {
          const params = request.params as { sessionId: string }
          adapterB.registerObserver(from.id, params.sessionId)
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: { success: true },
          })
        }
      })

      const updates: any[] = []
      await adapterA.observeSession('peer-b', 'session-1', (update) => {
        updates.push(update)
      })

      // Send update from peer-b
      adapterB.send('peer-a', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session-1', data: 'test-data' },
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(updates.length).toBe(1)
      expect(updates[0].params.data).toBe('test-data')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should throw if peer denies access', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['frontend'])
      const meshB = new MockNebulaMesh('peer-b', ['backend'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      adapterB.onRequest((request, from, respond) => {
        if (request.method === 'session/observe') {
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: { success: false, error: 'Access denied: no shared groups' },
          })
        }
      })

      await expect(
        adapterA.observeSession('peer-b', 'session-1', () => {})
      ).rejects.toThrow('Access denied')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should throw if adapter not started', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)

      await expect(
        adapter.observeSession('peer-b', 'session-1', () => {})
      ).rejects.toThrow('AcpMeshAdapter is not started')
    })
  })

  describe('unobserveSession', () => {
    it('should send unobserve request and remove callback', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      adapterB.onRequest((request, from, respond) => {
        const params = request.params as { sessionId: string }
        if (request.method === 'session/observe') {
          adapterB.registerObserver(from.id, params.sessionId)
          respond({ jsonrpc: '2.0', id: request.id, result: { success: true } })
        }
        if (request.method === 'session/unobserve') {
          adapterB.unregisterObserver(from.id, params.sessionId)
          respond({ jsonrpc: '2.0', id: request.id, result: { success: true } })
        }
      })

      const updates: any[] = []
      await adapterA.observeSession('peer-b', 'session-1', (update) => {
        updates.push(update)
      })

      expect(adapterB.getObservers('session-1')).toContain('peer-a')

      await adapterA.unobserveSession('peer-b', 'session-1')

      expect(adapterB.getObservers('session-1')).not.toContain('peer-a')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should stop receiving updates after unobserve', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      adapterB.onRequest((request, from, respond) => {
        const params = request.params as { sessionId: string }
        if (request.method === 'session/observe') {
          adapterB.registerObserver(from.id, params.sessionId)
          respond({ jsonrpc: '2.0', id: request.id, result: { success: true } })
        }
        if (request.method === 'session/unobserve') {
          adapterB.unregisterObserver(from.id, params.sessionId)
          respond({ jsonrpc: '2.0', id: request.id, result: { success: true } })
        }
      })

      const updates: any[] = []
      await adapterA.observeSession('peer-b', 'session-1', (update) => {
        updates.push(update)
      })

      // Send update before unobserve
      adapterB.send('peer-a', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session-1', data: 'first' },
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(updates.length).toBe(1)

      await adapterA.unobserveSession('peer-b', 'session-1')

      // Send update after unobserve
      adapterB.send('peer-a', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session-1', data: 'second' },
      })
      await new Promise((r) => setTimeout(r, 50))

      // Should not receive the second update
      expect(updates.length).toBe(1)

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should throw if adapter not started', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)

      await expect(
        adapter.unobserveSession('peer-b', 'session-1')
      ).rejects.toThrow('AcpMeshAdapter is not started')
    })
  })

  describe('listPeerSessions', () => {
    it('should return sessions from remote peer', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      adapterB.onRequest((request, from, respond) => {
        if (request.method === 'session/list') {
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              sessions: [
                { sessionId: 'session-1', mode: 'default', createdAt: '2026-01-12T00:00:00Z', active: true },
                { sessionId: 'session-2', mode: 'agent', createdAt: '2026-01-12T01:00:00Z', active: true },
              ],
            },
          })
        }
      })

      const sessions = await adapterA.listPeerSessions('peer-b')

      expect(sessions.length).toBe(2)
      expect(sessions[0].sessionId).toBe('session-1')
      expect(sessions[0].mode).toBe('default')
      expect(sessions[1].sessionId).toBe('session-2')
      expect(sessions[1].mode).toBe('agent')

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should pass includeInactive option', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      let receivedParams: any = null
      adapterB.onRequest((request, from, respond) => {
        if (request.method === 'session/list') {
          receivedParams = request.params
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: { sessions: [] },
          })
        }
      })

      await adapterA.listPeerSessions('peer-b', { includeInactive: true })

      expect(receivedParams.includeInactive).toBe(true)

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should return empty array when no sessions', async () => {
      const meshA = new MockNebulaMesh('peer-a', ['group-1'])
      const meshB = new MockNebulaMesh('peer-b', ['group-1'])
      const adapterA = new AcpMeshAdapter(meshA as any)
      const adapterB = new AcpMeshAdapter(meshB as any)
      await adapterA.start()
      await adapterB.start()

      adapterB.onRequest((request, from, respond) => {
        if (request.method === 'session/list') {
          respond({
            jsonrpc: '2.0',
            id: request.id,
            result: { sessions: [] },
          })
        }
      })

      const sessions = await adapterA.listPeerSessions('peer-b')

      expect(sessions).toEqual([])

      await adapterA.stop()
      await adapterB.stop()
    })

    it('should throw if adapter not started', async () => {
      const mesh = new MockNebulaMesh('peer-a', ['group-1'])
      const adapter = new AcpMeshAdapter(mesh as any)

      await expect(
        adapter.listPeerSessions('peer-b')
      ).rejects.toThrow('AcpMeshAdapter is not started')
    })
  })
})
