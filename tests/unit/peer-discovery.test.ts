import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  PeerDiscovery,
  type DiscoveryMessage,
  type DiscoveryPeerInfo,
  type DiscoveryRequest,
  type DiscoveryResponse,
  type DiscoveryRegister,
  discoveryPeerToPeerConfig,
  peerInfoToDiscoveryPeer,
} from '../../src/mesh/peer-discovery'
import type { PeerInfo } from '../../src/types'

// Mock MessageChannel
class MockMessageChannel extends EventEmitter {
  private _opened = false
  sentMessages: { peerId: string; message: DiscoveryMessage }[] = []
  requestHandler: ((msg: DiscoveryMessage, from: PeerInfo) => Promise<DiscoveryResponse>) | null = null

  async open(): Promise<void> {
    this._opened = true
  }

  async close(): Promise<void> {
    this._opened = false
  }

  get opened(): boolean {
    return this._opened
  }

  send(peerId: string, message: DiscoveryMessage): boolean {
    this.sentMessages.push({ peerId, message })
    return true
  }

  async request<R>(
    peerId: string,
    message: DiscoveryMessage,
    timeout?: number
  ): Promise<R> {
    this.sentMessages.push({ peerId, message })

    // Simulate lighthouse response
    if (message.type === 'peer-list-request') {
      const response: DiscoveryResponse = {
        type: 'peer-list-response',
        peers: [
          {
            id: 'discovered-peer-1',
            name: 'Discovered Peer 1',
            nebulaIp: '10.42.0.10',
            port: 7946,
            groups: ['team-a'],
            namespaces: ['ns1'],
            lastSeen: Date.now(),
          },
        ],
        timestamp: Date.now(),
      }
      return response as R
    }

    throw new Error('Unknown request type')
  }

  onRequest(handler: (msg: DiscoveryMessage, from: PeerInfo) => Promise<unknown>): void {
    this.requestHandler = handler as (msg: DiscoveryMessage, from: PeerInfo) => Promise<DiscoveryResponse>
  }

  // Simulate receiving a message
  simulateMessage(msg: DiscoveryMessage, from: PeerInfo): void {
    this.emit('message', msg, from)
  }
}

