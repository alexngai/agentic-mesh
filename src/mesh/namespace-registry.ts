// Namespace Registry - Hub-maintained registry of active namespaces
// Part of Phase 3.2 Peer Discovery

import { EventEmitter } from 'events'

export interface NamespaceEntry {
  namespace: string
  peers: Set<string>
  createdAt: Date
  updatedAt: Date
}

export interface NamespaceRegistration {
  type: 'namespace-register' | 'namespace-unregister'
  namespace: string
  peerId: string
}

export interface NamespaceUpdate {
  type: 'namespace-update'
  namespace: string
  peers: string[]
  action: 'added' | 'removed'
  changedPeerId: string
}

export interface NamespaceSnapshot {
  type: 'namespace-snapshot'
  namespaces: Array<{ namespace: string; peers: string[] }>
}

/**
 * NamespaceRegistry maintains a mapping of namespaces to their participating peers.
 * This is maintained by the hub and synchronized to all peers.
 *
 * Flow:
 * 1. Peer registers namespace with hub via 'namespace-register' message
 * 2. Hub updates registry and broadcasts 'namespace-update' to all peers
 * 3. Peers update their local cache of the registry
 * 4. When peer queries getPeersForNamespace, they get the cached result
 */
export class NamespaceRegistry extends EventEmitter {
  private registry: Map<string, NamespaceEntry> = new Map()
  private localPeerId: string

  constructor(localPeerId: string) {
    super()
    this.localPeerId = localPeerId
  }

  // ===========================================================================
  // Hub-side Operations (only called when this peer is hub)
  // ===========================================================================

  /**
   * Register a peer for a namespace (hub-side).
   * Called when hub receives a namespace-register message.
   */
  registerPeer(namespace: string, peerId: string): NamespaceUpdate | null {
    let entry = this.registry.get(namespace)

    if (!entry) {
      entry = {
        namespace,
        peers: new Set(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      this.registry.set(namespace, entry)
    }

    if (entry.peers.has(peerId)) {
      return null // Already registered
    }

    entry.peers.add(peerId)
    entry.updatedAt = new Date()

    const update: NamespaceUpdate = {
      type: 'namespace-update',
      namespace,
      peers: Array.from(entry.peers),
      action: 'added',
      changedPeerId: peerId,
    }

    this.emit('namespace:updated', update)
    return update
  }

  /**
   * Unregister a peer from a namespace (hub-side).
   * Called when hub receives a namespace-unregister message.
   */
  unregisterPeer(namespace: string, peerId: string): NamespaceUpdate | null {
    const entry = this.registry.get(namespace)

    if (!entry || !entry.peers.has(peerId)) {
      return null // Not registered
    }

    entry.peers.delete(peerId)
    entry.updatedAt = new Date()

    const update: NamespaceUpdate = {
      type: 'namespace-update',
      namespace,
      peers: Array.from(entry.peers),
      action: 'removed',
      changedPeerId: peerId,
    }

    // Clean up empty namespaces
    if (entry.peers.size === 0) {
      this.registry.delete(namespace)
    }

    this.emit('namespace:updated', update)
    return update
  }

  /**
   * Unregister a peer from all namespaces (hub-side).
   * Called when a peer disconnects.
   */
  unregisterPeerFromAll(peerId: string): NamespaceUpdate[] {
    const updates: NamespaceUpdate[] = []

    for (const [namespace, entry] of this.registry) {
      if (entry.peers.has(peerId)) {
        const update = this.unregisterPeer(namespace, peerId)
        if (update) {
          updates.push(update)
        }
      }
    }

    return updates
  }

  /**
   * Create a snapshot of the entire registry (hub-side).
   * Sent to newly joined peers.
   */
  createSnapshot(): NamespaceSnapshot {
    const namespaces: Array<{ namespace: string; peers: string[] }> = []

    for (const [namespace, entry] of this.registry) {
      namespaces.push({
        namespace,
        peers: Array.from(entry.peers),
      })
    }

    return {
      type: 'namespace-snapshot',
      namespaces,
    }
  }

  // ===========================================================================
  // Peer-side Operations (called on all peers)
  // ===========================================================================

  /**
   * Apply a namespace update from hub.
   */
  applyUpdate(update: NamespaceUpdate): void {
    let entry = this.registry.get(update.namespace)

    if (!entry) {
      entry = {
        namespace: update.namespace,
        peers: new Set(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      this.registry.set(update.namespace, entry)
    }

    entry.peers = new Set(update.peers)
    entry.updatedAt = new Date()

    // Clean up empty namespaces
    if (entry.peers.size === 0) {
      this.registry.delete(update.namespace)
    }

    this.emit('namespace:changed', update)
  }

  /**
   * Apply a full snapshot from hub.
   */
  applySnapshot(snapshot: NamespaceSnapshot): void {
    this.registry.clear()

    for (const { namespace, peers } of snapshot.namespaces) {
      this.registry.set(namespace, {
        namespace,
        peers: new Set(peers),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }

    this.emit('namespace:synced', snapshot)
  }

  // ===========================================================================
  // Query Operations
  // ===========================================================================

  /**
   * Get all peers registered for a namespace.
   */
  getPeersForNamespace(namespace: string): string[] {
    const entry = this.registry.get(namespace)
    return entry ? Array.from(entry.peers) : []
  }

  /**
   * Get all namespaces a peer is registered for.
   */
  getNamespacesForPeer(peerId: string): string[] {
    const namespaces: string[] = []

    for (const [namespace, entry] of this.registry) {
      if (entry.peers.has(peerId)) {
        namespaces.push(namespace)
      }
    }

    return namespaces
  }

  /**
   * Get all namespaces and their peers.
   */
  getAllNamespaces(): Map<string, string[]> {
    const result = new Map<string, string[]>()

    for (const [namespace, entry] of this.registry) {
      result.set(namespace, Array.from(entry.peers))
    }

    return result
  }

  /**
   * Check if a peer is registered for a namespace.
   */
  isPeerInNamespace(namespace: string, peerId: string): boolean {
    const entry = this.registry.get(namespace)
    return entry?.peers.has(peerId) ?? false
  }

  /**
   * Clear the registry.
   */
  clear(): void {
    this.registry.clear()
  }
}
