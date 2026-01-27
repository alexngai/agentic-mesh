// TailscaleHealthMonitor - Health monitoring using Tailscale CLI
// Uses Tailscale's built-in peer status instead of TCP ping/pong

import { EventEmitter } from 'events'
import type { PeerInfo, PeerStatus } from '../../types'
import type { HealthMonitorAdapter, PeerHealth, HealthChangeEvent } from '../../mesh/health-adapter'
import { TailscaleCLI, type TailscalePeerInfo } from './cli'

// =============================================================================
// Configuration
// =============================================================================

export interface TailscaleHealthMonitorConfig {
  /** Tailscale CLI wrapper instance */
  cli?: TailscaleCLI
  /** Path to tailscale binary (default: 'tailscale') */
  tailscaleBin?: string
  /** Poll interval in milliseconds (default: 10000) */
  pollInterval?: number
  /** Map of peer IDs to Tailscale hostnames */
  peerHostnameMap?: Map<string, string>
}

const DEFAULT_POLL_INTERVAL = 10000 // 10 seconds

// =============================================================================
// TailscaleHealthMonitor
// =============================================================================

/**
 * Health monitor that uses Tailscale's built-in peer status.
 *
 * Instead of sending TCP ping/pong messages, this implementation polls
 * the Tailscale CLI for peer online/offline status. This is more efficient
 * because Tailscale already maintains peer connectivity information.
 *
 * @example
 * ```typescript
 * const healthMonitor = new TailscaleHealthMonitor({
 *   pollInterval: 5000,
 *   peerHostnameMap: new Map([
 *     ['peer-1', 'node1'],
 *     ['peer-2', 'node2'],
 *   ]),
 * })
 *
 * healthMonitor.on('health:changed', (event) => {
 *   console.log(`Peer ${event.peerId} is now ${event.newStatus}`)
 * })
 *
 * healthMonitor.start()
 * ```
 */
export class TailscaleHealthMonitor extends EventEmitter implements HealthMonitorAdapter {
  private cli: TailscaleCLI
  private pollInterval: number
  private checkTimer: NodeJS.Timeout | null = null
  private _running = false
  private hubId: string | null = null

  // Map of peerId to health status
  private peerHealth: Map<string, PeerHealth> = new Map()

  // Map of peerId to Tailscale hostname for lookups
  private peerHostnameMap: Map<string, string> = new Map()

  // Reverse map: hostname to peerId
  private hostnamePeerMap: Map<string, string> = new Map()

  constructor(config: TailscaleHealthMonitorConfig = {}) {
    super()
    this.cli = config.cli ?? new TailscaleCLI(config.tailscaleBin)
    this.pollInterval = config.pollInterval ?? DEFAULT_POLL_INTERVAL

    // Initialize hostname maps
    if (config.peerHostnameMap) {
      for (const [peerId, hostname] of config.peerHostnameMap) {
        this.peerHostnameMap.set(peerId, hostname)
        this.hostnamePeerMap.set(hostname.toLowerCase(), peerId)
      }
    }
  }

  get isRunning(): boolean {
    return this._running
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start health monitoring.
   * The pingFn parameter is ignored - we use Tailscale status instead.
   */
  start(_pingFn?: (peerId: string) => void): void {
    if (this._running) return

    this._running = true

    // Start periodic health check
    this.checkTimer = setInterval(() => {
      this.checkHealth().catch((err) => {
        this.emit('error', err)
      })
    }, this.pollInterval)

    // Do an immediate check
    this.checkHealth().catch((err) => {
      this.emit('error', err)
    })

    this.emit('started')
  }

  /**
   * Stop health monitoring.
   */
  stop(): void {
    if (!this._running) return

    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }

    this._running = false
    this.peerHealth.clear()

    this.emit('stopped')
  }

  // ===========================================================================
  // Peer Registration
  // ===========================================================================

  /**
   * Register a peer for health monitoring.
   * Extracts hostname from peer name or endpoint for Tailscale lookup.
   */
  registerPeer(peer: PeerInfo): void {
    const health: PeerHealth = {
      peerId: peer.id,
      status: peer.status,
      lastSeen: new Date(),
      lastPing: null,
      missedHeartbeats: 0,
      isHub: peer.id === this.hubId,
    }
    this.peerHealth.set(peer.id, health)

    // Try to map peer to a Tailscale hostname
    // Priority: explicit map > peer name > peer id
    if (!this.peerHostnameMap.has(peer.id)) {
      const hostname = peer.name ?? peer.id
      this.peerHostnameMap.set(peer.id, hostname)
      this.hostnamePeerMap.set(hostname.toLowerCase(), peer.id)
    }
  }

