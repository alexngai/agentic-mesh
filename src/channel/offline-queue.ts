// Offline Queue - Hybrid mode message queueing
// Part of Phase 3.3

import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'

export interface QueuedOperation<T = unknown> {
  id: string
  channelName: string
  message: T
  targetPeerId: string | null // null for broadcast
  createdAt: Date
  expiresAt: Date
  attempts: number
  lastAttempt: Date | null
}

export interface OfflineQueueConfig {
  /** Directory to persist queue (optional, uses memory if not set) */
  persistPath?: string
  /** Time-to-live for queued messages in ms (default: 24h) */
  ttl?: number
  /** Maximum queue size (default: 1000) */
  maxSize?: number
  /** Retry delay in ms (default: 1000) */
  retryDelay?: number
  /** Max retry attempts (default: 3) */
  maxRetries?: number
}

const DEFAULT_TTL = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_MAX_SIZE = 1000
const DEFAULT_RETRY_DELAY = 1000
const DEFAULT_MAX_RETRIES = 3

/**
 * OfflineQueue provides message queueing for offline/disconnected scenarios.
 * Implements hybrid mode: nodes operate independently, sync with hub when possible.
 *
 * Features:
 * - Persists queue to disk for crash recovery
 * - TTL-based message expiration
 * - Automatic retry with backoff
 * - CRDT-friendly (messages are idempotent updates)
 */
