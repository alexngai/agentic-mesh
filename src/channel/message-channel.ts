// MessageChannel - P2P messaging
// Implements: s-9689

import { EventEmitter } from 'events'
import type { MessageChannelConfig, PeerInfo, ChannelStats } from '../types'
import type { NebulaMesh } from '../mesh/nebula-mesh'

export class MessageChannel<T = unknown> extends EventEmitter {
  readonly name: string
  private mesh: NebulaMesh
  private config: MessageChannelConfig
  private _open = false
  private stats: ChannelStats = {
    messagesSent: 0,
    messagesReceived: 0,
    queuedMessages: 0,
    failedDeliveries: 0,
  }

  constructor(mesh: NebulaMesh, name: string, config?: MessageChannelConfig) {
    super()
    this.mesh = mesh
    this.name = name
    this.config = {
      enableOfflineQueue: config?.enableOfflineQueue ?? true,
      offlineQueueTTL: config?.offlineQueueTTL ?? 86400000,
      maxQueueSize: config?.maxQueueSize ?? 1000,
      retryAttempts: config?.retryAttempts ?? 3,
      retryDelay: config?.retryDelay ?? 1000,
      timeout: config?.timeout ?? 30000,
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async open(): Promise<void> {
    if (this._open) return
    this._open = true
  }

  async close(): Promise<void> {
    if (!this._open) return
    this._open = false
    this.removeAllListeners()
  }

  get isOpen(): boolean {
    return this._open
  }

  // ==========================================================================
  // Sending
  // ==========================================================================

  /**
   * Send a message to a specific peer
   */
  send(peerId: string, message: T): boolean {
    if (!this._open) {
      throw new Error(`Channel ${this.name} is not open`)
    }

    const success = this.mesh._sendToPeer(peerId, this.name, message)

    if (success) {
      this.stats.messagesSent++
    } else {
      this.stats.failedDeliveries++
      // Phase 3: queue for offline peer
    }

    return success
  }

  /**
   * Broadcast a message to all connected peers
   */
  broadcast(message: T): void {
    if (!this._open) {
      throw new Error(`Channel ${this.name} is not open`)
    }

    this.mesh._broadcast(this.name, message)
    this.stats.messagesSent++
  }

  /**
   * Send a message to multiple specific peers
   */
  multicast(peerIds: string[], message: T): Map<string, boolean> {
    const results = new Map<string, boolean>()

    for (const peerId of peerIds) {
      results.set(peerId, this.send(peerId, message))
    }

    return results
  }

  // ==========================================================================
  // Receiving (called by NebulaMesh)
  // ==========================================================================

  /** @internal - Called by NebulaMesh when a message arrives */
  _receiveMessage(message: T, from: PeerInfo): void {
    this.stats.messagesReceived++
    this.emit('message', message, from)
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  getStats(): ChannelStats {
    return { ...this.stats }
  }

  resetStats(): void {
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      queuedMessages: 0,
      failedDeliveries: 0,
    }
  }
}