  /**
   * Unregister a peer from health monitoring.
   */
  unregisterPeer(peerId: string): void {
    const hostname = this.peerHostnameMap.get(peerId)
    if (hostname) {
      this.hostnamePeerMap.delete(hostname.toLowerCase())
    }
    this.peerHostnameMap.delete(peerId)
    this.peerHealth.delete(peerId)
  }

  /**
   * Update the current hub ID.
   */
  setHubId(hubId: string | null): void {
    this.hubId = hubId

    // Update isHub flag on all peers
    for (const health of this.peerHealth.values()) {
      health.isHub = health.peerId === hubId
    }
  }

  /**
   * Set the mapping of peer IDs to Tailscale hostnames.
   */
  setPeerHostnameMap(map: Map<string, string>): void {
    this.peerHostnameMap = new Map(map)
    this.hostnamePeerMap.clear()
    for (const [peerId, hostname] of map) {
      this.hostnamePeerMap.set(hostname.toLowerCase(), peerId)
    }
  }

  // ===========================================================================
  // Traffic Tracking (mostly no-op, we use Tailscale status)
  // ===========================================================================

  /**
   * Record that traffic was received from a peer.
   * Updates lastSeen timestamp but doesn't affect health status
   * (we rely on Tailscale's view of peer status).
   */
  recordTraffic(peerId: string): void {
    const health = this.peerHealth.get(peerId)
    if (health) {
      health.lastSeen = new Date()
    }
  }

  /**
   * Record that a pong was received from a peer.
   * Same as recordTraffic for this implementation.
   */
  recordPong(peerId: string): void {
    this.recordTraffic(peerId)
  }

  // ===========================================================================
  // Health Status
  // ===========================================================================

  /**
   * Get health status for a specific peer.
   */
  getPeerHealth(peerId: string): PeerHealth | null {
    return this.peerHealth.get(peerId) ?? null
  }

  /**
   * Get health status for all registered peers.
   */
  getAllPeerHealth(): PeerHealth[] {
    return Array.from(this.peerHealth.values())
  }

  /**
   * Get list of healthy (online) peer IDs.
   */
  getHealthyPeers(): string[] {
    return Array.from(this.peerHealth.values())
      .filter((h) => h.status === 'online')
      .map((h) => h.peerId)
  }

  /**
   * Get list of unhealthy (offline or unknown) peer IDs.
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

  // ===========================================================================
  // Internal: Health Check via Tailscale
  // ===========================================================================

  /**
   * Check health of all registered peers using Tailscale status.
   */
  private async checkHealth(): Promise<void> {
    try {
      // Get Tailscale peer status
      const tailscalePeers = await this.cli.getPeers()
      const peerStatusMap = new Map<string, TailscalePeerInfo>()

      // Build a lookup map by hostname
      for (const peer of tailscalePeers) {
        peerStatusMap.set(peer.hostname.toLowerCase(), peer)
        // Also index by DNS name (without .ts.net suffix)
        const dnsBasename = peer.dnsName.split('.')[0]?.toLowerCase()
        if (dnsBasename) {
          peerStatusMap.set(dnsBasename, peer)
        }
      }

      // Update health status for all registered peers
      for (const health of this.peerHealth.values()) {
        const hostname = this.peerHostnameMap.get(health.peerId)
        if (!hostname) continue

        const tailscalePeer = peerStatusMap.get(hostname.toLowerCase())
        const previousStatus = health.status
        const newStatus: PeerStatus = tailscalePeer?.online ? 'online' : 'offline'

        // Update status
        if (tailscalePeer) {
          health.lastSeen = tailscalePeer.lastSeen ?? new Date()
        }

        if (previousStatus !== newStatus) {
          health.status = newStatus
          health.missedHeartbeats = newStatus === 'offline' ? 1 : 0

          this.emit('health:changed', {
            peerId: health.peerId,
            previousStatus,
            newStatus,
            missedHeartbeats: health.missedHeartbeats,
          } as HealthChangeEvent)

          // If hub became unhealthy, emit special event
          if (health.isHub && newStatus === 'offline') {
            this.emit('hub:unhealthy', health.peerId)
          }
        }
      }
    } catch (err) {
      // If we can't reach Tailscale, don't mark all peers as offline
      // Just emit an error and keep existing status
      this.emit('error', err)
    }
  }
}
