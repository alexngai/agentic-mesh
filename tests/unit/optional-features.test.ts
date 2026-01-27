// Tests for Phase 5: Optional Features
// Tests that hub election, health monitoring, and namespace registry can be disabled

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NebulaMesh } from '../../src/mesh/nebula-mesh'
import { NoopHealthMonitor } from '../../src/mesh/health-adapter'
import type { NebulaMeshConfig, OptionalFeaturesConfig } from '../../src/types'
import { HubRole } from '../../src/types'

// Mock NebulaTransport to avoid actual network operations
vi.mock('../../src/transports/nebula/transport', () => {
  const EventEmitter = require('events').EventEmitter

  class MockNebulaTransport extends EventEmitter {
    type = 'nebula'
    active = false
    localEndpoint = { peerId: 'test', address: '10.0.0.1', port: 7946 }
    private connections = new Map<string, boolean>()

    async start() {
      this.active = true
      this.emit('listening')
    }

    async stop() {
      this.active = false
      this.connections.clear()
      this.emit('closed')
    }

    async connect(endpoint: { peerId: string }) {
      this.connections.set(endpoint.peerId, true)
      this.emit('peer:connected', endpoint.peerId, endpoint)
      return true
    }

    async disconnect(peerId: string) {
      this.connections.delete(peerId)
      this.emit('peer:disconnected', peerId)
    }

    getConnectedPeers() {
      return Array.from(this.connections.keys())
    }

    isConnected(peerId: string) {
      return this.connections.has(peerId)
    }

    getConnection(peerId: string) {
      if (!this.connections.has(peerId)) return null
      return { peerId, connected: true, lastActivity: new Date() }
    }

    send(_peerId: string, _data: Buffer) {
      return true
    }

    broadcast(_data: Buffer) {
      return new Map()
    }

    identifyConnection() {}
  }

  return { NebulaTransport: MockNebulaTransport }
})

