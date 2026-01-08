// Peer Discovery - Lighthouse-based peer discovery protocol
// Implements: i-4j5g

import { EventEmitter } from 'events'
import type { PeerInfo, PeerConfig } from '../types'
import type { MessageChannel } from '../channel/message-channel'

// =============================================================================
// Types
// =============================================================================

/**
 * Discovery request message
 */
export interface DiscoveryRequest {
  type: 'peer-list-request'
  /** Optional namespace filter */
  namespace?: string
  /** Requesting peer info */
  peer: DiscoveryPeerInfo
}

/**
 * Discovery response message
 */
export interface DiscoveryResponse {
  type: 'peer-list-response'
  /** List of known peers */
  peers: DiscoveryPeerInfo[]
  /** Timestamp for freshness */
  timestamp: number
}

/**
 * Peer registration message
 */
export interface DiscoveryRegister {
  type: 'peer-register'
  peer: DiscoveryPeerInfo
}

/**
 * Peer unregister message (graceful shutdown)
 */
export interface DiscoveryUnregister {
  type: 'peer-unregister'
  peerId: string
}

/**
 * Discovery message union type
 */
export type DiscoveryMessage =
  | DiscoveryRequest
  | DiscoveryResponse
  | DiscoveryRegister
  | DiscoveryUnregister

/**
 * Peer info for discovery protocol
 */
export interface DiscoveryPeerInfo {
  id: string
  name?: string
  nebulaIp: string
  port?: number
  groups: string[]
  namespaces: string[]
  /** Last seen timestamp */
  lastSeen: number
}

/**
 * Configuration for PeerDiscovery
 */
export interface PeerDiscoveryConfig {
  /** Local peer ID */
  peerId: string
  /** Local peer name */
  peerName?: string
  /** Local Nebula IP */
  nebulaIp: string
  /** Local listen port */
  port: number
  /** Local groups */
  groups: string[]
  /** Lighthouse peer IDs */
  lighthousePeerIds: string[]
  /** Discovery poll interval in ms (default: 30000) */
  pollInterval?: number
  /** Peer timeout in ms (default: 120000 = 2 minutes) */
  peerTimeout?: number
  /** Whether this node is a lighthouse */
  isLighthouse?: boolean
}

/**
 * Event types emitted by PeerDiscovery
 */
export type PeerDiscoveryEventType =
  | 'peer:discovered'
  | 'peer:lost'
  | 'peer:updated'
  | 'discovery:started'
  | 'discovery:stopped'
  | 'discovery:error'

// =============================================================================
// PeerDiscovery
// =============================================================================

const DEFAULT_POLL_INTERVAL = 30000
const DEFAULT_PEER_TIMEOUT = 120000

/**
 * PeerDiscovery provides lighthouse-based peer discovery.
 *
 * - Lighthouses maintain a registry of known peers
 * - Peers periodically query lighthouses for peer lists
 * - Peers register themselves with lighthouses
 * - Supports namespace-filtered discovery
 *
 * @example
 * ```typescript
 * const discovery = new PeerDiscovery({
 *   peerId: 'my-peer',
 *   nebulaIp: '10.42.0.5',
 *   port: 7946,
 *   groups: ['team-a'],
 *   lighthousePeerIds: ['lighthouse-1'],
 * })
 *
 * discovery.on('peer:discovered', (peer) => {
 *   console.log('New peer:', peer.id)
 * })
 *
 * await discovery.start(channel)
 * ```
 */
export class PeerDiscovery extends EventEmitter {
  private config: Required<PeerDiscoveryConfig>
  private channel: MessageChannel<DiscoveryMessage> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private _running = false

  // Lighthouse registry (only used if this is a lighthouse)
  private peerRegistry: Map<string, DiscoveryPeerInfo> = new Map()

  // Discovered peers (for non-lighthouse nodes)
  private discoveredPeers: Map<string, DiscoveryPeerInfo> = new Map()

  // Active namespaces
  private namespaces: Set<string> = new Set()

  constructor(config: PeerDiscoveryConfig) {
    super()
    this.config = {
      peerId: config.peerId,
      peerName: config.peerName ?? config.peerId,
      nebulaIp: config.nebulaIp,
      port: config.port,
      groups: config.groups,
      lighthousePeerIds: config.lighthousePeerIds,
      pollInterval: config.pollInterval ?? DEFAULT_POLL_INTERVAL,
      peerTimeout: config.peerTimeout ?? DEFAULT_PEER_TIMEOUT,
      isLighthouse: config.isLighthouse ?? false,
    }
  }

  /**
   * Whether discovery is running
   */
  get running(): boolean {
    return this._running
  }

