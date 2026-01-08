// Tests for Hub Offline Queue Coordination (Phase 9.2)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NebulaMesh } from '../../src/mesh/nebula-mesh'
import { HubRole, RelayMessage } from '../../src/types'

describe('Hub Offline Queue Coordination', () => {
  let hubMesh: NebulaMesh

  beforeEach(() => {
    // Create a hub mesh
    hubMesh = new NebulaMesh({
      peerId: 'hub',
      nebulaIp: '192.168.100.1',
      port: 7946,
      peers: [
        { id: 'peer-a', nebulaIp: '192.168.100.2' },
        { id: 'peer-b', nebulaIp: '192.168.100.3' },
      ],
      hub: {
        role: HubRole.ADMIN,
        priority: 100,
      },
    })
  })

  describe('Hub queue initialization', () => {
    it('should initialize hub queue when becoming hub', () => {
      // Simulate hub election
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: null,
        current: 'hub',
      })

      // Queue should now exist
      expect((hubMesh as any).hubOfflineQueue).not.toBeNull()
    })

    it('should cleanup hub queue when stopping being hub', () => {
      // First become hub
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: null,
        current: 'hub',
      })

      expect((hubMesh as any).hubOfflineQueue).not.toBeNull()

      // Then stop being hub
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: 'hub',
        current: 'other-peer',
      })

      expect((hubMesh as any).hubOfflineQueue).toBeNull()
    })
  })

  describe('Queue operations', () => {
    beforeEach(() => {
      // Make this node the hub
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: null,
        current: 'hub',
      })
      // Mock isHub to return true
      vi.spyOn(hubMesh, 'isHub').mockReturnValue(true)
    })

    it('should queue relay message when target is offline', () => {
      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      // peer-b is not connected
      ;(hubMesh as any).handleRelayRequest(relayMsg)

      // Check stats
      const stats = hubMesh.getRelayStats()
      expect(stats.messagesQueuedForRelay).toBe(1)
      expect(stats.relayFailures).toBe(0)

      // Check queue
      const queueStats = hubMesh.getHubQueueStats()
      expect(queueStats).not.toBeNull()
      expect(queueStats!.total).toBe(1)
    })

    it('should emit relay:queued event when queuing', () => {
      const queuedHandler = vi.fn()
      hubMesh.on('relay:queued', queuedHandler)

      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg)

      expect(queuedHandler).toHaveBeenCalledWith({
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
      })
    })

    it('should forward directly when target is connected', () => {
      // Create a mock socket
      const mockSocket = {
        destroyed: false,
        write: vi.fn(),
      }
      ;(hubMesh as any).connections.set('peer-b', mockSocket)

      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg)

      // Should forward, not queue
      expect(mockSocket.write).toHaveBeenCalled()
      expect(hubMesh.getRelayStats().messagesRelayed).toBe(1)
      expect(hubMesh.getRelayStats().messagesQueuedForRelay).toBe(0)
    })
  })

  describe('Queue flush on peer rejoin', () => {
    beforeEach(() => {
      // Make this node the hub
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: null,
        current: 'hub',
      })
      vi.spyOn(hubMesh, 'isHub').mockReturnValue(true)
    })

    it('should flush queued messages when peer rejoins', () => {
      // Queue messages for peer-b
      const relayMsg1: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test1' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      const relayMsg2: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test2' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg1)
      ;(hubMesh as any).handleRelayRequest(relayMsg2)

      expect(hubMesh.getHubQueueStats()!.total).toBe(2)

      // Now peer-b connects
      const mockSocket = {
        destroyed: false,
        write: vi.fn(),
      }
      ;(hubMesh as any).connections.set('peer-b', mockSocket)

      // Flush queued messages
      ;(hubMesh as any).flushQueuedRelayMessages('peer-b')

      // Should have written both messages
      expect(mockSocket.write).toHaveBeenCalledTimes(2)

      // Queue should be empty
      expect(hubMesh.getHubQueueStats()!.total).toBe(0)
    })

    it('should emit relay:flushed event after flush', () => {
      const flushedHandler = vi.fn()
      hubMesh.on('relay:flushed', flushedHandler)

      // Queue a message for peer-b
      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg)

      // Connect peer-b and flush
      const mockSocket = {
        destroyed: false,
        write: vi.fn(),
      }
      ;(hubMesh as any).connections.set('peer-b', mockSocket)
      ;(hubMesh as any).flushQueuedRelayMessages('peer-b')

      expect(flushedHandler).toHaveBeenCalledWith({
        peerId: 'peer-b',
        count: 1,
      })
    })

    it('should not flush messages for other peers', () => {
      // Queue messages for peer-b
      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'test-channel',
        payload: { data: 'test' },
        messageType: 'message',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg)

      // peer-c connects (not peer-b)
      const mockSocket = {
        destroyed: false,
        write: vi.fn(),
      }
      ;(hubMesh as any).connections.set('peer-c', mockSocket)
      ;(hubMesh as any).flushQueuedRelayMessages('peer-c')

      // Should not write anything (no messages for peer-c)
      expect(mockSocket.write).not.toHaveBeenCalled()

      // Queue should still have the message for peer-b
      expect(hubMesh.getHubQueueStats()!.total).toBe(1)
    })

    it('should do nothing if not hub', () => {
      // Mock isHub to return false
      vi.spyOn(hubMesh, 'isHub').mockReturnValue(false)

      const mockSocket = {
        destroyed: false,
        write: vi.fn(),
      }
      ;(hubMesh as any).connections.set('peer-b', mockSocket)

      // This should do nothing
      ;(hubMesh as any).flushQueuedRelayMessages('peer-b')

      expect(mockSocket.write).not.toHaveBeenCalled()
    })
  })

  describe('getHubQueueStats', () => {
    it('should return null when not hub', () => {
      expect(hubMesh.getHubQueueStats()).toBeNull()
    })

    it('should return stats when hub', () => {
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: null,
        current: 'hub',
      })

      const stats = hubMesh.getHubQueueStats()
      expect(stats).not.toBeNull()
      expect(stats!.total).toBe(0)
    })
  })

  describe('RPC message queuing', () => {
    beforeEach(() => {
      ;(hubMesh as any).hubElection.emit('hub:changed', {
        previous: null,
        current: 'hub',
      })
      vi.spyOn(hubMesh, 'isHub').mockReturnValue(true)
    })

    it('should queue RPC requests for offline peers', () => {
      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'rpc-channel',
        payload: { method: 'doSomething' },
        messageType: 'request',
        requestId: 'req-123',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg)

      const stats = hubMesh.getRelayStats()
      expect(stats.messagesQueuedForRelay).toBe(1)
    })

    it('should preserve requestId when flushing RPC requests', () => {
      const relayMsg: RelayMessage = {
        type: 'relay',
        from: 'peer-a',
        to: 'peer-b',
        channel: 'rpc-channel',
        payload: { method: 'doSomething' },
        messageType: 'request',
        requestId: 'req-123',
        timestamp: Date.now(),
      }

      ;(hubMesh as any).handleRelayRequest(relayMsg)

      // Connect peer-b and flush
      const mockSocket = {
        destroyed: false,
        write: vi.fn(),
      }
      ;(hubMesh as any).connections.set('peer-b', mockSocket)
      ;(hubMesh as any).flushQueuedRelayMessages('peer-b')

      // Check that requestId was preserved
      expect(mockSocket.write).toHaveBeenCalledTimes(1)
      const writtenData = mockSocket.write.mock.calls[0][0]
      const msg = JSON.parse(writtenData.replace('\n', ''))
      expect(msg.requestId).toBe('req-123')
      expect(msg.messageType).toBe('request')
    })
  })
})
