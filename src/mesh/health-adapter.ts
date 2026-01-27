// Health Monitor Adapter - Pluggable health monitoring (Phase 5)
// Allows different transports to provide their own health monitoring implementations

import { EventEmitter } from 'events'
import type { PeerInfo, PeerStatus } from '../types'

// =============================================================================
// Health Monitor Events
// =============================================================================

/**
 * Events emitted by health monitor adapters.
 */
export interface HealthMonitorEvents {
  /** Emitted when a peer's health status changes */
  'health:changed': (event: HealthChangeEvent) => void
  /** Emitted when a peer becomes suspect (may be offline) */
  'peer:suspect': (event: { peerId: string; missedHeartbeats: number; lastSeen: Date }) => void
  /** Emitted when the hub becomes unhealthy */
  'hub:unhealthy': (hubId: string) => void
  /** Emitted when health monitoring starts */
  'started': () => void
  /** Emitted when health monitoring stops */
  'stopped': () => void
}

/**
 * Health change event payload.
 */
export interface HealthChangeEvent {
  peerId: string
  previousStatus: PeerStatus
  newStatus: PeerStatus
  missedHeartbeats: number
}

/**
 * Health status for a peer.
 */
export interface PeerHealth {
  peerId: string
  status: PeerStatus
  lastSeen: Date
  lastPing: Date | null
  missedHeartbeats: number
  isHub: boolean
}

// =============================================================================
// Health Monitor Adapter Interface
// =============================================================================

/**
 * Abstract interface for health monitoring implementations.
 *
 * Different transports can provide their own implementations:
 * - HealthMonitor: Default TCP ping/pong implementation (for Nebula)
 * - TailscaleHealthMonitor: Uses Tailscale's built-in health monitoring
 * - NoopHealthMonitor: Disabled health monitoring
 *
 * @example
 * ```typescript
 * // Default TCP-based health monitoring
 * const healthMonitor = new HealthMonitor({ heartbeatInterval: 10000 })
 *
 * // Tailscale-based health monitoring
 * const healthMonitor = new TailscaleHealthMonitor(tailscaleCli)
 *
 * // Disabled health monitoring
 * const healthMonitor = new NoopHealthMonitor()
 * ```
 */
export interface HealthMonitorAdapter extends EventEmitter {
  /** Whether health monitoring is currently running */
  readonly isRunning: boolean

  // ========== Lifecycle ==========

  /**
   * Start health monitoring.
   * @param pingFn Function to send ping to a peer (for TCP-based implementations)
   */
  start(pingFn?: (peerId: string) => void): void

  /**
   * Stop health monitoring.
   */
  stop(): void

  // ========== Peer Registration ==========

  /**
   * Register a peer for health monitoring.
   * @param peer Peer info to register
   */
  registerPeer(peer: PeerInfo): void

  /**
   * Unregister a peer from health monitoring.
   * @param peerId Peer ID to unregister
   */
  unregisterPeer(peerId: string): void

  /**
   * Update the current hub ID.
   * @param hubId Current hub peer ID, or null if no hub
   */
  setHubId(hubId: string | null): void

  // ========== Traffic Tracking ==========

  /**
   * Record that traffic was received from a peer.
   * This serves as an implicit heartbeat.
   * @param peerId Peer that sent traffic
   */
  recordTraffic(peerId: string): void

  /**
   * Record that a pong (ping response) was received from a peer.
   * @param peerId Peer that sent pong
   */
  recordPong(peerId: string): void

  // ========== Health Status ==========

  /**
   * Get health status for a specific peer.
   * @param peerId Peer ID to query
   * @returns Health status or null if not registered
   */
  getPeerHealth(peerId: string): PeerHealth | null

  /**
   * Get health status for all registered peers.
   * @returns Array of health statuses
   */
  getAllPeerHealth(): PeerHealth[]

  /**
   * Get list of healthy (online) peer IDs.
   * @returns Array of peer IDs
   */
  getHealthyPeers(): string[]

  /**
   * Get list of unhealthy (offline or unknown) peer IDs.
   * @returns Array of peer IDs
   */
  getUnhealthyPeers(): string[]

  /**
   * Check if the hub is healthy.
   * @returns true if hub is online, false otherwise
   */
  isHubHealthy(): boolean

  // ========== Event Emitter Type Overrides ==========

  on<K extends keyof HealthMonitorEvents>(event: K, listener: HealthMonitorEvents[K]): this
  on(event: string | symbol, listener: (...args: unknown[]) => void): this

  off<K extends keyof HealthMonitorEvents>(event: K, listener: HealthMonitorEvents[K]): this
  off(event: string | symbol, listener: (...args: unknown[]) => void): this

  emit<K extends keyof HealthMonitorEvents>(
    event: K,
    ...args: Parameters<HealthMonitorEvents[K]>
  ): boolean
  emit(event: string | symbol, ...args: unknown[]): boolean
}

// =============================================================================
// Noop Health Monitor (Disabled)
// =============================================================================

/**
 * No-op health monitor implementation.
 * Used when health monitoring is disabled.
 *
 * All peers are always considered online.
 */
export class NoopHealthMonitor extends EventEmitter implements HealthMonitorAdapter {
  private _running = false
  private peers: Map<string, PeerHealth> = new Map()
  private hubId: string | null = null

  get isRunning(): boolean {
    return this._running
  }

  start(): void {
    this._running = true
    this.emit('started')
  }

  stop(): void {
    this._running = false
    this.peers.clear()
    this.emit('stopped')
  }

  registerPeer(peer: PeerInfo): void {
    this.peers.set(peer.id, {
      peerId: peer.id,
      status: 'online', // Always online in noop mode
      lastSeen: new Date(),
      lastPing: null,
      missedHeartbeats: 0,
      isHub: peer.id === this.hubId,
    })
  }

  unregisterPeer(peerId: string): void {
    this.peers.delete(peerId)
  }

  setHubId(hubId: string | null): void {
    this.hubId = hubId
    for (const health of this.peers.values()) {
      health.isHub = health.peerId === hubId
    }
  }

  recordTraffic(peerId: string): void {
    const health = this.peers.get(peerId)
    if (health) {
      health.lastSeen = new Date()
    }
  }

  recordPong(peerId: string): void {
    this.recordTraffic(peerId)
  }

  getPeerHealth(peerId: string): PeerHealth | null {
    return this.peers.get(peerId) ?? null
  }

  getAllPeerHealth(): PeerHealth[] {
    return Array.from(this.peers.values())
  }

  getHealthyPeers(): string[] {
    // All peers are always healthy in noop mode
    return Array.from(this.peers.keys())
  }

  getUnhealthyPeers(): string[] {
    // No peers are ever unhealthy in noop mode
    return []
  }

  isHubHealthy(): boolean {
    // Hub is always healthy in noop mode (if it exists)
    return this.hubId !== null
  }
}