export class OfflineQueue extends EventEmitter {
  private config: Required<OfflineQueueConfig>
  private queue: Map<string, QueuedOperation> = new Map()
  private flushTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(config: OfflineQueueConfig = {}) {
    super()
    this.config = {
      persistPath: config.persistPath ?? '',
      ttl: config.ttl ?? DEFAULT_TTL,
      maxSize: config.maxSize ?? DEFAULT_MAX_SIZE,
      retryDelay: config.retryDelay ?? DEFAULT_RETRY_DELAY,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Initialize the queue, loading persisted state if available.
   */
  async init(): Promise<void> {
    if (this.config.persistPath) {
      await this.loadFromDisk()
    }

    // Start periodic persist timer
    if (this.config.persistPath) {
      this.persistTimer = setInterval(() => {
        if (this.dirty) {
          this.persistToDisk().catch(() => {})
        }
      }, 5000) // Persist every 5 seconds if dirty
    }
  }

  /**
   * Stop the queue, persisting final state.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = null
    }

    if (this.config.persistPath && this.dirty) {
      await this.persistToDisk()
    }
  }

  // ===========================================================================
  // Queue Operations
  // ===========================================================================

  /**
   * Add an operation to the queue.
   */
  enqueue<T>(
    channelName: string,
    message: T,
    targetPeerId: string | null = null
  ): QueuedOperation<T> {
    // Enforce max size
    if (this.queue.size >= this.config.maxSize) {
      this.pruneOldest()
    }

    const now = new Date()
    const op: QueuedOperation<T> = {
      id: crypto.randomUUID(),
      channelName,
      message,
      targetPeerId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.ttl),
      attempts: 0,
      lastAttempt: null,
    }

    this.queue.set(op.id, op)
    this.dirty = true

    this.emit('enqueued', op)
    return op
  }

  /**
   * Remove an operation from the queue (after successful delivery).
   */
  dequeue(id: string): boolean {
    const existed = this.queue.delete(id)
    if (existed) {
      this.dirty = true
      this.emit('dequeued', id)
    }
    return existed
  }

  /**
   * Mark an operation as attempted (for retry tracking).
   */
  markAttempted(id: string): boolean {
    const op = this.queue.get(id)
    if (!op) return false

    op.attempts++
    op.lastAttempt = new Date()
    this.dirty = true

    // Remove if max retries exceeded
    if (op.attempts >= this.config.maxRetries) {
      this.queue.delete(id)
      this.emit('failed', op)
      return false
    }

    return true
  }

  /**
   * Get all pending operations for a channel.
   */
  getForChannel(channelName: string): QueuedOperation[] {
    this.pruneExpired()

    const ops: QueuedOperation[] = []
    for (const op of this.queue.values()) {
      if (op.channelName === channelName) {
        ops.push(op)
      }
    }

    return ops.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  /**
   * Get all pending operations for a specific target peer.
   */
  getForPeer(peerId: string): QueuedOperation[] {
    this.pruneExpired()

    const ops: QueuedOperation[] = []
    for (const op of this.queue.values()) {
      if (op.targetPeerId === peerId || op.targetPeerId === null) {
        ops.push(op)
      }
    }

    return ops.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  /**
   * Get operations ready for retry.
   */
  getReadyForRetry(): QueuedOperation[] {
    this.pruneExpired()

    const now = Date.now()
    const ops: QueuedOperation[] = []

    for (const op of this.queue.values()) {
      // Skip if recently attempted
      if (op.lastAttempt) {
        const backoff = this.config.retryDelay * Math.pow(2, op.attempts - 1)
        const nextRetry = op.lastAttempt.getTime() + backoff
        if (now < nextRetry) continue
      }

      ops.push(op)
    }

    return ops.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  /**
   * Get queue statistics.
   */
  getStats(): { total: number; byChannel: Map<string, number> } {
    const byChannel = new Map<string, number>()

    for (const op of this.queue.values()) {
      const count = byChannel.get(op.channelName) ?? 0
      byChannel.set(op.channelName, count + 1)
    }

    return {
      total: this.queue.size,
      byChannel,
    }
  }

  /**
   * Check if queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.size === 0
  }

  /**
   * Clear all queued operations.
   */
  clear(): void {
    this.queue.clear()
    this.dirty = true
    this.emit('cleared')
  }

  // ===========================================================================
  // Flush Operations
  // ===========================================================================

  /**
   * Schedule a flush attempt using the provided send function.
   * Returns a promise that resolves when all messages are sent or failed.
   */
  async flush(
    sendFn: (op: QueuedOperation) => Promise<boolean>
  ): Promise<{ sent: number; failed: number }> {
    const ready = this.getReadyForRetry()
    let sent = 0
    let failed = 0

    for (const op of ready) {
      try {
        const success = await sendFn(op)
        if (success) {
          this.dequeue(op.id)
          sent++
        } else {
          this.markAttempted(op.id)
          failed++
        }
      } catch {
        this.markAttempted(op.id)
        failed++
      }
    }

    this.emit('flushed', { sent, failed })
    return { sent, failed }
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  private async loadFromDisk(): Promise<void> {
    try {
      const filePath = path.join(this.config.persistPath, 'offline-queue.json')
      const content = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(content) as QueuedOperation[]

      for (const op of data) {
        // Restore dates
        op.createdAt = new Date(op.createdAt)
        op.expiresAt = new Date(op.expiresAt)
        op.lastAttempt = op.lastAttempt ? new Date(op.lastAttempt) : null

        // Skip expired
        if (op.expiresAt.getTime() > Date.now()) {
          this.queue.set(op.id, op)
        }
      }

      this.emit('loaded', this.queue.size)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.emit('error', err)
      }
    }
  }

  private async persistToDisk(): Promise<void> {
    if (!this.config.persistPath) return

    try {
      await fs.mkdir(this.config.persistPath, { recursive: true })
      const filePath = path.join(this.config.persistPath, 'offline-queue.json')
      const data = Array.from(this.queue.values())
      await fs.writeFile(filePath, JSON.stringify(data, null, 2))
      this.dirty = false
      this.emit('persisted', this.queue.size)
    } catch (err) {
      this.emit('error', err)
    }
  }

  // ===========================================================================
  // Pruning
  // ===========================================================================

  private pruneExpired(): void {
    const now = Date.now()
    let pruned = 0

    for (const [id, op] of this.queue) {
      if (op.expiresAt.getTime() < now) {
        this.queue.delete(id)
        pruned++
      }
    }

    if (pruned > 0) {
      this.dirty = true
      this.emit('pruned', pruned)
    }
  }

  private pruneOldest(): void {
    // Find and remove oldest operation
    let oldest: QueuedOperation | null = null
    for (const op of this.queue.values()) {
      if (!oldest || op.createdAt < oldest.createdAt) {
        oldest = op
      }
    }

    if (oldest) {
      this.queue.delete(oldest.id)
      this.dirty = true
      this.emit('pruned', 1)
    }
  }
}