  /**
   * Whether this node is a lighthouse
   */
  get isLighthouse(): boolean {
    return this.config.isLighthouse
  }

  /**
   * Get discovered peers
   */
  getDiscoveredPeers(): DiscoveryPeerInfo[] {
    return Array.from(this.discoveredPeers.values())
  }

  /**
   * Get registered peers (lighthouse only)
   */
  getRegisteredPeers(): DiscoveryPeerInfo[] {
    return Array.from(this.peerRegistry.values())
  }

  /**
   * Register a namespace for discovery
   */
  registerNamespace(namespace: string): void {
    this.namespaces.add(namespace)
  }

  /**
   * Unregister a namespace
   */
  unregisterNamespace(namespace: string): void {
    this.namespaces.delete(namespace)
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start peer discovery using the provided channel.
   */
  async start(channel: MessageChannel<DiscoveryMessage>): Promise<void> {
    if (this._running) return

    this.channel = channel

    // Set up message handler
    channel.on('message', (msg, from) => {
      this.handleMessage(msg, from)
    })

    // Open channel
    await channel.open()

    this._running = true
    this.emit('discovery:started')

    // If not a lighthouse, start polling
    if (!this.config.isLighthouse) {
      this.startPolling()
      // Initial registration with lighthouses
      await this.registerWithLighthouses()
      // Initial discovery
      await this.discoverPeers()
    }
  }

  /**
   * Stop peer discovery.
   */
  async stop(): Promise<void> {
    if (!this._running) return

    // Stop polling
    this.stopPolling()

    // Unregister from lighthouses
    if (!this.config.isLighthouse && this.channel) {
      await this.unregisterFromLighthouses()
    }

    // Close channel
    if (this.channel) {
      await this.channel.close()
      this.channel = null
    }

    this._running = false
    this.emit('discovery:stopped')
  }

  // ===========================================================================
  // Discovery Operations
  // ===========================================================================

  /**
   * Discover peers by querying lighthouses.
   *
   * @param namespace Optional namespace to filter by
   */
  async discoverPeers(namespace?: string): Promise<DiscoveryPeerInfo[]> {
    if (!this.channel || !this._running) {
      return []
    }

    const selfInfo = this.getSelfInfo()
    const request: DiscoveryRequest = {
      type: 'peer-list-request',
      namespace,
      peer: selfInfo,
    }

    const allPeers: DiscoveryPeerInfo[] = []

    // Query each lighthouse
    for (const lighthouseId of this.config.lighthousePeerIds) {
      try {
        const response = await this.channel.request<DiscoveryResponse>(
          lighthouseId,
          request,
          5000 // 5 second timeout
        )

        if (response.type === 'peer-list-response') {
          for (const peer of response.peers) {
            if (peer.id !== this.config.peerId) {
              this.updateDiscoveredPeer(peer)
              allPeers.push(peer)
            }
          }
        }
      } catch (error) {
        this.emit('discovery:error', {
          lighthouseId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    // Clean up stale peers
    this.cleanupStalePeers()

    return allPeers
  }

  /**
   * Register self with lighthouses.
   */
  async registerWithLighthouses(): Promise<void> {
    if (!this.channel || !this._running) return

    const selfInfo = this.getSelfInfo()
    const message: DiscoveryRegister = {
      type: 'peer-register',
      peer: selfInfo,
    }

    // Register with each lighthouse
    for (const lighthouseId of this.config.lighthousePeerIds) {
      try {
        this.channel.send(lighthouseId, message)
      } catch (error) {
        this.emit('discovery:error', {
          lighthouseId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }
  }

  /**
   * Unregister self from lighthouses (graceful shutdown).
   */
  private async unregisterFromLighthouses(): Promise<void> {
    if (!this.channel) return

    const message: DiscoveryUnregister = {
      type: 'peer-unregister',
      peerId: this.config.peerId,
    }

    for (const lighthouseId of this.config.lighthousePeerIds) {
      try {
        this.channel.send(lighthouseId, message)
      } catch {
        // Ignore errors during shutdown
      }
    }
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleMessage(msg: DiscoveryMessage, from: PeerInfo): void {
    switch (msg.type) {
      case 'peer-list-request':
        this.handlePeerListRequest(msg, from)
        break
      case 'peer-list-response':
        // Handled in discoverPeers() via RPC
        break
      case 'peer-register':
        this.handlePeerRegister(msg, from)
        break
      case 'peer-unregister':
        this.handlePeerUnregister(msg)
        break
    }
  }

  private handlePeerListRequest(msg: DiscoveryRequest, from: PeerInfo): void {
    if (!this.config.isLighthouse || !this.channel) return

    // Register/update the requesting peer
    if (msg.peer) {
      this.registerPeer(msg.peer)
    }

    // Build peer list
    let peers = Array.from(this.peerRegistry.values())

    // Filter by namespace if specified
    if (msg.namespace) {
      peers = peers.filter((p) => p.namespaces.includes(msg.namespace!))
    }

    // Send response via RPC mechanism
    // Note: The MessageChannel's onRequest handler will be used for this
    const response: DiscoveryResponse = {
      type: 'peer-list-response',
      peers,
      timestamp: Date.now(),
    }

    this.channel.send(from.id, response)
  }

  private handlePeerRegister(msg: DiscoveryRegister, from: PeerInfo): void {
    if (!this.config.isLighthouse) return

    this.registerPeer(msg.peer)
  }

  private handlePeerUnregister(msg: DiscoveryUnregister): void {
    if (!this.config.isLighthouse) return

    const peer = this.peerRegistry.get(msg.peerId)
    if (peer) {
      this.peerRegistry.delete(msg.peerId)
      this.emit('peer:lost', peer)
    }
  }

  // ===========================================================================
  // Registry Management (Lighthouse)
  // ===========================================================================

  private registerPeer(peer: DiscoveryPeerInfo): void {
    const existing = this.peerRegistry.get(peer.id)

    // Update timestamp
    peer.lastSeen = Date.now()

    this.peerRegistry.set(peer.id, peer)

    if (!existing) {
      this.emit('peer:discovered', peer)
    } else if (this.hasChanged(existing, peer)) {
      this.emit('peer:updated', peer)
    }
  }

  // ===========================================================================
  // Discovered Peers (Non-Lighthouse)
  // ===========================================================================

  private updateDiscoveredPeer(peer: DiscoveryPeerInfo): void {
    const existing = this.discoveredPeers.get(peer.id)

    // Update with fresh timestamp
    peer.lastSeen = Date.now()
    this.discoveredPeers.set(peer.id, peer)

    if (!existing) {
      this.emit('peer:discovered', peer)
    } else if (this.hasChanged(existing, peer)) {
      this.emit('peer:updated', peer)
    }
  }

  private cleanupStalePeers(): void {
    const now = Date.now()
    const staleThreshold = this.config.peerTimeout

    for (const [peerId, peer] of this.discoveredPeers) {
      if (now - peer.lastSeen > staleThreshold) {
        this.discoveredPeers.delete(peerId)
        this.emit('peer:lost', peer)
      }
    }

    // Also clean up lighthouse registry if we're a lighthouse
    if (this.config.isLighthouse) {
      for (const [peerId, peer] of this.peerRegistry) {
        if (now - peer.lastSeen > staleThreshold) {
          this.peerRegistry.delete(peerId)
          this.emit('peer:lost', peer)
        }
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getSelfInfo(): DiscoveryPeerInfo {
    return {
      id: this.config.peerId,
      name: this.config.peerName,
      nebulaIp: this.config.nebulaIp,
      port: this.config.port,
      groups: this.config.groups,
      namespaces: Array.from(this.namespaces),
      lastSeen: Date.now(),
    }
  }

  private hasChanged(
    old: DiscoveryPeerInfo,
    updated: DiscoveryPeerInfo
  ): boolean {
    return (
      old.name !== updated.name ||
      old.nebulaIp !== updated.nebulaIp ||
      old.port !== updated.port ||
      !this.arraysEqual(old.groups, updated.groups) ||
      !this.arraysEqual(old.namespaces, updated.namespaces)
    )
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    const sortedA = [...a].sort()
    const sortedB = [...b].sort()
    return sortedA.every((v, i) => v === sortedB[i])
  }

  private startPolling(): void {
    if (this.pollTimer) return

    this.pollTimer = setInterval(async () => {
      try {
        await this.registerWithLighthouses()
        await this.discoverPeers()
      } catch (error) {
        this.emit('discovery:error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }, this.config.pollInterval)
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert DiscoveryPeerInfo to PeerConfig for mesh configuration.
 */
export function discoveryPeerToPeerConfig(peer: DiscoveryPeerInfo): PeerConfig {
  return {
    id: peer.id,
    name: peer.name,
    nebulaIp: peer.nebulaIp,
    port: peer.port,
  }
}

/**
 * Convert PeerInfo to DiscoveryPeerInfo.
 */
export function peerInfoToDiscoveryPeer(peer: PeerInfo): DiscoveryPeerInfo {
  return {
    id: peer.id,
    name: peer.name,
    nebulaIp: peer.nebulaIp,
    port: peer.port,
    groups: peer.groups,
    namespaces: peer.activeNamespaces,
    lastSeen: peer.lastSeen.getTime(),
  }
}
