// Hub Election - Role/Permission-based hub election
// Implements: s-73x5

import { EventEmitter } from 'events'
import type { PeerInfo, HubConfig, HubState } from '../types'
import { HubRole } from '../types'

export interface HubElectionConfig {
  /** This peer's ID */
  peerId: string
  /** Hub configuration for this peer */
  hubConfig: HubConfig
  /** Election timeout before declaring self as hub (ms) */
  electionTimeout?: number
}

interface HubCandidate {
  peerId: string
  role: HubRole
  priority: number
}

const DEFAULT_ELECTION_TIMEOUT = 5000

/**
 * HubElection manages the hub election process using role-based priority.
 *
 * Election algorithm:
 * 1. Filter candidates (only COORDINATOR and ADMIN roles can become hub)
 * 2. Sort by role (ADMIN > COORDINATOR) then by priority (higher first)
 * 3. Tiebreak by peer ID (lexicographic, for determinism)
 * 4. Highest-ranked online peer becomes hub
 *
 * Elections are triggered when:
 * - Mesh starts up
 * - Current hub goes offline
 * - A higher-priority peer comes online
 * - Role/priority configuration changes
 */
export class HubElection extends EventEmitter {
  private config: Required<HubElectionConfig>
  private _state: HubState = {
    hubId: null,
    hub: null,
    term: 0,
    electedAt: null,
  }
  private electionTimer: NodeJS.Timeout | null = null
  private peers: Map<string, PeerInfo> = new Map()

  constructor(config: HubElectionConfig) {
    super()
    this.config = {
      ...config,
      electionTimeout: config.electionTimeout ?? DEFAULT_ELECTION_TIMEOUT,
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  get state(): HubState {
    return { ...this._state }
  }

  get hubId(): string | null {
    return this._state.hubId
  }

  get isHub(): boolean {
    return this._state.hubId === this.config.peerId
  }

  /**
   * Start the election process.
   * Should be called after mesh connects.
   */
  start(): void {
    this.triggerElection('startup')
  }

  /**
   * Stop the election process.
   */
  stop(): void {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer)
      this.electionTimer = null
    }
    this._state = {
      hubId: null,
      hub: null,
      term: 0,
      electedAt: null,
    }
  }

  /**
   * Update known peers for election consideration.
   */
  updatePeers(peers: PeerInfo[]): void {
    this.peers.clear()
    for (const peer of peers) {
      if (peer.id !== this.config.peerId) {
        this.peers.set(peer.id, peer)
      }
    }
  }

  /**
   * Notify that a peer has joined the mesh.
   */
  peerJoined(peer: PeerInfo): void {
    this.peers.set(peer.id, peer)

    // Check if new peer should become hub
    if (this.shouldTriggerElection(peer)) {
      this.triggerElection('peer-joined')
    }
  }

  /**
   * Notify that a peer has left the mesh.
   */
  peerLeft(peer: PeerInfo): void {
    this.peers.delete(peer.id)

    // If the hub left, trigger election
    if (peer.id === this._state.hubId) {
      this.triggerElection('hub-left')
    }
  }

  /**
   * Receive a hub announcement from another peer.
   * Used for consistency when peers disagree on hub.
   */
  receiveHubAnnouncement(
    fromPeerId: string,
    announcement: { hubId: string; term: number }
  ): void {
    // Accept announcements with higher term
    if (announcement.term > this._state.term) {
      const hub = this.peers.get(announcement.hubId)
      if (hub || announcement.hubId === this.config.peerId) {
        this.setHub(
          announcement.hubId,
          hub ?? this.getSelfAsPeer(),
          announcement.term
        )
      }
    }
  }

  // ===========================================================================
  // Election Logic
  // ===========================================================================

  private shouldTriggerElection(newPeer: PeerInfo): boolean {
    // No current hub - definitely need election
    if (!this._state.hubId) return true

    // New peer has higher priority than current hub
    const currentHub = this._state.hub
    if (!currentHub) return true

    return this.compareCandidate(newPeer, currentHub) > 0
  }

  private triggerElection(reason: string): void {
    // Clear any pending election
    if (this.electionTimer) {
      clearTimeout(this.electionTimer)
    }

    // Small delay to allow peer state to stabilize
    this.electionTimer = setTimeout(() => {
      this.runElection(reason)
    }, 100)
  }

