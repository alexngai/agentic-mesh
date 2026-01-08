import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { MessageChannel, RPCTimeoutError, RPCError } from '../../src/channel/message-channel'
import type { PeerInfo, MessageChannelConfig } from '../../src/types'

// Mock NebulaMesh for isolated testing
class MockNebulaMesh extends EventEmitter {
  private channelMap: Map<string, MessageChannel<unknown>> = new Map()
  private peerId = 'local-peer'
  private remotePeers: Map<string, MockNebulaMesh> = new Map()

  constructor(id?: string) {
    super()
    if (id) this.peerId = id
  }

  // Connect two mock meshes together
  connectTo(other: MockNebulaMesh, peerId: string): void {
    this.remotePeers.set(peerId, other)
  }

  registerChannel(name: string, channel: MessageChannel<unknown>): void {
    this.channelMap.set(name, channel)
  }

  _sendToPeer<T>(peerId: string, channelName: string, message: T): boolean {
    const remoteMesh = this.remotePeers.get(peerId)
    if (!remoteMesh) return false

    const channel = remoteMesh.channelMap.get(channelName)
    if (!channel) return false

    // Simulate async delivery
    const peer: PeerInfo = {
      id: this.peerId,
      nebulaIp: '127.0.0.1',
      status: 'online',
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    }

    setImmediate(() => channel._receiveMessage(message, peer))
    return true
  }

  _sendRpc<T>(
    peerId: string,
    channelName: string,
    message: T,
    type: 'request' | 'response',
    requestId: string
  ): boolean {
    const remoteMesh = this.remotePeers.get(peerId)
    if (!remoteMesh) return false

    const channel = remoteMesh.channelMap.get(channelName)
    if (!channel) return false

    const peer: PeerInfo = {
      id: this.peerId,
      nebulaIp: '127.0.0.1',
      status: 'online',
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    }

    setImmediate(() => {
      if (type === 'request') {
        channel._receiveRequest(message, peer, requestId)
      } else {
        channel._receiveResponse(message, peer, requestId)
      }
    })
    return true
  }

  _broadcast<T>(channelName: string, message: T): void {
    // Not needed for RPC tests
  }

  _getPeerId(): string {
    return this.peerId
  }
}

