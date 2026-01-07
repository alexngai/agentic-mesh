import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { OfflineQueue } from '../../src/channel/offline-queue'

describe('OfflineQueue', () => {
  let queue: OfflineQueue
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'offline-queue-test-' + Date.now())
    await fs.mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    if (queue) {
      await queue.stop()
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('Basic Operations', () => {
    beforeEach(async () => {
      queue = new OfflineQueue()
      await queue.init()
    })

    it('should start empty', () => {
      expect(queue.isEmpty()).toBe(true)
      expect(queue.getStats().total).toBe(0)
    })

    it('should enqueue operations', () => {
      const op = queue.enqueue('test-channel', { data: 'test' }, 'peer-1')

      expect(queue.isEmpty()).toBe(false)
      expect(op.channelName).toBe('test-channel')
      expect(op.message).toEqual({ data: 'test' })
      expect(op.targetPeerId).toBe('peer-1')
      expect(op.attempts).toBe(0)
    })

    it('should dequeue operations', () => {
      const op = queue.enqueue('test-channel', { data: 'test' })
      expect(queue.isEmpty()).toBe(false)

      const removed = queue.dequeue(op.id)
      expect(removed).toBe(true)
      expect(queue.isEmpty()).toBe(true)
    })

    it('should return false when dequeuing non-existent operation', () => {
      const removed = queue.dequeue('non-existent')
      expect(removed).toBe(false)
    })

    it('should clear all operations', () => {
      queue.enqueue('ch1', { a: 1 })
      queue.enqueue('ch2', { b: 2 })
      expect(queue.getStats().total).toBe(2)

      queue.clear()
      expect(queue.isEmpty()).toBe(true)
    })
  })

  describe('Query Operations', () => {
    beforeEach(async () => {
      queue = new OfflineQueue()
      await queue.init()

      queue.enqueue('channel-a', { msg: 1 }, 'peer-1')
      queue.enqueue('channel-a', { msg: 2 }, 'peer-2')
      queue.enqueue('channel-b', { msg: 3 }, 'peer-1')
      queue.enqueue('channel-a', { msg: 4 }, null) // broadcast
    })

    it('should get operations by channel', () => {
      const opsA = queue.getForChannel('channel-a')
      expect(opsA).toHaveLength(3)
      expect(opsA.every((op) => op.channelName === 'channel-a')).toBe(true)

      const opsB = queue.getForChannel('channel-b')
      expect(opsB).toHaveLength(1)
    })

    it('should get operations by peer', () => {
      const peer1Ops = queue.getForPeer('peer-1')
      // peer-1 targeted + broadcast (null target)
      expect(peer1Ops).toHaveLength(3)
    })

    it('should get stats by channel', () => {
      const stats = queue.getStats()
      expect(stats.total).toBe(4)
      expect(stats.byChannel.get('channel-a')).toBe(3)
      expect(stats.byChannel.get('channel-b')).toBe(1)
    })
  })

  describe('Retry Logic', () => {
    beforeEach(async () => {
      queue = new OfflineQueue({ maxRetries: 3, retryDelay: 100 })
      await queue.init()
    })

    it('should track attempt count', () => {
      const op = queue.enqueue('ch', { data: 1 })
      expect(op.attempts).toBe(0)

      queue.markAttempted(op.id)
      const ops = queue.getForChannel('ch')
      expect(ops[0].attempts).toBe(1)
    })

    it('should remove after max retries', () => {
      const failedHandler = vi.fn()
      queue.on('failed', failedHandler)

      const op = queue.enqueue('ch', { data: 1 })
      queue.markAttempted(op.id)
      queue.markAttempted(op.id)
      queue.markAttempted(op.id) // 3rd attempt = max retries

      expect(queue.isEmpty()).toBe(true)
      expect(failedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: op.id })
      )
    })

    it('should respect retry delay (exponential backoff)', async () => {
      const op = queue.enqueue('ch', { data: 1 })
      queue.markAttempted(op.id)

      // Immediately after first attempt, should not be ready
      const readyNow = queue.getReadyForRetry()
      expect(readyNow.find((o) => o.id === op.id)).toBeUndefined()

      // Wait for retry delay
      await new Promise((r) => setTimeout(r, 150))

      const readyLater = queue.getReadyForRetry()
      expect(readyLater.find((o) => o.id === op.id)).toBeDefined()
    })
  })

  describe('TTL and Expiration', () => {
    it('should set expiration based on TTL', async () => {
      queue = new OfflineQueue({ ttl: 1000 }) // 1 second TTL
      await queue.init()

      const op = queue.enqueue('ch', { data: 1 })
      const expiresIn = op.expiresAt.getTime() - op.createdAt.getTime()
      expect(expiresIn).toBe(1000)
    })

    it('should prune expired operations on query', async () => {
      queue = new OfflineQueue({ ttl: 100 }) // 100ms TTL
      await queue.init()

      queue.enqueue('ch', { data: 1 })
      expect(queue.getStats().total).toBe(1)

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 150))

      // Query triggers pruning
      const ops = queue.getForChannel('ch')
      expect(ops).toHaveLength(0)
    })
  })

  describe('Max Size Enforcement', () => {
    it('should enforce max size by pruning oldest', async () => {
      queue = new OfflineQueue({ maxSize: 3 })
      await queue.init()

      const op1 = queue.enqueue('ch', { msg: 1 })
      await new Promise((r) => setTimeout(r, 10))
      queue.enqueue('ch', { msg: 2 })
      await new Promise((r) => setTimeout(r, 10))
      queue.enqueue('ch', { msg: 3 })
      await new Promise((r) => setTimeout(r, 10))

      // This should trigger pruning of oldest (op1)
      queue.enqueue('ch', { msg: 4 })

      expect(queue.getStats().total).toBe(3)
      const ops = queue.getForChannel('ch')
      expect(ops.find((o) => o.id === op1.id)).toBeUndefined()
    })
  })

  describe('Flush', () => {
    beforeEach(async () => {
      queue = new OfflineQueue()
      await queue.init()
    })

    it('should flush with successful sends', async () => {
      queue.enqueue('ch', { msg: 1 }, 'peer-1')
      queue.enqueue('ch', { msg: 2 }, 'peer-2')

      const sendFn = vi.fn().mockResolvedValue(true)
      const result = await queue.flush(sendFn)

      expect(result.sent).toBe(2)
      expect(result.failed).toBe(0)
      expect(queue.isEmpty()).toBe(true)
    })

    it('should handle failed sends', async () => {
      queue.enqueue('ch', { msg: 1 }, 'peer-1')

      const sendFn = vi.fn().mockResolvedValue(false)
      const result = await queue.flush(sendFn)

      expect(result.sent).toBe(0)
      expect(result.failed).toBe(1)
      expect(queue.isEmpty()).toBe(false) // Still in queue for retry
    })

    it('should handle send errors', async () => {
      queue.enqueue('ch', { msg: 1 }, 'peer-1')

      const sendFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const result = await queue.flush(sendFn)

      expect(result.sent).toBe(0)
      expect(result.failed).toBe(1)
    })
  })

  describe('Persistence', () => {
    it('should persist to disk', async () => {
      queue = new OfflineQueue({ persistPath: tmpDir })
      await queue.init()

      queue.enqueue('ch', { msg: 'persisted' })
      await queue.stop()

      const filePath = path.join(tmpDir, 'offline-queue.json')
      const content = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(content)

      expect(data).toHaveLength(1)
      expect(data[0].message.msg).toBe('persisted')
    })

    it('should load from disk on init', async () => {
      // First instance writes
      queue = new OfflineQueue({ persistPath: tmpDir })
      await queue.init()
      queue.enqueue('ch', { msg: 'recovered' })
      await queue.stop()

      // Second instance reads
      const queue2 = new OfflineQueue({ persistPath: tmpDir })
      await queue2.init()

      expect(queue2.getStats().total).toBe(1)
      const ops = queue2.getForChannel('ch')
      expect(ops[0].message).toEqual({ msg: 'recovered' })

      await queue2.stop()
    })

    it('should not load expired operations', async () => {
      // Write directly to file with expired timestamp
      const expiredOp = {
        id: 'expired',
        channelName: 'ch',
        message: { msg: 'old' },
        targetPeerId: null,
        createdAt: new Date(Date.now() - 100000),
        expiresAt: new Date(Date.now() - 50000), // Already expired
        attempts: 0,
        lastAttempt: null,
      }

      await fs.mkdir(tmpDir, { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'offline-queue.json'),
        JSON.stringify([expiredOp])
      )

      queue = new OfflineQueue({ persistPath: tmpDir })
      await queue.init()

      expect(queue.isEmpty()).toBe(true)
    })
  })

  describe('Events', () => {
    beforeEach(async () => {
      queue = new OfflineQueue()
      await queue.init()
    })

    it('should emit enqueued event', () => {
      const handler = vi.fn()
      queue.on('enqueued', handler)

      queue.enqueue('ch', { data: 1 })

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ channelName: 'ch' })
      )
    })

    it('should emit dequeued event', () => {
      const handler = vi.fn()
      queue.on('dequeued', handler)

      const op = queue.enqueue('ch', { data: 1 })
      queue.dequeue(op.id)

      expect(handler).toHaveBeenCalledWith(op.id)
    })

    it('should emit cleared event', () => {
      const handler = vi.fn()
      queue.on('cleared', handler)

      queue.enqueue('ch', { data: 1 })
      queue.clear()

      expect(handler).toHaveBeenCalled()
    })

    it('should emit flushed event', async () => {
      const handler = vi.fn()
      queue.on('flushed', handler)

      queue.enqueue('ch', { data: 1 })
      await queue.flush(async () => true)

      expect(handler).toHaveBeenCalledWith({ sent: 1, failed: 0 })
    })
  })
})