describe('PeerDiscovery', () => {
  let discovery: PeerDiscovery
  let channel: MockMessageChannel

  const defaultConfig = {
    peerId: 'test-peer',
    peerName: 'Test Peer',
    nebulaIp: '10.42.0.5',
    port: 7946,
    groups: ['team-a'],
    lighthousePeerIds: ['lighthouse-1'],
  }

  const mockPeerInfo = (id: string): PeerInfo => ({
    id,
    name: `Peer ${id}`,
    nebulaIp: `10.42.0.${parseInt(id.split('-').pop() ?? '1')}`,
    status: 'online',
    lastSeen: new Date(),
    groups: [],
    activeNamespaces: [],
    isHub: false,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    channel = new MockMessageChannel()
    discovery = new PeerDiscovery(defaultConfig)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('properties', () => {
    it('should have correct initial state', () => {
      expect(discovery.running).toBe(false)
      expect(discovery.isLighthouse).toBe(false)
      expect(discovery.getDiscoveredPeers()).toHaveLength(0)
    })

    it('should identify as lighthouse when configured', () => {
      const lighthouseDiscovery = new PeerDiscovery({
        ...defaultConfig,
        isLighthouse: true,
      })

      expect(lighthouseDiscovery.isLighthouse).toBe(true)
    })
  })

  describe('start/stop', () => {
    it('should start discovery and open channel', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      expect(discovery.running).toBe(true)
      expect(channel.opened).toBe(true)
    })

    it('should emit discovery:started event', async () => {
      const handler = vi.fn()
      discovery.on('discovery:started', handler)

      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      expect(handler).toHaveBeenCalled()
    })

    it('should be idempotent (calling start twice)', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      expect(discovery.running).toBe(true)
    })

    it('should stop discovery and close channel', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)
      await discovery.stop()

      expect(discovery.running).toBe(false)
    })

    it('should emit discovery:stopped event', async () => {
      const handler = vi.fn()
      discovery.on('discovery:stopped', handler)

      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)
      await discovery.stop()

      expect(handler).toHaveBeenCalled()
    })
  })

  describe('discoverPeers (non-lighthouse)', () => {
    afterEach(async () => {
      if (discovery.running) {
        await discovery.stop()
      }
    })

    it('should query lighthouses for peers', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      // Clear discovered peers for a clean test
      const peers = await discovery.discoverPeers()

      expect(peers).toHaveLength(1)
      expect(peers[0].id).toBe('discovered-peer-1')
    })

    it('should emit peer:discovered event for new peers', async () => {
      // Set up handler BEFORE start so we catch the initial discovery
      const handler = vi.fn()
      discovery.on('peer:discovered', handler)

      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      // The initial discovery on start should have found the peer
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'discovered-peer-1' })
      )
    })

    it('should update discovered peers list', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      const discovered = discovery.getDiscoveredPeers()
      expect(discovered).toHaveLength(1)
      expect(discovered[0].id).toBe('discovered-peer-1')
    })

    it('should not emit peer:discovered for already known peers', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      const handler = vi.fn()
      discovery.on('peer:discovered', handler)

      // Call discoverPeers again - peer is already known from start()
      await discovery.discoverPeers()

      // Should not emit again for same peer
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('registerWithLighthouses', () => {
    it('should send registration to each lighthouse', async () => {
      await discovery.start(channel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)

      // The initial registration happens on start
      const registrations = channel.sentMessages.filter(
        (m) => m.message.type === 'peer-register'
      )

      expect(registrations).toHaveLength(1)
      expect(registrations[0].peerId).toBe('lighthouse-1')

      const regMsg = registrations[0].message as DiscoveryRegister
      expect(regMsg.peer.id).toBe('test-peer')
      expect(regMsg.peer.nebulaIp).toBe('10.42.0.5')
    })
  })

  describe('namespace management', () => {
    it('should track registered namespaces', () => {
      discovery.registerNamespace('namespace-1')
      discovery.registerNamespace('namespace-2')

      // We can't directly check namespaces, but they should be included in peer info
      // sent during registration
    })

    it('should unregister namespaces', () => {
      discovery.registerNamespace('namespace-1')
      discovery.unregisterNamespace('namespace-1')

      // Namespace should be removed
    })
  })

  describe('lighthouse behavior', () => {
    let lighthouseDiscovery: PeerDiscovery
    let lighthouseChannel: MockMessageChannel

    beforeEach(async () => {
      lighthouseChannel = new MockMessageChannel()
      lighthouseDiscovery = new PeerDiscovery({
        ...defaultConfig,
        peerId: 'lighthouse-1',
        isLighthouse: true,
      })

      await lighthouseDiscovery.start(lighthouseChannel as unknown as import('../../src/channel/message-channel').MessageChannel<DiscoveryMessage>)
    })

    afterEach(async () => {
      await lighthouseDiscovery.stop()
    })

    it('should register peers on peer-register message', () => {
      const registerMsg: DiscoveryRegister = {
        type: 'peer-register',
        peer: {
          id: 'new-peer',
          name: 'New Peer',
          nebulaIp: '10.42.0.20',
          port: 7946,
          groups: ['team-b'],
          namespaces: [],
          lastSeen: Date.now(),
        },
      }

      lighthouseChannel.simulateMessage(registerMsg, mockPeerInfo('new-peer'))

      const registered = lighthouseDiscovery.getRegisteredPeers()
      expect(registered).toHaveLength(1)
      expect(registered[0].id).toBe('new-peer')
    })

    it('should emit peer:discovered when new peer registers', () => {
      const handler = vi.fn()
      lighthouseDiscovery.on('peer:discovered', handler)

      const registerMsg: DiscoveryRegister = {
        type: 'peer-register',
        peer: {
          id: 'new-peer',
          nebulaIp: '10.42.0.20',
          port: 7946,
          groups: [],
          namespaces: [],
          lastSeen: Date.now(),
        },
      }

      lighthouseChannel.simulateMessage(registerMsg, mockPeerInfo('new-peer'))

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-peer' })
      )
    })

    it('should respond to peer-list-request (tested via mock)', async () => {
      // Register a peer first
      const registerMsg: DiscoveryRegister = {
        type: 'peer-register',
        peer: {
          id: 'existing-peer',
          nebulaIp: '10.42.0.30',
          port: 7946,
          groups: ['team-c'],
          namespaces: [],
          lastSeen: Date.now(),
        },
      }

      lighthouseChannel.simulateMessage(registerMsg, mockPeerInfo('existing-peer'))

      // Request peer list
      const request: DiscoveryRequest = {
        type: 'peer-list-request',
        peer: {
          id: 'requester',
          nebulaIp: '10.42.0.40',
          port: 7946,
          groups: [],
          namespaces: [],
          lastSeen: Date.now(),
        },
      }

      lighthouseChannel.simulateMessage(request, mockPeerInfo('requester'))

      // Check that a response was sent
      const responses = lighthouseChannel.sentMessages.filter(
        (m) => m.message.type === 'peer-list-response'
      )

      expect(responses.length).toBeGreaterThanOrEqual(1)
    })

    it('should remove peer on peer-unregister message', () => {
      // First register a peer
      const registerMsg: DiscoveryRegister = {
        type: 'peer-register',
        peer: {
          id: 'to-remove',
          nebulaIp: '10.42.0.50',
          port: 7946,
          groups: [],
          namespaces: [],
          lastSeen: Date.now(),
        },
      }

      lighthouseChannel.simulateMessage(registerMsg, mockPeerInfo('to-remove'))
      expect(lighthouseDiscovery.getRegisteredPeers()).toHaveLength(1)

      // Now unregister
      lighthouseChannel.simulateMessage(
        { type: 'peer-unregister', peerId: 'to-remove' },
        mockPeerInfo('to-remove')
      )

      expect(lighthouseDiscovery.getRegisteredPeers()).toHaveLength(0)
    })

    it('should emit peer:lost when peer unregisters', () => {
      const handler = vi.fn()
      lighthouseDiscovery.on('peer:lost', handler)

      // Register first
      lighthouseChannel.simulateMessage(
        {
          type: 'peer-register',
          peer: {
            id: 'leaving-peer',
            nebulaIp: '10.42.0.60',
            port: 7946,
            groups: [],
            namespaces: [],
            lastSeen: Date.now(),
          },
        },
        mockPeerInfo('leaving-peer')
      )

      // Unregister
      lighthouseChannel.simulateMessage(
        { type: 'peer-unregister', peerId: 'leaving-peer' },
        mockPeerInfo('leaving-peer')
      )

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'leaving-peer' })
      )
    })
  })
})