describe('MessageChannel RPC', () => {
  let meshA: MockNebulaMesh
  let meshB: MockNebulaMesh
  let channelA: MessageChannel<{ type: string; data?: unknown }>
  let channelB: MessageChannel<{ type: string; data?: unknown }>

  beforeEach(async () => {
    meshA = new MockNebulaMesh('peer-a')
    meshB = new MockNebulaMesh('peer-b')

    // Connect meshes bidirectionally
    meshA.connectTo(meshB, 'peer-b')
    meshB.connectTo(meshA, 'peer-a')

    // Create channels
    channelA = new MessageChannel(meshA as any, 'test-channel')
    channelB = new MessageChannel(meshB as any, 'test-channel')

    // Register channels with their meshes
    meshA.registerChannel('test-channel', channelA as MessageChannel<unknown>)
    meshB.registerChannel('test-channel', channelB as MessageChannel<unknown>)

    await channelA.open()
    await channelB.open()
  })

  afterEach(async () => {
    await channelA.close()
    await channelB.close()
  })

  describe('request/response', () => {
    it('should send request and receive response', async () => {
      // Set up handler on B
      channelB.onRequest(async (msg) => {
        expect(msg.type).toBe('ping')
        return { type: 'pong', data: 'received' }
      })

      // Send request from A to B
      const response = await channelA.request<{ type: string; data: string }>(
        'peer-b',
        { type: 'ping' },
        5000
      )

      expect(response.type).toBe('pong')
      expect(response.data).toBe('received')
    })

    it('should pass peer info to handler', async () => {
      let receivedFrom: PeerInfo | null = null

      channelB.onRequest(async (msg, from) => {
        receivedFrom = from
        return { type: 'ack' }
      })

      await channelA.request('peer-b', { type: 'test' }, 5000)

      expect(receivedFrom).not.toBeNull()
      expect(receivedFrom!.id).toBe('peer-a')
    })

    it('should handle multiple concurrent requests', async () => {
      let requestCount = 0

      channelB.onRequest(async (msg) => {
        requestCount++
        // Small delay to simulate work
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { type: 'response', data: msg.data }
      })

      // Send 3 concurrent requests
      const promises = [
        channelA.request('peer-b', { type: 'req', data: 1 }, 5000),
        channelA.request('peer-b', { type: 'req', data: 2 }, 5000),
        channelA.request('peer-b', { type: 'req', data: 3 }, 5000),
      ]

      const responses = await Promise.all(promises)

      expect(requestCount).toBe(3)
      expect(responses).toHaveLength(3)
      expect(responses.map((r: any) => r.data).sort()).toEqual([1, 2, 3])
    })
  })

  describe('timeout', () => {
    it('should timeout when handler takes too long', async () => {
      // Handler that takes longer than timeout
      channelB.onRequest(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return { type: 'response' }
      })

      await expect(
        channelA.request('peer-b', { type: 'ping' }, 50)
      ).rejects.toThrow(RPCTimeoutError)
    })

    it('should include timeout duration in error', async () => {
      // Handler that never responds within timeout
      channelB.onRequest(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return { type: 'response' }
      })

      try {
        await channelA.request('peer-b', { type: 'ping' }, 50)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RPCTimeoutError)
        expect((err as RPCTimeoutError).timeout).toBe(50)
      }
    })
  })

  describe('error handling', () => {
    it('should propagate handler errors to requester', async () => {
      channelB.onRequest(async () => {
        throw new Error('Handler failed')
      })

      await expect(channelA.request('peer-b', { type: 'test' }, 5000)).rejects.toThrow(
        RPCError
      )
    })

    it('should include original error message', async () => {
      channelB.onRequest(async () => {
        throw new Error('Specific failure reason')
      })

      try {
        await channelA.request('peer-b', { type: 'test' }, 5000)
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(RPCError)
        expect((err as RPCError).message).toContain('Specific failure reason')
      }
    })

    it('should reject when peer is not connected', async () => {
      await expect(
        channelA.request('non-existent-peer', { type: 'test' }, 5000)
      ).rejects.toThrow('Failed to send request')
    })

    it('should reject when channel is not open', async () => {
      await channelA.close()

      await expect(channelA.request('peer-b', { type: 'test' }, 5000)).rejects.toThrow(
        'not open'
      )
    })

    it('should return error when no handler is registered', async () => {
      // B has no handler registered
      await expect(channelA.request('peer-b', { type: 'test' }, 5000)).rejects.toThrow(
        RPCError
      )
    })
  })

  describe('handler management', () => {
    it('should register request handler', () => {
      expect(channelA.hasRequestHandler()).toBe(false)

      channelA.onRequest(async () => ({ type: 'response' }))

      expect(channelA.hasRequestHandler()).toBe(true)
    })

    it('should unregister request handler', () => {
      channelA.onRequest(async () => ({ type: 'response' }))
      expect(channelA.hasRequestHandler()).toBe(true)

      channelA.offRequest()

      expect(channelA.hasRequestHandler()).toBe(false)
    })

    it('should replace existing handler', async () => {
      let handlerVersion = 0

      channelB.onRequest(async () => {
        handlerVersion = 1
        return { type: 'v1' }
      })

      channelB.onRequest(async () => {
        handlerVersion = 2
        return { type: 'v2' }
      })

      const response = await channelA.request<{ type: string }>('peer-b', { type: 'test' }, 5000)

      expect(handlerVersion).toBe(2)
      expect(response.type).toBe('v2')
    })
  })

  describe('channel close cleanup', () => {
    it('should reject pending requests when channel closes', async () => {
      // No handler - request will be pending
      const requestPromise = channelA.request('peer-b', { type: 'test' }, 30000)

      // Close channel while request is pending
      await channelA.close()

      await expect(requestPromise).rejects.toThrow('closed')
    })

    it('should clear handler on close', async () => {
      channelA.onRequest(async () => ({ type: 'response' }))
      expect(channelA.hasRequestHandler()).toBe(true)

      await channelA.close()

      expect(channelA.hasRequestHandler()).toBe(false)
    })
  })

  describe('stats', () => {
    it('should count request messages in stats', async () => {
      channelB.onRequest(async () => ({ type: 'pong' }))

      await channelA.request('peer-b', { type: 'ping' }, 5000)

      const statsA = channelA.getStats()
      const statsB = channelB.getStats()

      // A sent request, received response
      expect(statsA.messagesSent).toBeGreaterThanOrEqual(1)

      // B received request, sent response
      expect(statsB.messagesReceived).toBeGreaterThanOrEqual(1)
      expect(statsB.messagesSent).toBeGreaterThanOrEqual(1)
    })
  })

  describe('permission enforcement with RPC', () => {
    it('should reject RPC requests when sender lacks permission', async () => {
      // Create a channel with required groups
      const restrictedChannel = new MessageChannel(
        meshB as any,
        'restricted-channel',
        { requiredGroups: ['admin'] } as MessageChannelConfig
      )
      meshB.registerChannel('restricted-channel', restrictedChannel as MessageChannel<unknown>)
      await restrictedChannel.open()

      // Create client channel (without admin group)
      const clientChannel = new MessageChannel(meshA as any, 'restricted-channel')
      meshA.registerChannel('restricted-channel', clientChannel as MessageChannel<unknown>)
      await clientChannel.open()

      // Register handler on restricted channel
      restrictedChannel.onRequest(async () => ({ type: 'secret-data' }))

      // Request should be rejected due to permission
      await expect(clientChannel.request('peer-b', { type: 'get-secret' }, 5000)).rejects.toThrow(
        RPCError
      )

      await restrictedChannel.close()
      await clientChannel.close()
    })
  })
})
