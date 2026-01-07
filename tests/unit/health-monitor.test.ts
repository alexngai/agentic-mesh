import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HealthMonitor } from '../../src/mesh/health-monitor'
import type { PeerInfo } from '../../src/types'

describe('HealthMonitor', () => {
  let monitor: HealthMonitor
  let pingFn: ReturnType<typeof vi.fn>

  const createPeer = (id: string, status: 'online' | 'offline' = 'online'): PeerInfo => ({
    id,
    nebulaIp: `10.0.0.${id}`,
    status,
    lastSeen: new Date(),
    groups: [],
    activeNamespaces: [],
    isHub: false,
  })

  beforeEach(() => {
    vi.useFakeTimers()
    pingFn = vi.fn()
    monitor = new HealthMonitor({
      heartbeatInterval: 1000, // 1 second for tests
      suspectThreshold: 2,
      offlineThreshold: 3,
    })
  })

  afterEach(() => {
    monitor.stop()
    vi.useRealTimers()
  })

  describe('lifecycle', () => {
    it('should start and stop correctly', () => {
      expect(monitor.isRunning).toBe(false)
      monitor.start(pingFn)
      expect(monitor.isRunning).toBe(true)
      monitor.stop()
      expect(monitor.isRunning).toBe(false)
    })

    it('should emit started event when started', () => {
      const startedHandler = vi.fn()
      monitor.on('started', startedHandler)
      monitor.start(pingFn)
      expect(startedHandler).toHaveBeenCalled()
    })

    it('should emit stopped event when stopped', () => {
      const stoppedHandler = vi.fn()
      monitor.on('stopped', stoppedHandler)
      monitor.start(pingFn)
      monitor.stop()
      expect(stoppedHandler).toHaveBeenCalled()
    })

    it('should not start twice', () => {
      const startedHandler = vi.fn()
      monitor.on('started', startedHandler)
      monitor.start(pingFn)
      monitor.start(pingFn)
      expect(startedHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('peer registration', () => {
    it('should register a peer', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      const health = monitor.getPeerHealth('1')
      expect(health).not.toBeNull()
      expect(health?.peerId).toBe('1')
      expect(health?.status).toBe('online')
    })

    it('should unregister a peer', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.unregisterPeer('1')
      const health = monitor.getPeerHealth('1')
      expect(health).toBeNull()
    })

    it('should update hub ID', () => {
      const peer1 = createPeer('1')
      const peer2 = createPeer('2')
      monitor.registerPeer(peer1)
      monitor.registerPeer(peer2)

      monitor.setHubId('1')
      expect(monitor.getPeerHealth('1')?.isHub).toBe(true)
      expect(monitor.getPeerHealth('2')?.isHub).toBe(false)

      monitor.setHubId('2')
      expect(monitor.getPeerHealth('1')?.isHub).toBe(false)
      expect(monitor.getPeerHealth('2')?.isHub).toBe(true)
    })
  })

  describe('traffic recording', () => {
    it('should record traffic and update lastSeen', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      const initialLastSeen = monitor.getPeerHealth('1')!.lastSeen

      vi.advanceTimersByTime(500)
      monitor.recordTraffic('1')

      const health = monitor.getPeerHealth('1')
      expect(health!.lastSeen.getTime()).toBeGreaterThan(initialLastSeen.getTime())
    })

    it('should transition peer from offline to online on traffic', () => {
      const peer = createPeer('1', 'offline')
      monitor.registerPeer(peer)

      const healthChangedHandler = vi.fn()
      monitor.on('health:changed', healthChangedHandler)

      monitor.recordTraffic('1')

      expect(healthChangedHandler).toHaveBeenCalledWith({
        peerId: '1',
        previousStatus: 'offline',
        newStatus: 'online',
        missedHeartbeats: 0,
      })
    })

    it('should reset missed heartbeats on traffic', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      // Advance time to create missed heartbeats
      vi.advanceTimersByTime(1500)
      expect(monitor.getPeerHealth('1')?.missedHeartbeats).toBe(1)

      // Record traffic should reset
      monitor.recordTraffic('1')
      expect(monitor.getPeerHealth('1')?.missedHeartbeats).toBe(0)
    })
  })

  describe('health checking', () => {
    it('should send ping after suspect threshold', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      // Advance past suspect threshold (2 heartbeats = 2000ms)
      vi.advanceTimersByTime(2500)

      expect(pingFn).toHaveBeenCalledWith('1')
    })

    it('should emit peer:suspect event', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      const suspectHandler = vi.fn()
      monitor.on('peer:suspect', suspectHandler)

      // Advance past suspect threshold
      vi.advanceTimersByTime(2500)

      expect(suspectHandler).toHaveBeenCalledWith({
        peerId: '1',
        missedHeartbeats: 2,
        lastSeen: expect.any(Date),
      })
    })

    it('should mark peer offline after offline threshold', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      const healthChangedHandler = vi.fn()
      monitor.on('health:changed', healthChangedHandler)

      // Advance past offline threshold (3 heartbeats = 3000ms)
      vi.advanceTimersByTime(3500)

      expect(healthChangedHandler).toHaveBeenCalledWith({
        peerId: '1',
        previousStatus: 'online',
        newStatus: 'offline',
        missedHeartbeats: 3,
      })

      expect(monitor.getPeerHealth('1')?.status).toBe('offline')
    })

    it('should emit hub:unhealthy when hub goes offline', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.setHubId('1')
      monitor.start(pingFn)

      const hubUnhealthyHandler = vi.fn()
      monitor.on('hub:unhealthy', hubUnhealthyHandler)

      // Advance past offline threshold
      vi.advanceTimersByTime(3500)

      expect(hubUnhealthyHandler).toHaveBeenCalledWith('1')
    })

    it('should not emit duplicate offline events', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      const healthChangedHandler = vi.fn()
      monitor.on('health:changed', healthChangedHandler)

      // Advance multiple times past offline threshold
      vi.advanceTimersByTime(3500)
      vi.advanceTimersByTime(1000)
      vi.advanceTimersByTime(1000)

      // Should only emit once
      const offlineEvents = healthChangedHandler.mock.calls.filter(
        (call) => call[0].newStatus === 'offline'
      )
      expect(offlineEvents).toHaveLength(1)
    })
  })

  describe('pong handling', () => {
    it('should record pong and update health', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      // Advance to trigger missed heartbeats
      vi.advanceTimersByTime(2500)
      expect(monitor.getPeerHealth('1')?.missedHeartbeats).toBe(2)

      // Record pong should reset
      monitor.recordPong('1')
      expect(monitor.getPeerHealth('1')?.missedHeartbeats).toBe(0)
    })
  })

  describe('health queries', () => {
    it('should get all peer health', () => {
      monitor.registerPeer(createPeer('1'))
      monitor.registerPeer(createPeer('2'))
      monitor.registerPeer(createPeer('3'))

      const allHealth = monitor.getAllPeerHealth()
      expect(allHealth).toHaveLength(3)
    })

    it('should get healthy peers', () => {
      monitor.registerPeer(createPeer('1'))
      monitor.registerPeer(createPeer('2', 'offline'))
      monitor.registerPeer(createPeer('3'))

      const healthy = monitor.getHealthyPeers()
      expect(healthy).toHaveLength(2)
      expect(healthy).toContain('1')
      expect(healthy).toContain('3')
      expect(healthy).not.toContain('2')
    })

    it('should get unhealthy peers', () => {
      monitor.registerPeer(createPeer('1'))
      monitor.registerPeer(createPeer('2', 'offline'))
      monitor.registerPeer(createPeer('3'))

      const unhealthy = monitor.getUnhealthyPeers()
      expect(unhealthy).toHaveLength(1)
      expect(unhealthy).toContain('2')
    })

    it('should check hub health', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.setHubId('1')

      expect(monitor.isHubHealthy()).toBe(true)

      // Mark offline
      const health = monitor.getPeerHealth('1')!
      health.status = 'offline'
      expect(monitor.isHubHealthy()).toBe(false)
    })

    it('should return false for hub health if no hub', () => {
      expect(monitor.isHubHealthy()).toBe(false)
    })
  })

  describe('peer recovery', () => {
    it('should transition peer back to online when traffic resumes', () => {
      const peer = createPeer('1')
      monitor.registerPeer(peer)
      monitor.start(pingFn)

      const healthChangedHandler = vi.fn()
      monitor.on('health:changed', healthChangedHandler)

      // Let peer go offline
      vi.advanceTimersByTime(3500)
      expect(monitor.getPeerHealth('1')?.status).toBe('offline')

      // Simulate traffic resuming
      monitor.recordTraffic('1')
      expect(monitor.getPeerHealth('1')?.status).toBe('online')

      // Should have received 2 health changes (online -> offline, offline -> online)
      expect(healthChangedHandler).toHaveBeenCalledTimes(2)
      expect(healthChangedHandler).toHaveBeenLastCalledWith({
        peerId: '1',
        previousStatus: 'offline',
        newStatus: 'online',
        missedHeartbeats: 0,
      })
    })
  })

  describe('multiple peers', () => {
    it('should track health independently for each peer', () => {
      monitor.registerPeer(createPeer('1'))
      monitor.registerPeer(createPeer('2'))
      monitor.start(pingFn)

      // Peer 1 sends traffic, peer 2 doesn't
      vi.advanceTimersByTime(1500)
      monitor.recordTraffic('1')

      vi.advanceTimersByTime(2000)

      // Peer 1 should still be healthy (traffic at 1500ms)
      // Peer 2 should be offline (no traffic for 3500ms)
      expect(monitor.getPeerHealth('1')?.status).toBe('online')
      expect(monitor.getPeerHealth('2')?.status).toBe('offline')
    })
  })
})
