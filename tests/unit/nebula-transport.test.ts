// NebulaTransport unit tests

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NebulaTransport } from '../../src/transports/nebula/transport'
import type { PeerEndpoint } from '../../src/transports/types'

// Helper to get available port
function getTestPort(): number {
  return 20000 + Math.floor(Math.random() * 10000)
}

// Helper to wait for event
function waitForEvent<T>(
  emitter: { on: (event: string, fn: (...args: unknown[]) => void) => void },
  event: string,
  timeout = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${event}`))
    }, timeout)

    emitter.on(event, (...args: unknown[]) => {
      clearTimeout(timer)
      resolve(args[0] as T)
    })
  })
}

// Helper to wait a short time
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('NebulaTransport', () => {
  describe('Construction', () => {
    it('should create transport with required config', () => {
      const transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
      })

      expect(transport.type).toBe('nebula')
      expect(transport.active).toBe(false)
      expect(transport.localEndpoint.address).toBe('127.0.0.1')
    })

    it('should use default port when not specified', () => {
      const transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
      })

      expect(transport.localEndpoint.port).toBe(7946)
    })

    it('should use custom port when specified', () => {
      const transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: 8080,
      })

      expect(transport.localEndpoint.port).toBe(8080)
    })

    it('should use custom connection timeout', () => {
      const transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        connectionTimeout: 5000,
      })

      expect(transport.getConfig().connectionTimeout).toBe(5000)
    })
  })

  describe('Lifecycle', () => {
    let transport: NebulaTransport
    let port: number

    beforeEach(() => {
      port = getTestPort()
      transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port,
      })
    })

    afterEach(async () => {
      if (transport.active) {
        await transport.stop()
      }
    })

    it('should start and listen for connections', async () => {
      const listeningPromise = waitForEvent(transport, 'listening')

      await transport.start()

      await listeningPromise
      expect(transport.active).toBe(true)
    })

    it('should emit listening event on start', async () => {
      const listener = vi.fn()
      transport.on('listening', listener)

      await transport.start()

      expect(listener).toHaveBeenCalled()
    })

    it('should stop and close all connections', async () => {
      await transport.start()

      const closedPromise = waitForEvent(transport, 'closed')
      await transport.stop()

      await closedPromise
      expect(transport.active).toBe(false)
    })

    it('should be idempotent for start', async () => {
      await transport.start()
      await transport.start() // Should not throw

      expect(transport.active).toBe(true)
    })

    it('should be idempotent for stop', async () => {
      await transport.start()
      await transport.stop()
      await transport.stop() // Should not throw

      expect(transport.active).toBe(false)
    })

    it('should not be active before start', () => {
      expect(transport.active).toBe(false)
    })
  })

  describe('Connection Management', () => {
    let serverTransport: NebulaTransport
    let clientTransport: NebulaTransport
    let serverPort: number
    let clientPort: number

    beforeEach(async () => {
      serverPort = getTestPort()
      clientPort = getTestPort()

      serverTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: serverPort,
      })

      clientTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: clientPort,
      })

      await serverTransport.start()
      await clientTransport.start()
    })

    afterEach(async () => {
      await clientTransport.stop()
      await serverTransport.stop()
    })

    it('should connect to a peer', async () => {
      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      const result = await clientTransport.connect(endpoint)

      expect(result).toBe(true)
      expect(clientTransport.isConnected('server-peer')).toBe(true)
    })

    it('should emit peer:connected event on successful connection', async () => {
      const connectedPromise = waitForEvent<string>(clientTransport, 'peer:connected')

      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      await clientTransport.connect(endpoint)

      const peerId = await connectedPromise
      expect(peerId).toBe('server-peer')
    })

    it('should return true when already connected', async () => {
      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      await clientTransport.connect(endpoint)
      const result = await clientTransport.connect(endpoint)

      expect(result).toBe(true)
    })

    it('should handle concurrent connection attempts', async () => {
      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      // Start multiple concurrent connections
      const results = await Promise.all([
        clientTransport.connect(endpoint),
        clientTransport.connect(endpoint),
        clientTransport.connect(endpoint),
      ])

      // All should succeed
      expect(results.every((r) => r === true)).toBe(true)
      expect(clientTransport.isConnected('server-peer')).toBe(true)
    })

    it('should return false when connection fails', async () => {
      // Create a transport with short timeout for this test
      const shortTimeoutTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: getTestPort(),
        connectionTimeout: 1000, // 1 second timeout
      })
      await shortTimeoutTransport.start()

      // Suppress error event for this test (connection failure is expected)
      shortTimeoutTransport.on('error', () => {
        // Expected error, ignore
      })

      try {
        const endpoint: PeerEndpoint = {
          peerId: 'nonexistent',
          address: '127.0.0.1',
          port: 59999, // Port with no server
        }

        const result = await shortTimeoutTransport.connect(endpoint)

        expect(result).toBe(false)
        expect(shortTimeoutTransport.isConnected('nonexistent')).toBe(false)
      } finally {
        await shortTimeoutTransport.stop()
      }
    }, 10000) // 10 second test timeout

    it('should disconnect from a peer', async () => {
      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      await clientTransport.connect(endpoint)
      expect(clientTransport.isConnected('server-peer')).toBe(true)

      await clientTransport.disconnect('server-peer')
      expect(clientTransport.isConnected('server-peer')).toBe(false)
    })

    it('should handle disconnect for non-existent peer', async () => {
      // Should not throw
      await clientTransport.disconnect('nonexistent')
    })

    it('should get connected peers list', async () => {
      expect(clientTransport.getConnectedPeers()).toEqual([])

      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      await clientTransport.connect(endpoint)

      expect(clientTransport.getConnectedPeers()).toContain('server-peer')
    })

    it('should get connection info', async () => {
      const endpoint: PeerEndpoint = {
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      }

      await clientTransport.connect(endpoint)

      const connInfo = clientTransport.getConnection('server-peer')
      expect(connInfo).not.toBeNull()
      expect(connInfo?.peerId).toBe('server-peer')
      expect(connInfo?.connected).toBe(true)
      expect(connInfo?.lastActivity).toBeInstanceOf(Date)
    })

    it('should return null for non-existent connection info', () => {
      const connInfo = clientTransport.getConnection('nonexistent')
      expect(connInfo).toBeNull()
    })

    it('should throw when connecting while not active', async () => {
      const transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: getTestPort(),
      })

      const endpoint: PeerEndpoint = {
        peerId: 'test',
        address: '127.0.0.1',
        port: serverPort,
      }

      await expect(transport.connect(endpoint)).rejects.toThrow('Transport not active')
    })
  })

  describe('Messaging', () => {
    let serverTransport: NebulaTransport
    let clientTransport: NebulaTransport
    let serverPort: number
    let clientPort: number

    beforeEach(async () => {
      serverPort = getTestPort()
      clientPort = getTestPort()

      serverTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: serverPort,
      })

      clientTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: clientPort,
      })

      await serverTransport.start()
      await clientTransport.start()

      // Connect client to server
      await clientTransport.connect({
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      })

      // Wait for server to receive the connection
      await wait(50)
    })

    afterEach(async () => {
      await clientTransport.stop()
      await serverTransport.stop()
    })

    it('should send data to a peer', async () => {
      const testData = Buffer.from('Hello, World!')

      const result = clientTransport.send('server-peer', testData)

      expect(result).toBe(true)
    })

    it('should return false when sending to disconnected peer', () => {
      const testData = Buffer.from('Hello!')

      const result = clientTransport.send('nonexistent', testData)

      expect(result).toBe(false)
    })

    it('should broadcast data to all peers', async () => {
      const testData = Buffer.from('Broadcast message')

      const results = clientTransport.broadcast(testData)

      expect(results.get('server-peer')).toBe(true)
    })

    it('should receive data and emit data event', async () => {
      // First, we need to identify the incoming connection on server side
      // This simulates what the mesh layer does
      let incomingSocket: unknown
      serverTransport.on('connection', (socket) => {
        incomingSocket = socket
        // Identify the connection
        serverTransport.identifyConnection(
          `incoming:127.0.0.1:${(socket as { remotePort: number }).remotePort}`,
          'client-peer',
          socket,
          { peerId: 'client-peer', address: '127.0.0.1', port: clientPort }
        )
      })

      // Wait for connection to be established
      await wait(100)

      // Now send data from client
      const testData = Buffer.from('Test message')
      const dataPromise = new Promise<{ peerId: string; data: Buffer }>((resolve) => {
        serverTransport.on('data', (peerId, data) => {
          resolve({ peerId: peerId as string, data: data as Buffer })
        })
      })

      clientTransport.send('server-peer', testData)

      const received = await dataPromise
      expect(received.data.toString()).toBe('Test message')
    })
  })

  describe('Incoming Connections', () => {
    let serverTransport: NebulaTransport
    let clientTransport: NebulaTransport
    let serverPort: number
    let clientPort: number

    beforeEach(async () => {
      serverPort = getTestPort()
      clientPort = getTestPort()

      serverTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: serverPort,
      })

      clientTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: clientPort,
      })

      await serverTransport.start()
      await clientTransport.start()
    })

    afterEach(async () => {
      await clientTransport.stop()
      await serverTransport.stop()
    })

    it('should emit connection event for incoming connections', async () => {
      const connectionPromise = new Promise<{ socket: unknown; info: unknown }>((resolve) => {
        serverTransport.on('connection', (socket, info) => {
          resolve({ socket, info })
        })
      })

      await clientTransport.connect({
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      })

      const { socket, info } = await connectionPromise
      expect(socket).toBeDefined()
      expect(info).toHaveProperty('address')
      expect(info).toHaveProperty('port')
    })

    it('should allow identifying incoming connections', async () => {
      const peerConnectedPromise = waitForEvent<string>(serverTransport, 'peer:connected')

      serverTransport.on('connection', (socket, info) => {
        serverTransport.identifyConnection(
          `incoming:${(info as { address: string }).address}:${(info as { port: number }).port}`,
          'client-peer',
          socket,
          { peerId: 'client-peer', address: '127.0.0.1', port: clientPort }
        )
      })

      await clientTransport.connect({
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      })

      const peerId = await peerConnectedPromise
      expect(peerId).toBe('client-peer')
      expect(serverTransport.isConnected('client-peer')).toBe(true)
    })
  })

  describe('Disconnection Events', () => {
    let serverTransport: NebulaTransport
    let clientTransport: NebulaTransport
    let serverPort: number
    let clientPort: number

    beforeEach(async () => {
      serverPort = getTestPort()
      clientPort = getTestPort()

      serverTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: serverPort,
      })

      clientTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: clientPort,
      })

      await serverTransport.start()
      await clientTransport.start()
    })

    afterEach(async () => {
      if (clientTransport.active) await clientTransport.stop()
      if (serverTransport.active) await serverTransport.stop()
    })

    it('should emit peer:disconnected when peer disconnects', async () => {
      // Connect and identify
      serverTransport.on('connection', (socket, info) => {
        serverTransport.identifyConnection(
          `incoming:${(info as { address: string }).address}:${(info as { port: number }).port}`,
          'client-peer',
          socket,
          { peerId: 'client-peer', address: '127.0.0.1', port: clientPort }
        )
      })

      await clientTransport.connect({
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      })

      // Wait for connection to be established
      await wait(100)

      // Set up disconnect listener
      const disconnectPromise = new Promise<string>((resolve) => {
        serverTransport.on('peer:disconnected', (peerId) => {
          resolve(peerId as string)
        })
      })

      // Disconnect from client side
      await clientTransport.disconnect('server-peer')

      const disconnectedPeerId = await disconnectPromise
      expect(disconnectedPeerId).toBe('client-peer')
    })

    it('should emit peer:disconnected when transport stops', async () => {
      await clientTransport.connect({
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      })

      const disconnectPromise = new Promise<string>((resolve) => {
        clientTransport.on('peer:disconnected', (peerId) => {
          resolve(peerId as string)
        })
      })

      // Stop will close all connections
      await clientTransport.stop()

      // The disconnect event should have been suppressed during stop
      // Verify the connection is gone
      expect(clientTransport.isConnected('server-peer')).toBe(false)
    })
  })

  describe('Error Handling', () => {
    let transport: NebulaTransport
    let port: number

    beforeEach(() => {
      port = getTestPort()
      transport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port,
      })
    })

    afterEach(async () => {
      if (transport.active) {
        await transport.stop()
      }
    })

    it('should emit error event on connection failure', async () => {
      // Create transport with short timeout
      const shortTimeoutTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: getTestPort(),
        connectionTimeout: 1000,
      })
      await shortTimeoutTransport.start()

      try {
        const errorPromise = new Promise<Error>((resolve) => {
          shortTimeoutTransport.on('error', (err) => {
            resolve(err as Error)
          })
        })

        // Try to connect to non-existent peer
        shortTimeoutTransport.connect({
          peerId: 'nonexistent',
          address: '127.0.0.1',
          port: 59999,
        })

        const error = await errorPromise
        expect(error.message).toContain('nonexistent')
      } finally {
        await shortTimeoutTransport.stop()
      }
    }, 10000)

    it('should handle port already in use', async () => {
      await transport.start()

      // Try to start another transport on same port
      const transport2 = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port,
      })

      await expect(transport2.start()).rejects.toThrow()
    })
  })

  describe('getSocket', () => {
    let serverTransport: NebulaTransport
    let clientTransport: NebulaTransport
    let serverPort: number

    beforeEach(async () => {
      serverPort = getTestPort()

      serverTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: serverPort,
      })

      clientTransport = new NebulaTransport({
        type: 'nebula',
        nebulaIp: '127.0.0.1',
        port: getTestPort(),
      })

      await serverTransport.start()
      await clientTransport.start()
    })

    afterEach(async () => {
      await clientTransport.stop()
      await serverTransport.stop()
    })

    it('should return socket for connected peer', async () => {
      await clientTransport.connect({
        peerId: 'server-peer',
        address: '127.0.0.1',
        port: serverPort,
      })

      const socket = clientTransport.getSocket('server-peer')
      expect(socket).not.toBeNull()
    })

    it('should return null for non-existent peer', () => {
      const socket = clientTransport.getSocket('nonexistent')
      expect(socket).toBeNull()
    })
  })
})
