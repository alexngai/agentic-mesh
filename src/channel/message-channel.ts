// MessageChannel - P2P messaging
// Implements: s-9689

import { EventEmitter } from 'events'
import type { MessageChannelConfig, PeerInfo, ChannelStats } from '../types'
import type { NebulaMesh } from '../mesh/nebula-mesh'
import { OfflineQueue } from './offline-queue'

export class MessageChannel<T = unknown> extends EventEmitter {
  readonly name: string
  private mesh: NebulaMesh
  private config: Required<MessageChannelConfig>
  private _open = false
  private offlineQueue: OfflineQueue | null = null
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

    // Initialize offline queue if enabled
    if (this.config.enableOfflineQueue) {
      this.offlineQueue = new OfflineQueue({
        ttl: this.config.offlineQueueTTL,
        maxSize: this.config.maxQueueSize,
        maxRetries: this.config.retryAttempts,
        retryDelay: this.config.retryDelay,
      })
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async open(): Promise<void> {
    if (this._open) return

    if (this.offlineQueue) {
      await this.offlineQueue.init()

      // Listen for peer reconnection to flush queue
      this.mesh.on('peer:joined', this.handlePeerJoined)
    }

    this._open = true
  }

  async close(): Promise<void> {
    if (!this._open) return

    this.mesh.off('peer:joined', this.handlePeerJoined)

    if (this.offlineQueue) {
      await this.offlineQueue.stop()
    }

    this._open = false
    this.removeAllListeners()
  }

  get isOpen(): boolean {
    return this._open
  }

  private handlePeerJoined = async (peer: PeerInfo): Promise<void> => {
    if (!this.offlineQueue) return

    // Flush queued messages to the reconnected peer
    const ops = this.offlineQueue.getForPeer(peer.id)
    for (const op of ops) {
      const success = this.mesh._sendToPeer(peer.id, this.name, op.message)
      if (success) {
        this.offlineQueue.dequeue(op.id)
        this.stats.messagesSent++
        this.stats.queuedMessages--
      }
    }
  }

  // ==========================================================================
  // Sending
  // ==========================================================================

  /**
   * Send a message to a specific peer.
   * If the peer is offline and queueing is enabled, the message will be queued.
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

      // Queue for offline peer if enabled
      if (this.offlineQueue) {
        this.offlineQueue.enqueue(this.name, message, peerId)
        this.stats.queuedMessages++
      }
    }

    return success
  }

  /**
   * Send a message to a specific peer, with automatic queueing if offline.
   * Returns true if sent or queued, false only if queueing is disabled and send fails.
   */
  sendWithQueue(peerId: string, message: T): boolean {
    if (!this._open) {
      throw new Error(`Channel ${this.name} is not open`)
    }

    const success = this.mesh._sendToPeer(peerId, this.name, message)

    if (success) {
      this.stats.messagesSent++
      return true
    }

    // Queue for offline peer if enabled
    if (this.offlineQueue) {
      this.offlineQueue.enqueue(this.name, message, peerId)
      this.stats.queuedMessages++
      return true // Queued counts as success
    }

    this.stats.failedDeliveries++
    return false
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
