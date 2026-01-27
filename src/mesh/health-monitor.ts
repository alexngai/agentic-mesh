// HealthMonitor - Peer health tracking with heartbeats
// Implements: i-14dm

import { EventEmitter } from 'events'
import type { PeerInfo, PeerStatus } from '../types'
import type { HealthMonitorAdapter, PeerHealth, HealthChangeEvent } from './health-adapter'

// Re-export types for backward compatibility
export type { PeerHealth, HealthChangeEvent } from './health-adapter'

export interface HealthMonitorConfig {
  /** Heartbeat interval in milliseconds. Default: 10000 (10s) */
  heartbeatInterval?: number
  /** Number of missed heartbeats before marking peer as suspect. Default: 2 */
  suspectThreshold?: number
  /** Number of missed heartbeats before marking peer as offline. Default: 3 */
  offlineThreshold?: number
}

const DEFAULT_HEARTBEAT_INTERVAL = 10000 // 10 seconds
const DEFAULT_SUSPECT_THRESHOLD = 2 // After 2 missed heartbeats (20s)
const DEFAULT_OFFLINE_THRESHOLD = 3 // After 3 missed heartbeats (30s)

/**
 * Default TCP ping/pong-based health monitor.
 * Implements the HealthMonitorAdapter interface.
 */
export class HealthMonitor extends EventEmitter implements HealthMonitorAdapter {
  private readonly heartbeatInterval: number
  private readonly suspectThreshold: number
  private readonly offlineThreshold: number
  private peerHealth: Map<string, PeerHealth> = new Map()
  private checkTimer: NodeJS.Timeout | null = null
  private pingFn: ((peerId: string) => void) | null = null
  private running = false
  private hubId: string | null = null

  constructor(config: HealthMonitorConfig = {}) {
    super()
    this.heartbeatInterval = config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL
    this.suspectThreshold = config.suspectThreshold ?? DEFAULT_SUSPECT_THRESHOLD
    this.offlineThreshold = config.offlineThreshold ?? DEFAULT_OFFLINE_THRESHOLD
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start health monitoring.
   * @param pingFn Function to call when a ping should be sent to a peer
   */
  start(pingFn: (peerId: string) => void): void {
    if (this.running) return

    this.pingFn = pingFn
    this.running = true

    // Start periodic health check
    this.checkTimer = setInterval(() => {
      this.checkHealth()
    }, this.heartbeatInterval)

    this.emit('started')
  }

  /**
   * Stop health monitoring.
   */
  stop(): void {
    if (!this.running) return

    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }

    this.pingFn = null
    this.running = false
    this.peerHealth.clear()

    this.emit('stopped')
  }

  /**
   * Check if health monitoring is running.
   */
  get isRunning(): boolean {
    return this.running
  }

  // ==========================================================================
  // Peer Registration
  // ==========================================================================

  /**
   * Register a peer for health monitoring.
   * Called when a peer joins the mesh.
   */
  registerPeer(peer: PeerInfo): void {
    const health: PeerHealth = {
      peerId: peer.id,
      status: peer.status,
      lastSeen: new Date(),
      lastPing: null,
      missedHeartbeats: 0,
      isHub: peer.isHub,
    }
    this.peerHealth.set(peer.id, health)
  }

  /**
   * Unregister a peer from health monitoring.
   * Called when a peer leaves the mesh.
   */
  unregisterPeer(peerId: string): void {
    this.peerHealth.delete(peerId)
  }

  /**
   * Update the current hub ID for special handling.
   */
  setHubId(hubId: string | null): void {
    this.hubId = hubId

    // Update isHub flag on all peers
    for (const health of this.peerHealth.values()) {
      health.isHub = health.peerId === hubId
    }
  }

  // ==========================================================================
  // Traffic Tracking
  // ==========================================================================

  /**
   * Record that we received traffic from a peer.
   * Called for any message received from a peer (data or control).
   * This serves as an implicit heartbeat - no dedicated ping needed.
   */
  recordTraffic(peerId: string): void {
    const health = this.peerHealth.get(peerId)
    if (!health) return

    const previousStatus = health.status
    health.lastSeen = new Date()
    health.missedHeartbeats = 0

    // If peer was not online, transition them to online
    if (previousStatus !== 'online') {
      health.status = 'online'
      this.emit('health:changed', {
        peerId,
        previousStatus,
        newStatus: 'online',
        missedHeartbeats: 0,
      } as HealthChangeEvent)
    }
  }

  /**
   * Record that we received a pong (ping response) from a peer.
   */
  recordPong(peerId: string): void {
    this.recordTraffic(peerId)
  }

  // ==========================================================================
  // Health Status
  // ==========================================================================

  /**
   * Get health status for a specific peer.
   */
  getPeerHealth(peerId: string): PeerHealth | null {
    return this.peerHealth.get(peerId) ?? null
  }

  /**
   * Get health status for all peers.
   */
  getAllPeerHealth(): PeerHealth[] {
    return Array.from(this.peerHealth.values())
  }

  /**
   * Get list of peers that are currently healthy (online).
   */
  getHealthyPeers(): string[] {
    return Array.from(this.peerHealth.values())
      .filter((h) => h.status === 'online')
      .map((h) => h.peerId)
  }

  /**
   * Get list of peers that are unhealthy (offline or unknown).
   */
  getUnhealthyPeers(): string[] {
    return Array.from(this.peerHealth.values())
      .filter((h) => h.status !== 'online')
      .map((h) => h.peerId)
  }

  /**
   * Check if the hub is healthy.
   */
  isHubHealthy(): boolean {
    if (!this.hubId) return false
    const health = this.peerHealth.get(this.hubId)
    return health?.status === 'online'
  }

  // ==========================================================================
  // Internal: Health Check
  // ==========================================================================

  private checkHealth(): void {
    const now = Date.now()

    for (const health of this.peerHealth.values()) {
      const timeSinceLastSeen = now - health.lastSeen.getTime()
      const missedHeartbeats = Math.floor(timeSinceLastSeen / this.heartbeatInterval)

      // Update missed heartbeat count
      health.missedHeartbeats = missedHeartbeats

      const previousStatus = health.status

      if (missedHeartbeats >= this.offlineThreshold) {
        // Peer is offline
        if (previousStatus !== 'offline') {
          health.status = 'offline'
          this.emitHealthChange(health.peerId, previousStatus, 'offline', missedHeartbeats)

          // If this was the hub, emit special event for re-election
          if (health.isHub) {
            this.emit('hub:unhealthy', health.peerId)
          }
        }
      } else if (missedHeartbeats >= this.suspectThreshold) {
        // Peer is suspect - send ping to check
        if (this.pingFn) {
          this.pingFn(health.peerId)
          health.lastPing = new Date()
        }

        // Keep current status but emit suspect event
        this.emit('peer:suspect', {
          peerId: health.peerId,
          missedHeartbeats,
          lastSeen: health.lastSeen,
        })
      }
      // If missedHeartbeats < suspectThreshold, peer is healthy - no action needed
    }
  }

  private emitHealthChange(
    peerId: string,
    previousStatus: PeerStatus,
    newStatus: PeerStatus,
    missedHeartbeats: number
  ): void {
    this.emit('health:changed', {
      peerId,
      previousStatus,
      newStatus,
      missedHeartbeats,
    } as HealthChangeEvent)
  }
}