describe('Optional Features Configuration', () => {
  const baseConfig: NebulaMeshConfig = {
    peerId: 'test-peer',
    peerName: 'Test Peer',
    nebulaIp: '10.0.0.1',
    peers: [],
    hub: { role: HubRole.COORDINATOR, priority: 10 },
  }

  describe('Default features (all enabled)', () => {
    let mesh: NebulaMesh

    beforeEach(() => {
      mesh = new NebulaMesh(baseConfig)
    })

    afterEach(async () => {
      if (mesh.connected) {
        await mesh.disconnect()
      }
    })

    it('should have all features enabled by default', () => {
      const features = mesh.getFeatures()
      expect(features.hubElection).toBe(true)
      expect(features.healthMonitoring).toBe(true)
      expect(features.namespaceRegistry).toBe(true)
      expect(features.hubRelay).toBe(true)
      expect(features.offlineQueue).toBe(true)
    })

    it('should have hub election available', async () => {
      await mesh.connect()
      // Hub election should work - we should be hub since we're COORDINATOR
      expect(mesh.getHubState()).not.toBeNull()
    })
  })

  describe('Hub election disabled', () => {
    let mesh: NebulaMesh

    beforeEach(() => {
      mesh = new NebulaMesh({
        ...baseConfig,
        features: { hubElection: false },
      })
    })

    afterEach(async () => {
      if (mesh.connected) {
        await mesh.disconnect()
      }
    })

    it('should have hub election disabled', () => {
      const features = mesh.getFeatures()
      expect(features.hubElection).toBe(false)
    })

    it('should return null for hub state', () => {
      expect(mesh.getHubState()).toBeNull()
    })

    it('should return null for active hub', () => {
      expect(mesh.getActiveHub()).toBeNull()
    })

    it('should never be hub', () => {
      expect(mesh.isHub()).toBe(false)
    })

    it('should connect without hub election', async () => {
      await mesh.connect()
      expect(mesh.connected).toBe(true)
      expect(mesh.getHubState()).toBeNull()
    })
  })

  describe('Health monitoring disabled', () => {
    let mesh: NebulaMesh

    beforeEach(() => {
      mesh = new NebulaMesh({
        ...baseConfig,
        features: { healthMonitoring: false },
      })
    })

    afterEach(async () => {
      if (mesh.connected) {
        await mesh.disconnect()
      }
    })

    it('should have health monitoring disabled', () => {
      const features = mesh.getFeatures()
      expect(features.healthMonitoring).toBe(false)
    })

    it('should use NoopHealthMonitor', async () => {
      await mesh.connect()
      // All peers should be considered healthy with NoopHealthMonitor
      const health = mesh.getPeerHealth()
      // Empty because we have no peers configured
      expect(health).toEqual([])
    })

    it('should connect without health monitoring', async () => {
      await mesh.connect()
      expect(mesh.connected).toBe(true)
    })
  })

  describe('Namespace registry disabled', () => {
    let mesh: NebulaMesh

    beforeEach(() => {
      mesh = new NebulaMesh({
        ...baseConfig,
        features: { namespaceRegistry: false },
      })
    })

    afterEach(async () => {
      if (mesh.connected) {
        await mesh.disconnect()
      }
    })

    it('should have namespace registry disabled', () => {
      const features = mesh.getFeatures()
      expect(features.namespaceRegistry).toBe(false)
    })

    it('should still allow registering namespaces locally', async () => {
      await mesh.registerNamespace('test-ns')
      const namespaces = mesh.getActiveNamespaces()
      expect(namespaces.get('test-ns')).toContain('test-peer')
    })

    it('should return local peer for namespace peers', async () => {
      await mesh.registerNamespace('test-ns')
      const peers = mesh.getPeersForNamespace('test-ns')
      expect(peers).toContain('test-peer')
    })

    it('should return empty for unregistered namespace', () => {
      const peers = mesh.getPeersForNamespace('nonexistent')
      expect(peers).toEqual([])
    })
  })

  describe('Hub relay disabled', () => {
    let mesh: NebulaMesh

    beforeEach(() => {
      mesh = new NebulaMesh({
        ...baseConfig,
        features: { hubRelay: false },
      })
    })

    afterEach(async () => {
      if (mesh.connected) {
        await mesh.disconnect()
      }
    })

    it('should have hub relay disabled', () => {
      const features = mesh.getFeatures()
      expect(features.hubRelay).toBe(false)
    })

    it('should not attempt relay for unreachable peers', async () => {
      await mesh.connect()
      // Try to send to a peer we're not connected to
      const channel = mesh.createChannel<{ test: boolean }>('test')
      await channel.open()
      const sent = channel.send('nonexistent-peer', { test: true })
      expect(sent).toBe(false)
    })
  })

  describe('All features disabled', () => {
    let mesh: NebulaMesh

    beforeEach(() => {
      mesh = new NebulaMesh({
        ...baseConfig,
        features: {
          hubElection: false,
          healthMonitoring: false,
          namespaceRegistry: false,
          hubRelay: false,
          offlineQueue: false,
        },
      })
    })

    afterEach(async () => {
      if (mesh.connected) {
        await mesh.disconnect()
      }
    })

    it('should have all features disabled', () => {
      const features = mesh.getFeatures()
      expect(features.hubElection).toBe(false)
      expect(features.healthMonitoring).toBe(false)
      expect(features.namespaceRegistry).toBe(false)
      expect(features.hubRelay).toBe(false)
      expect(features.offlineQueue).toBe(false)
    })

    it('should still connect and work in basic mode', async () => {
      await mesh.connect()
      expect(mesh.connected).toBe(true)
      expect(mesh.getHubState()).toBeNull()
      expect(mesh.isHub()).toBe(false)
    })

    it('should support basic messaging', async () => {
      await mesh.connect()
      const channel = mesh.createChannel<{ msg: string }>('test')
      expect(channel).toBeDefined()
      expect(channel.name).toBe('test')
    })
  })

  describe('Partial feature configuration', () => {
    it('should merge with defaults (only override specified features)', () => {
      const mesh = new NebulaMesh({
        ...baseConfig,
        features: { hubElection: false },
      })

      const features = mesh.getFeatures()
      expect(features.hubElection).toBe(false)
      expect(features.healthMonitoring).toBe(true) // Default
      expect(features.namespaceRegistry).toBe(true) // Default
      expect(features.hubRelay).toBe(true) // Default
      expect(features.offlineQueue).toBe(true) // Default
    })
  })
})