  private runElection(reason: string): void {
    const candidates = this.getCandidates()

    if (candidates.length === 0) {
      // No valid candidates - clear hub
      if (this._state.hubId !== null) {
        this.setHub(null, null, this._state.term + 1)
      }
      return
    }

    // Sort candidates by priority
    candidates.sort((a, b) => this.compareCandidateInfo(b, a))

    const winner = candidates[0]
    const winnerPeer =
      winner.peerId === this.config.peerId
        ? this.getSelfAsPeer()
        : this.peers.get(winner.peerId)!

    // Only change hub if different
    if (winner.peerId !== this._state.hubId) {
      this.setHub(winner.peerId, winnerPeer, this._state.term + 1)
      this.emit('election:completed', {
        hubId: winner.peerId,
        term: this._state.term,
        reason,
        candidates: candidates.length,
      })
    }
  }

  private getCandidates(): HubCandidate[] {
    const candidates: HubCandidate[] = []

    // Add self if eligible
    if (this.canBeHub(this.config.hubConfig.role)) {
      candidates.push({
        peerId: this.config.peerId,
        role: this.config.hubConfig.role,
        priority: this.config.hubConfig.priority ?? 0,
      })
    }

    // Add online peers that are eligible
    for (const peer of this.peers.values()) {
      if (peer.status !== 'online') continue

      const role = peer.hubRole ?? HubRole.MEMBER
      if (this.canBeHub(role)) {
        candidates.push({
          peerId: peer.id,
          role,
          priority: peer.hubPriority ?? 0,
        })
      }
    }

    // Filter by candidate list if specified
    const allowedCandidates = this.config.hubConfig.candidates
    if (allowedCandidates && allowedCandidates.length > 0) {
      return candidates.filter((c) => allowedCandidates.includes(c.peerId))
    }

    return candidates
  }

  private canBeHub(role: HubRole): boolean {
    return role >= HubRole.COORDINATOR
  }

  private compareCandidateInfo(a: HubCandidate, b: HubCandidate): number {
    // Higher role wins
    if (a.role !== b.role) {
      return a.role - b.role
    }

    // Higher priority wins
    if (a.priority !== b.priority) {
      return a.priority - b.priority
    }

    // Lexicographically lower peer ID wins (for determinism)
    // Note: reversed because we sort descending and want lower ID to win
    return b.peerId.localeCompare(a.peerId)
  }

  private compareCandidate(a: PeerInfo, b: PeerInfo): number {
    const aRole = a.hubRole ?? HubRole.MEMBER
    const bRole = b.hubRole ?? HubRole.MEMBER

    if (aRole !== bRole) {
      return aRole - bRole
    }

    const aPriority = a.hubPriority ?? 0
    const bPriority = b.hubPriority ?? 0

    if (aPriority !== bPriority) {
      return aPriority - bPriority
    }

    return a.id.localeCompare(b.id)
  }

  private setHub(
    hubId: string | null,
    hub: PeerInfo | null,
    term: number
  ): void {
    const previousHub = this._state.hubId

    this._state = {
      hubId,
      hub: hub ? { ...hub, isHub: true } : null,
      term,
      electedAt: hubId ? new Date() : null,
    }

    // Emit hub change event
    if (previousHub !== hubId) {
      this.emit('hub:changed', {
        previous: previousHub,
        current: hubId,
        term,
      })
    }
  }

  private getSelfAsPeer(): PeerInfo {
    return {
      id: this.config.peerId,
      nebulaIp: '', // Not needed for hub state
      status: 'online',
      lastSeen: new Date(),
      groups: [],
      activeNamespaces: [],
      isHub: true,
      hubRole: this.config.hubConfig.role,
      hubPriority: this.config.hubConfig.priority,
    }
  }

  // ===========================================================================
  // Hub Announcement Message
  // ===========================================================================

  /**
   * Create a hub announcement message to broadcast.
   */
  createHubAnnouncement(): { hubId: string | null; term: number } {
    return {
      hubId: this._state.hubId,
      term: this._state.term,
    }
  }
}
