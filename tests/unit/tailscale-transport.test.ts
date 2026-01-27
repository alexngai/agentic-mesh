// Tests for TailscaleTransport

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TailscaleTransport, TailscaleCLI } from '../../src/transports/tailscale'
import * as net from 'net'

describe('TailscaleTransport', () => {
  let transport: TailscaleTransport

  // Helper to setup CLI mocks on transport instance
  function mockCLI(transport: TailscaleTransport) {
    const cli = transport.getCLI()
    vi.spyOn(cli, 'isConnected').mockResolvedValue(true)
    vi.spyOn(cli, 'getBackendState').mockResolvedValue('Running')
    // Use localhost for testing since Tailscale IPs aren't available
    vi.spyOn(cli, 'getLocalIP').mockResolvedValue('127.0.0.1')
    vi.spyOn(cli, 'getStatus').mockResolvedValue({
      BackendState: 'Running',
      Self: {
        PublicKey: 'abc123',
        TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
        DNSName: 'test-node.tailnet.ts.net',
        HostName: 'test-node',
        OS: 'linux',
        UserID: 12345,
      },
      Peer: {},
      MagicDNSEnabled: true,
    })
    vi.spyOn(cli, 'getPeers').mockResolvedValue([])
    vi.spyOn(cli, 'getOnlinePeers').mockResolvedValue([])
    vi.spyOn(cli, 'ping').mockResolvedValue(10)

    return cli
  }

  beforeEach(() => {
    // Use a random high port to avoid conflicts
    const port = 17946 + Math.floor(Math.random() * 1000)
    transport = new TailscaleTransport({
      port,
    })
    mockCLI(transport)
  })

  afterEach(async () => {
    if (transport?.active) {
      await transport.stop()
    }
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create transport with default port', () => {
      const t = new TailscaleTransport({})
      expect(t.type).toBe('tailscale')
      expect(t.getConfig().port).toBe(7946)
    })

    it('should create transport with custom port', () => {
      const t = new TailscaleTransport({ port: 8000 })
      expect(t.getConfig().port).toBe(8000)
    })

    it('should create transport with custom timeout', () => {
      const t = new TailscaleTransport({ connectionTimeout: 5000 })
      expect(t.getConfig().connectionTimeout).toBe(5000)
    })
  })

  describe('start/stop lifecycle', () => {
    it('should start and become active', async () => {
      expect(transport.active).toBe(false)

      const listeningPromise = new Promise<void>((resolve) => {
        transport.on('listening', resolve)
      })

      await transport.start()
      await listeningPromise

      expect(transport.active).toBe(true)
    })

    it('should not start if already active', async () => {
      await transport.start()
      await transport.start() // Should be idempotent
      expect(transport.active).toBe(true)
    })

    it('should stop and become inactive', async () => {
      await transport.start()
      expect(transport.active).toBe(true)

      const closedPromise = new Promise<void>((resolve) => {
        transport.on('closed', resolve)
      })

      await transport.stop()
      await closedPromise

      expect(transport.active).toBe(false)
    })

    it('should not stop if already inactive', async () => {
      await transport.stop() // Should be idempotent
      expect(transport.active).toBe(false)
    })

    it('should throw if Tailscale is not connected', async () => {
      const newTransport = new TailscaleTransport({ port: 18999 })
      const cli = newTransport.getCLI()
      vi.spyOn(cli, 'isConnected').mockResolvedValue(false)
      vi.spyOn(cli, 'getBackendState').mockResolvedValue('NeedsLogin')

      await expect(newTransport.start()).rejects.toThrow(
        "Tailscale is not connected (state: NeedsLogin). Run 'tailscale up' first."
      )
    })
  })

  describe('localEndpoint', () => {
    it('should return local endpoint after start', async () => {
      await transport.start()

      const endpoint = transport.localEndpoint
      expect(endpoint.address).toBe('127.0.0.1')
      expect(endpoint.port).toBe(transport.getConfig().port)
      expect(endpoint.peerId).toBe('') // Peer ID managed by mesh layer
    })

    it('should return fallback address before start', () => {
      const endpoint = transport.localEndpoint
      expect(endpoint.address).toBe('0.0.0.0')
    })
  })

  describe('connection management', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should throw when connecting if not active', async () => {
      await transport.stop()
      await expect(
        transport.connect({ peerId: 'peer-1', address: '127.0.0.1', port: 7946 })
      ).rejects.toThrow('Transport not active')
    })

    it('should return true if already connected', async () => {
      // Create a mock connection
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      const result = await transport.connect({
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })
      expect(result).toBe(true)

      mockSocket.destroy()
    })

    it('should return false on connection failure without error event', async () => {
      let errorEmitted = false
      transport.on('error', () => {
        errorEmitted = true
      })

      // Try to connect to a port that doesn't exist
      const result = await transport.connect({
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 59999,
      })

      expect(result).toBe(false)
      expect(errorEmitted).toBe(false)
    })

    it('should track connected peers', async () => {
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      expect(transport.isConnected('peer-1')).toBe(true)
      expect(transport.isConnected('peer-2')).toBe(false)
      expect(transport.getConnectedPeers()).toEqual(['peer-1'])

      mockSocket.destroy()
    })

    it('should disconnect peer', async () => {
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      expect(transport.isConnected('peer-1')).toBe(true)

      await transport.disconnect('peer-1')

      expect(transport.isConnected('peer-1')).toBe(false)
    })

    it('should handle disconnect for non-existent peer', async () => {
      await transport.disconnect('non-existent')
      // Should not throw
    })

    it('should get connection info', async () => {
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      const info = transport.getConnection('peer-1')
      expect(info).not.toBeNull()
      expect(info!.peerId).toBe('peer-1')
      expect(info!.connected).toBe(true)
      expect(info!.handle).toBe(mockSocket)

      expect(transport.getConnection('peer-2')).toBeNull()

      mockSocket.destroy()
    })
  })

  describe('messaging', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should return false when sending to unknown peer', () => {
      const result = transport.send('unknown', Buffer.from('test'))
      expect(result).toBe(false)
    })

    it('should return false when sending to destroyed socket', () => {
      const mockSocket = new net.Socket()
      mockSocket.destroy()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      const result = transport.send('peer-1', Buffer.from('test'))
      expect(result).toBe(false)
    })

    it('should broadcast to all connected peers', () => {
      const mockSocket1 = new net.Socket()
      const mockSocket2 = new net.Socket()

      // Mock write to prevent actual socket operations
      vi.spyOn(mockSocket1, 'write').mockImplementation(() => true)
      vi.spyOn(mockSocket2, 'write').mockImplementation(() => true)

      transport.registerConnection('peer-1', mockSocket1, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })
      transport.registerConnection('peer-2', mockSocket2, {
        peerId: 'peer-2',
        address: '127.0.0.1',
        port: 7947,
      })

      const results = transport.broadcast(Buffer.from('test'))

      expect(results.get('peer-1')).toBe(true)
      expect(results.get('peer-2')).toBe(true)

      mockSocket1.destroy()
      mockSocket2.destroy()
    })
  })

  describe('registerConnection', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should register connection and emit event', async () => {
      const connectedPromise = new Promise<[string, any]>((resolve) => {
        transport.on('peer:connected', (peerId, endpoint) => {
          resolve([peerId, endpoint])
        })
      })

      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      const [peerId, endpoint] = await connectedPromise
      expect(peerId).toBe('peer-1')
      expect(endpoint.address).toBe('127.0.0.1')

      mockSocket.destroy()
    })

    it('should replace existing connection', async () => {
      const oldSocket = new net.Socket()
      const newSocket = new net.Socket()

      transport.registerConnection('peer-1', oldSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      transport.registerConnection('peer-1', newSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      expect(transport.getSocket('peer-1')).toBe(newSocket)

      newSocket.destroy()
    })
  })

  describe('identifyConnection', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should update temp connection to real peer ID', async () => {
      const mockSocket = new net.Socket()
      const tempId = 'incoming:127.0.0.1:54321'

      // First register with temp ID
      transport.registerConnection(tempId, mockSocket, {
        peerId: tempId,
        address: '127.0.0.1',
        port: 54321,
      })

      expect(transport.isConnected(tempId)).toBe(true)

      // Now identify with real peer ID
      transport.identifyConnection(tempId, 'peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      expect(transport.isConnected(tempId)).toBe(false)
      expect(transport.isConnected('peer-1')).toBe(true)

      mockSocket.destroy()
    })
  })

  describe('socket events', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should emit data event on socket data', async () => {
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      const dataPromise = new Promise<[string, Buffer]>((resolve) => {
        transport.on('data', (peerId, data) => {
          resolve([peerId, data])
        })
      })

      // Simulate socket receiving data
      mockSocket.emit('data', Buffer.from('test message'))

      const [peerId, data] = await dataPromise
      expect(peerId).toBe('peer-1')
      expect(data.toString()).toBe('test message')

      mockSocket.destroy()
    })

    it('should emit peer:disconnected on socket close', async () => {
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      const disconnectPromise = new Promise<[string, string]>((resolve) => {
        transport.on('peer:disconnected', (peerId, reason) => {
          resolve([peerId, reason])
        })
      })

      // Simulate socket close
      mockSocket.emit('close')

      const [peerId, reason] = await disconnectPromise
      expect(peerId).toBe('peer-1')
      expect(reason).toBe('connection closed')
    })

    it('should not emit disconnect for incoming unidentified connections', async () => {
      const mockSocket = new net.Socket()
      const tempId = 'incoming:127.0.0.1:54321'

      transport.registerConnection(tempId, mockSocket, {
        peerId: tempId,
        address: '127.0.0.1',
        port: 54321,
      })

      let disconnectEmitted = false
      transport.on('peer:disconnected', () => {
        disconnectEmitted = true
      })

      mockSocket.emit('close')

      // Give it a moment to potentially emit
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(disconnectEmitted).toBe(false)
    })
  })

  describe('Tailscale-specific methods', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should return CLI instance', () => {
      const cli = transport.getCLI()
      expect(cli).toBeDefined()
    })

    it('should get Tailscale peers', async () => {
      const cli = transport.getCLI()
      vi.spyOn(cli, 'getPeers').mockResolvedValue([
        {
          hostname: 'peer-1',
          dnsName: 'peer-1.tailnet.ts.net',
          ipv4: '100.64.0.2',
          online: true,
          tags: [],
          direct: true,
        },
      ])

      const peers = await transport.getTailscalePeers()
      expect(peers).toHaveLength(1)
      expect(peers[0].hostname).toBe('peer-1')
    })

    it('should get online Tailscale peers', async () => {
      const cli = transport.getCLI()
      vi.spyOn(cli, 'getOnlinePeers').mockResolvedValue([
        {
          hostname: 'peer-1',
          dnsName: 'peer-1.tailnet.ts.net',
          ipv4: '100.64.0.2',
          online: true,
          tags: [],
          direct: true,
        },
      ])

      const peers = await transport.getOnlineTailscalePeers()
      expect(peers).toHaveLength(1)
      expect(peers[0].online).toBe(true)
    })

    it('should ping peer', async () => {
      const latency = await transport.pingPeer('peer-1')
      expect(latency).toBe(10)
    })
  })

  describe('getSocket', () => {
    beforeEach(async () => {
      await transport.start()
    })

    it('should return socket for connected peer', () => {
      const mockSocket = new net.Socket()
      transport.registerConnection('peer-1', mockSocket, {
        peerId: 'peer-1',
        address: '127.0.0.1',
        port: 7946,
      })

      expect(transport.getSocket('peer-1')).toBe(mockSocket)
      expect(transport.getSocket('peer-2')).toBeNull()

      mockSocket.destroy()
    })
  })
})

describe('TailscaleCLI', () => {
  it('should be exported from the module', () => {
    expect(TailscaleCLI).toBeDefined()
  })
})
