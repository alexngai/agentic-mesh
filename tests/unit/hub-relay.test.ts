// Tests for Hub Relay - Message relay for NAT-blocked peers
// Tests: i-6u12

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// Mock types
interface MockPeerInfo {
  id: string
  name?: string
  nebulaIp: string
  status: string
  lastSeen: Date
  groups: string[]
  activeNamespaces: string[]
  isHub: boolean
}

interface RelayMessage {
  type: 'relay'
  from: string
  to: string
  channel: string
  payload: unknown
  messageType: 'message' | 'request' | 'response'
  requestId?: string
  timestamp: number
}

// Create a simplified mock for testing relay logic
class MockHubRelay extends EventEmitter {
  private isHubPeer: boolean
  private hubId: string | null
  private connections: Map<string, { write: (data: string) => void; destroyed: boolean }>
  private peers: Map<string, MockPeerInfo>
  private channels: Map<string, { _receiveMessage: Function; _receiveRequest: Function; _receiveResponse: Function }>
  private relayStats = {
    messagesRelayed: 0,
    relayRequestsReceived: 0,
    relayFailures: 0,
    messagesQueuedForRelay: 0,
  }
  private peerId: string

  constructor(config: { peerId: string; isHub: boolean; hubId?: string }) {
    super()
    this.peerId = config.peerId
    this.isHubPeer = config.isHub
    this.hubId = config.hubId ?? null
    this.connections = new Map()
    this.peers = new Map()
    this.channels = new Map()
  }

  isHub(): boolean {
    return this.isHubPeer
  }

  setHub(hubId: string | null): void {
    this.hubId = hubId
  }

  addConnection(peerId: string, socket: { write: (data: string) => void; destroyed: boolean }): void {
    this.connections.set(peerId, socket)
  }

  addPeer(peer: MockPeerInfo): void {
    this.peers.set(peer.id, peer)
  }

  addChannel(name: string, channel: { _receiveMessage: Function; _receiveRequest: Function; _receiveResponse: Function }): void {
    this.channels.set(name, channel)
  }

  // Simulate trying to relay a message
  tryRelay<T>(
    peerId: string,
    channelName: string,
    message: T,
    messageType: 'message' | 'request' | 'response',
    requestId?: string
  ): boolean {
    // Can't relay if we are the hub
    if (this.isHubPeer) {
      return false
    }

    // Get the hub
    if (!this.hubId) {
      return false
    }

    const hubSocket = this.connections.get(this.hubId)
    if (!hubSocket || hubSocket.destroyed) {
      return false
    }

    // Send relay request to hub
    const relayMsg: RelayMessage = {
      type: 'relay',
      from: this.peerId,
      to: peerId,
      channel: channelName,
      payload: message,
      messageType,
      requestId,
      timestamp: Date.now(),
    }

    hubSocket.write(JSON.stringify(relayMsg) + '\n')
    this.emit('relay:sent', { to: peerId, channel: channelName, via: this.hubId })
    return true
  }

  // Handle relay request (hub-side)
  handleRelayRequest<T>(msg: RelayMessage): void {
    this.relayStats.relayRequestsReceived++

    const targetSocket = this.connections.get(msg.to)
    if (!targetSocket || targetSocket.destroyed) {
      this.relayStats.relayFailures++
      this.emit('relay:failed', {
        from: msg.from,
        to: msg.to,
        reason: 'target_offline',
      })
      return
    }

    const relayedMsg = {
      type: 'relayed',
      originalFrom: msg.from,
      channel: msg.channel,
      payload: msg.payload,
      messageType: msg.messageType,
      requestId: msg.requestId,
      timestamp: msg.timestamp,
    }

    targetSocket.write(JSON.stringify(relayedMsg) + '\n')
    this.relayStats.messagesRelayed++
    this.emit('relay:forwarded', {
      from: msg.from,
      to: msg.to,
      channel: msg.channel,
    })
  }

  // Handle relayed message (peer-side)
  handleRelayedMessage(fromPeerId: string, msg: any): void {
    // Verify it came from the hub
    if (fromPeerId !== this.hubId) {
      console.warn('Received relayed message from non-hub peer, ignoring')
      return
    }

    let originalPeer = this.peers.get(msg.originalFrom)
    if (!originalPeer) {
      originalPeer = {
        id: msg.originalFrom,
        nebulaIp: 'relayed',
        status: 'online',
        lastSeen: new Date(),
        groups: [],
        activeNamespaces: [],
        isHub: false,
      }
    }

    const channel = this.channels.get(msg.channel)
    if (!channel) {
      return
    }

    if (msg.messageType === 'message') {
      channel._receiveMessage(msg.payload, originalPeer)
    } else if (msg.messageType === 'request' && msg.requestId) {
      channel._receiveRequest(msg.payload, originalPeer, msg.requestId)
    } else if (msg.messageType === 'response' && msg.requestId) {
      channel._receiveResponse(msg.payload, originalPeer, msg.requestId)
    }

    this.emit('relay:received', {
      from: msg.originalFrom,
      channel: msg.channel,
      via: fromPeerId,
    })
  }

