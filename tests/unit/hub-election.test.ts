import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HubElection } from '../../src/mesh/hub-election'
import { HubRole, PeerInfo } from '../../src/types'

function createPeer(
  id: string,
  role: HubRole,
  priority = 0,
  status: 'online' | 'offline' = 'online'
): PeerInfo {
  return {
    id,
    nebulaIp: '10.0.0.1',
    status,
    lastSeen: new Date(),
    groups: [],
    activeNamespaces: [],
    isHub: false,
    hubRole: role,
    hubPriority: priority,
  }
}

describe('HubElection', () => {
  let election: HubElection

  afterEach(() => {
    if (election) {
      election.stop()
    }
  })

  describe('Initial State', () => {
    it('should start with no hub', () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.MEMBER },
      })

      expect(election.hubId).toBeNull()
      expect(election.isHub).toBe(false)
      expect(election.state.term).toBe(0)
    })
  })

  describe('Self Election (Single Node)', () => {
    it('should elect self as hub when ADMIN role with no peers', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN },
      })

      const hubChangedHandler = vi.fn()
      election.on('hub:changed', hubChangedHandler)

      election.start()

      // Wait for election to complete
      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('self')
      expect(election.isHub).toBe(true)
      expect(hubChangedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          previous: null,
          current: 'self',
        })
      )
    })

    it('should elect self as hub when COORDINATOR role with no peers', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.COORDINATOR },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('self')
      expect(election.isHub).toBe(true)
    })

    it('should NOT elect self as hub when MEMBER role', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.MEMBER },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBeNull()
      expect(election.isHub).toBe(false)
    })
  })

  describe('Role-based Election', () => {
    it('should prefer ADMIN over COORDINATOR', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.COORDINATOR },
      })

      const adminPeer = createPeer('admin-peer', HubRole.ADMIN)
      election.updatePeers([adminPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('admin-peer')
      expect(election.isHub).toBe(false)
    })

    it('should prefer ADMIN over MEMBER', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.MEMBER },
      })

      const adminPeer = createPeer('admin-peer', HubRole.ADMIN)
      election.updatePeers([adminPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('admin-peer')
    })

    it('should prefer COORDINATOR over MEMBER', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.MEMBER },
      })

      const coordPeer = createPeer('coord-peer', HubRole.COORDINATOR)
      election.updatePeers([coordPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('coord-peer')
    })

    it('should not elect MEMBER peers as hub', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.MEMBER },
      })

      const memberPeer = createPeer('member-peer', HubRole.MEMBER)
      election.updatePeers([memberPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBeNull()
    })
  })

  describe('Priority Tiebreaker', () => {
    it('should use priority to break ties within same role', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN, priority: 5 },
      })

      const higherPriorityAdmin = createPeer('other-admin', HubRole.ADMIN, 10)
      election.updatePeers([higherPriorityAdmin])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // Other admin has higher priority (10 > 5)
      expect(election.hubId).toBe('other-admin')
    })

    it('should elect self when has higher priority than peers', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN, priority: 10 },
      })

      const lowerPriorityAdmin = createPeer('other-admin', HubRole.ADMIN, 5)
      election.updatePeers([lowerPriorityAdmin])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // Self has higher priority (10 > 5)
      expect(election.hubId).toBe('self')
      expect(election.isHub).toBe(true)
    })

    it('should use peer ID as final tiebreaker', async () => {
      election = new HubElection({
        peerId: 'z-self', // Lexicographically later
        hubConfig: { role: HubRole.ADMIN, priority: 0 },
      })

      const otherAdmin = createPeer('a-admin', HubRole.ADMIN, 0)
      election.updatePeers([otherAdmin])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // 'a-admin' < 'z-self' lexicographically
      expect(election.hubId).toBe('a-admin')
    })
  })

  describe('Peer Join/Leave', () => {
    it('should trigger election when higher-priority peer joins', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.COORDINATOR },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      // Self becomes hub initially
      expect(election.hubId).toBe('self')

      // Higher priority admin joins
      const adminPeer = createPeer('admin-peer', HubRole.ADMIN)
      election.peerJoined(adminPeer)

      await new Promise((r) => setTimeout(r, 150))

      // Admin should take over
      expect(election.hubId).toBe('admin-peer')
    })

    it('should trigger election when hub leaves', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.COORDINATOR },
      })

      const adminPeer = createPeer('admin-peer', HubRole.ADMIN)
      election.updatePeers([adminPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // Admin is hub
      expect(election.hubId).toBe('admin-peer')

      // Admin leaves
      election.peerLeft(adminPeer)

      await new Promise((r) => setTimeout(r, 150))

      // Self should become hub
      expect(election.hubId).toBe('self')
      expect(election.isHub).toBe(true)
    })

    it('should not trigger election when lower-priority peer joins', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('self')
      const initialTerm = election.state.term

      // Lower priority peer joins
      const coordPeer = createPeer('coord-peer', HubRole.COORDINATOR)
      election.peerJoined(coordPeer)

      await new Promise((r) => setTimeout(r, 150))

      // Hub should not change
      expect(election.hubId).toBe('self')
      // Term should not change
      expect(election.state.term).toBe(initialTerm)
    })

    it('should not trigger election when non-hub peer leaves', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN },
      })

      const coordPeer = createPeer('coord-peer', HubRole.COORDINATOR)
      election.updatePeers([coordPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // Self is hub (admin > coordinator)
      expect(election.hubId).toBe('self')
      const initialTerm = election.state.term

      // Non-hub peer leaves
      election.peerLeft(coordPeer)

      await new Promise((r) => setTimeout(r, 150))

      // Hub should not change, term should not change
      expect(election.hubId).toBe('self')
      expect(election.state.term).toBe(initialTerm)
    })
  })

  describe('Hub Announcements', () => {
    it('should accept announcement with higher term', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.COORDINATOR },
      })

      const otherPeer = createPeer('other', HubRole.COORDINATOR)
      election.updatePeers([otherPeer])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      const currentTerm = election.state.term

      // Receive announcement with higher term
      election.receiveHubAnnouncement('other', {
        hubId: 'other',
        term: currentTerm + 5,
      })

      expect(election.hubId).toBe('other')
      expect(election.state.term).toBe(currentTerm + 5)
    })

    it('should ignore announcement with lower term', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('self')
      const currentTerm = election.state.term

      const otherPeer = createPeer('other', HubRole.COORDINATOR)
      election.updatePeers([otherPeer])

      // Receive announcement with lower term
      election.receiveHubAnnouncement('other', {
        hubId: 'other',
        term: currentTerm - 1,
      })

      // Should ignore - hub and term unchanged
      expect(election.hubId).toBe('self')
      expect(election.state.term).toBe(currentTerm)
    })

    it('should create valid hub announcement', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      const announcement = election.createHubAnnouncement()

      expect(announcement.hubId).toBe('self')
      expect(announcement.term).toBeGreaterThan(0)
    })
  })

  describe('Candidate Filtering', () => {
    it('should only consider specified candidates when list provided', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: {
          role: HubRole.ADMIN,
          candidates: ['self', 'allowed-peer'],
        },
      })

      // This admin is not in the candidate list
      const excludedAdmin = createPeer('excluded-admin', HubRole.ADMIN, 100)
      // This coordinator is in the candidate list
      const allowedCoord = createPeer('allowed-peer', HubRole.COORDINATOR)

      election.updatePeers([excludedAdmin, allowedCoord])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // Self should win because excluded-admin is not in candidates list
      // even though excluded-admin has higher priority
      expect(election.hubId).toBe('self')
    })
  })

  describe('Offline Peers', () => {
    it('should not elect offline peers', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.COORDINATOR },
      })

      const offlineAdmin = createPeer('admin', HubRole.ADMIN, 0, 'offline')
      election.updatePeers([offlineAdmin])
      election.start()

      await new Promise((r) => setTimeout(r, 150))

      // Self should be hub since admin is offline
      expect(election.hubId).toBe('self')
    })
  })

  describe('Stop', () => {
    it('should clear state on stop', async () => {
      election = new HubElection({
        peerId: 'self',
        hubConfig: { role: HubRole.ADMIN },
      })

      election.start()
      await new Promise((r) => setTimeout(r, 150))

      expect(election.hubId).toBe('self')

      election.stop()

      expect(election.hubId).toBeNull()
      expect(election.isHub).toBe(false)
      expect(election.state.term).toBe(0)
    })
  })
})