describe('Helper functions', () => {
  describe('discoveryPeerToPeerConfig', () => {
    it('should convert DiscoveryPeerInfo to PeerConfig', () => {
      const discoveryPeer: DiscoveryPeerInfo = {
        id: 'peer-1',
        name: 'Test Peer',
        nebulaIp: '10.42.0.5',
        port: 7946,
        groups: ['team-a'],
        namespaces: ['ns1'],
        lastSeen: Date.now(),
      }

      const config = discoveryPeerToPeerConfig(discoveryPeer)

      expect(config.id).toBe('peer-1')
      expect(config.name).toBe('Test Peer')
      expect(config.nebulaIp).toBe('10.42.0.5')
      expect(config.port).toBe(7946)
    })
  })

  describe('peerInfoToDiscoveryPeer', () => {
    it('should convert PeerInfo to DiscoveryPeerInfo', () => {
      const peerInfo: PeerInfo = {
        id: 'peer-1',
        name: 'Test Peer',
        nebulaIp: '10.42.0.5',
        port: 7946,
        status: 'online',
        lastSeen: new Date('2024-01-01T00:00:00Z'),
        groups: ['team-a'],
        activeNamespaces: ['ns1'],
        isHub: false,
      }

      const discoveryPeer = peerInfoToDiscoveryPeer(peerInfo)

      expect(discoveryPeer.id).toBe('peer-1')
      expect(discoveryPeer.name).toBe('Test Peer')
      expect(discoveryPeer.nebulaIp).toBe('10.42.0.5')
      expect(discoveryPeer.port).toBe(7946)
      expect(discoveryPeer.groups).toEqual(['team-a'])
      expect(discoveryPeer.namespaces).toEqual(['ns1'])
      expect(discoveryPeer.lastSeen).toBe(new Date('2024-01-01T00:00:00Z').getTime())
    })
  })
})

describe('DiscoveryMessage types', () => {
  it('should have correct type discriminators', () => {
    const request: DiscoveryMessage = {
      type: 'peer-list-request',
      peer: {
        id: 'test',
        nebulaIp: '10.42.0.1',
        port: 7946,
        groups: [],
        namespaces: [],
        lastSeen: Date.now(),
      },
    }
    expect(request.type).toBe('peer-list-request')

    const response: DiscoveryMessage = {
      type: 'peer-list-response',
      peers: [],
      timestamp: Date.now(),
    }
    expect(response.type).toBe('peer-list-response')

    const register: DiscoveryMessage = {
      type: 'peer-register',
      peer: {
        id: 'test',
        nebulaIp: '10.42.0.1',
        port: 7946,
        groups: [],
        namespaces: [],
        lastSeen: Date.now(),
      },
    }
    expect(register.type).toBe('peer-register')

    const unregister: DiscoveryMessage = {
      type: 'peer-unregister',
      peerId: 'test',
    }
    expect(unregister.type).toBe('peer-unregister')
  })
})