  getRelayStats() {
    return { ...this.relayStats }
  }

  resetRelayStats(): void {
    this.relayStats = {
      messagesRelayed: 0,
      relayRequestsReceived: 0,
      relayFailures: 0,
      messagesQueuedForRelay: 0,
    }
  }
}

describe('Hub Relay', () => {
  describe('tryRelay', () => {
    it('should not relay if peer is the hub', () => {
      const mesh = new MockHubRelay({ peerId: 'hub', isHub: true })

      const result = mesh.tryRelay('peer-b', 'test-channel', { data: 'test' }, 'message')

      expect(result).toBe(false)
    })

    it('should not relay if no hub is elected', () => {
      const mesh = new MockHubRelay({ peerId: 'peer-a', isHub: false, hubId: undefined })

      const result = mesh.tryRelay('peer-b', 'test-channel', { data: 'test' }, 'message')

      expect(result).toBe(false)
    })

    it('should not relay if hub connection is unavailable', () => {
      const mesh = new MockHubRelay({ peerId: 'peer-a', isHub: false, hubId: 'hub' })
      // No connection to hub added

      const result = mesh.tryRelay('peer-b', 'test-channel', { data: 'test' }, 'message')

      expect(result).toBe(false)
    })

    it('should send relay request to hub when direct connection fails', () => {
      const mesh = new MockHubRelay({ peerId: 'peer-a', isHub: false, hubId: 'hub' })
      const writeMock = vi.fn()
      mesh.addConnection('hub', { write: writeMock, destroyed: false })

      const result = mesh.tryRelay('peer-b', 'test-channel', { data: 'test' }, 'message')

      expect(result).toBe(true)
      expect(writeMock).toHaveBeenCalled()

      const sentData = JSON.parse(writeMock.mock.calls[0][0].replace('\n', ''))
      expect(sentData.type).toBe('relay')
      expect(sentData.from).toBe('peer-a')
      expect(sentData.to).toBe('peer-b')
      expect(sentData.channel).toBe('test-channel')
      expect(sentData.payload).toEqual({ data: 'test' })
      expect(sentData.messageType).toBe('message')
    })

    it('should emit relay:sent event on successful relay request', () => {
      const mesh = new MockHubRelay({ peerId: 'peer-a', isHub: false, hubId: 'hub' })
      mesh.addConnection('hub', { write: vi.fn(), destroyed: false })

      const handler = vi.fn()
      mesh.on('relay:sent', handler)

      mesh.tryRelay('peer-b', 'test-channel', { data: 'test' }, 'message')

      expect(handler).toHaveBeenCalledWith({
        to: 'peer-b',
        channel: 'test-channel',
        via: 'hub',
      })
    })

    it('should include requestId for RPC messages', () => {
      const mesh = new MockHubRelay({ peerId: 'peer-a', isHub: false, hubId: 'hub' })
      const writeMock = vi.fn()
      mesh.addConnection('hub', { write: writeMock, destroyed: false })

      mesh.tryRelay('peer-b', 'test-channel', { data: 'request' }, 'request', 'req-123')

      const sentData = JSON.parse(writeMock.mock.calls[0][0].replace('\n', ''))
      expect(sentData.messageType).toBe('request')
      expect(sentData.requestId).toBe('req-123')
    })
  })

  describe('handleRelayRequest (Hub-side)', () => {
    it('should forward message to target peer', () => {
      const hub = new MockHubRelay({ peerId: 'hub', isHub: true })
      const writeMock = vi.fn()
      hub.addConnection('peer-b', { write: writeMock, destroyed: false })

      hub.handleRelayRequest({
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(writeMock).toHaveBeenCalled()
      const sentData = JSON.parse(writeMock.mock.calls[0][0].replace('\n', ''))
      expect(sentData.type).toBe('relayed')
      expect(sentData.originalFrom).toBe('peer-a')
      expect(sentData.channel).toBe('test-channel')
      expect(sentData.payload).toEqual({ data: 'test' })
    })

    it('should track relay stats', () => {
      const hub = new MockHubRelay({ peerId: 'hub', isHub: true })
      hub.addConnection('peer-b', { write: vi.fn(), destroyed: false })

      hub.handleRelayRequest({
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      const stats = hub.getRelayStats()
      expect(stats.relayRequestsReceived).toBe(1)
      expect(stats.messagesRelayed).toBe(1)
    })

    it('should emit relay:forwarded event', () => {
      const hub = new MockHubRelay({ peerId: 'hub', isHub: true })
      hub.addConnection('peer-b', { write: vi.fn(), destroyed: false })

      const handler = vi.fn()
      hub.on('relay:forwarded', handler)

      hub.handleRelayRequest({
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledWith({
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
      })
    })

    it('should track failure when target is offline', () => {
      const hub = new MockHubRelay({ peerId: 'hub', isHub: true })
      // No connection to peer-b

      hub.handleRelayRequest({
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      const stats = hub.getRelayStats()
      expect(stats.relayRequestsReceived).toBe(1)
      expect(stats.relayFailures).toBe(1)
      expect(stats.messagesRelayed).toBe(0)
    })

    it('should emit relay:failed event when target is offline', () => {
      const hub = new MockHubRelay({ peerId: 'hub', isHub: true })

      const handler = vi.fn()
      hub.on('relay:failed', handler)

      hub.handleRelayRequest({
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledWith({
        from: 'peer-a',
        to: 'peer-b',
        reason: 'target_offline',
      })
    })
  })

  describe('handleRelayedMessage (Peer-side)', () => {
    it('should deliver message to channel', () => {
      const peer = new MockHubRelay({ peerId: 'peer-b', isHub: false, hubId: 'hub' })
      const receiveMessageMock = vi.fn()
      peer.addChannel('test-channel', {
        _receiveMessage: receiveMessageMock,
        _receiveRequest: vi.fn(),
        _receiveResponse: vi.fn(),
      })

      peer.handleRelayedMessage('hub', {
        type: 'relayed',
        originalFrom: 'peer-a',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(receiveMessageMock).toHaveBeenCalled()
      expect(receiveMessageMock.mock.calls[0][0]).toEqual({ data: 'test' })
      expect(receiveMessageMock.mock.calls[0][1].id).toBe('peer-a')
    })

    it('should reject relayed messages from non-hub', () => {
      const peer = new MockHubRelay({ peerId: 'peer-b', isHub: false, hubId: 'hub' })
      const receiveMessageMock = vi.fn()
      peer.addChannel('test-channel', {
        _receiveMessage: receiveMessageMock,
        _receiveRequest: vi.fn(),
        _receiveResponse: vi.fn(),
      })

      // Message claims to be relayed but came from a non-hub peer
      peer.handleRelayedMessage('malicious-peer', {
        type: 'relayed',
        originalFrom: 'peer-a',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(receiveMessageMock).not.toHaveBeenCalled()
    })

    it('should handle RPC request relay', () => {
      const peer = new MockHubRelay({ peerId: 'peer-b', isHub: false, hubId: 'hub' })
      const receiveRequestMock = vi.fn()
      peer.addChannel('test-channel', {
        _receiveMessage: vi.fn(),
        _receiveRequest: receiveRequestMock,
        _receiveResponse: vi.fn(),
      })

      peer.handleRelayedMessage('hub', {
        type: 'relayed',
        originalFrom: 'peer-a',
        channel: 'test-channel',
        payload: { method: 'getData' },
        messageType: 'request',
        requestId: 'req-123',
        timestamp: Date.now(),
      })

      expect(receiveRequestMock).toHaveBeenCalled()
      expect(receiveRequestMock.mock.calls[0][2]).toBe('req-123')
    })

    it('should handle RPC response relay', () => {
      const peer = new MockHubRelay({ peerId: 'peer-b', isHub: false, hubId: 'hub' })
      const receiveResponseMock = vi.fn()
      peer.addChannel('test-channel', {
        _receiveMessage: vi.fn(),
        _receiveRequest: vi.fn(),
        _receiveResponse: receiveResponseMock,
      })

      peer.handleRelayedMessage('hub', {
        type: 'relayed',
        originalFrom: 'peer-a',
        channel: 'test-channel',
        payload: { result: 'success' },
        messageType: 'response',
        requestId: 'req-123',
        timestamp: Date.now(),
      })

      expect(receiveResponseMock).toHaveBeenCalled()
      expect(receiveResponseMock.mock.calls[0][2]).toBe('req-123')
    })

    it('should emit relay:received event', () => {
      const peer = new MockHubRelay({ peerId: 'peer-b', isHub: false, hubId: 'hub' })
      peer.addChannel('test-channel', {
        _receiveMessage: vi.fn(),
        _receiveRequest: vi.fn(),
        _receiveResponse: vi.fn(),
      })

      const handler = vi.fn()
      peer.on('relay:received', handler)

      peer.handleRelayedMessage('hub', {
        type: 'relayed',
        originalFrom: 'peer-a',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(handler).toHaveBeenCalledWith({
        from: 'peer-a',
        channel: 'test-channel',
        via: 'hub',
      })
    })
  })

  describe('Relay Stats', () => {
    it('should reset stats', () => {
      const hub = new MockHubRelay({ peerId: 'hub', isHub: true })
      hub.addConnection('peer-b', { write: vi.fn(), destroyed: false })

      // Generate some stats
      hub.handleRelayRequest({
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      })

      expect(hub.getRelayStats().messagesRelayed).toBe(1)

      hub.resetRelayStats()

      const stats = hub.getRelayStats()
      expect(stats.messagesRelayed).toBe(0)
      expect(stats.relayRequestsReceived).toBe(0)
      expect(stats.relayFailures).toBe(0)
    })
  })
})