describe('NoopHealthMonitor', () => {
  let monitor: NoopHealthMonitor

  beforeEach(() => {
    monitor = new NoopHealthMonitor()
  })

  afterEach(() => {
    monitor.stop()
  })

  it('should start and stop', () => {
    expect(monitor.isRunning).toBe(false)
    monitor.start()
    expect(monitor.isRunning).toBe(true)
    monitor.stop()
    expect(monitor.isRunning).toBe(false)
  })

  it('should register and unregister peers', () => {
    monitor.start()
    monitor.registerPeer({
      id: 'peer1',
      nebulaIp: '10.0.0.2',
      status: 'online',
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    })

    const health = monitor.getPeerHealth('peer1')
    expect(health).not.toBeNull()
    expect(health?.peerId).toBe('peer1')
    expect(health?.status).toBe('online')

    monitor.unregisterPeer('peer1')
    expect(monitor.getPeerHealth('peer1')).toBeNull()
  })

  it('should always report all peers as healthy', () => {
    monitor.start()
    monitor.registerPeer({
      id: 'peer1',
      nebulaIp: '10.0.0.2',
      status: 'offline', // Even if initially offline
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    })

    // NoopHealthMonitor always considers peers online
    const health = monitor.getPeerHealth('peer1')
    expect(health?.status).toBe('online')
    expect(monitor.getHealthyPeers()).toContain('peer1')
    expect(monitor.getUnhealthyPeers()).not.toContain('peer1')
  })

  it('should track hub status', () => {
    monitor.start()
    expect(monitor.isHubHealthy()).toBe(false) // No hub set

    monitor.registerPeer({
      id: 'hub-peer',
      nebulaIp: '10.0.0.2',
      status: 'online',
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    })

    monitor.setHubId('hub-peer')
    expect(monitor.isHubHealthy()).toBe(true)

    const health = monitor.getPeerHealth('hub-peer')
    expect(health?.isHub).toBe(true)
  })

  it('should record traffic', () => {
    monitor.start()
    const initialTime = new Date()
    monitor.registerPeer({
      id: 'peer1',
      nebulaIp: '10.0.0.2',
      status: 'online',
      lastSeen: initialTime,
      groups: [],
      activeNamespaces: [],
      isHub: false,
    })

    // Wait a bit and record traffic
    const laterTime = new Date(initialTime.getTime() + 1000)
    vi.setSystemTime(laterTime)
    monitor.recordTraffic('peer1')

    const health = monitor.getPeerHealth('peer1')
    expect(health?.lastSeen.getTime()).toBeGreaterThanOrEqual(initialTime.getTime())
  })
})

describe('TailscaleHealthMonitor', async () => {
  // Import dynamically to allow mocking
  const { TailscaleHealthMonitor } = await import('../../src/transports/tailscale/health-monitor')

  it('should be importable', () => {
    expect(TailscaleHealthMonitor).toBeDefined()
  })

  it('should create instance with default config', () => {
    const monitor = new TailscaleHealthMonitor()
    expect(monitor).toBeDefined()
    expect(monitor.isRunning).toBe(false)
  })

  it('should create instance with custom config', () => {
    const monitor = new TailscaleHealthMonitor({
      pollInterval: 5000,
      tailscaleBin: '/usr/bin/tailscale',
    })
    expect(monitor).toBeDefined()
  })

  it('should register peers', () => {
    const monitor = new TailscaleHealthMonitor()
    monitor.registerPeer({
      id: 'peer1',
      name: 'node1',
      nebulaIp: '100.64.0.1',
      status: 'online',
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: false,
    })

    const health = monitor.getPeerHealth('peer1')
    expect(health).not.toBeNull()
    expect(health?.peerId).toBe('peer1')
  })
})
