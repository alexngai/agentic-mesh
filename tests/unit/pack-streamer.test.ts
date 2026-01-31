/**
 * Pack Streamer Unit Tests
 *
 * Tests for the binary streaming module used for large pack transfers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PackStreamer,
  PackReceiver,
  createPackStreamer,
  createPackReceiver,
} from '../../src/git/pack-streamer'
import type { AnyGitMessage, GitPackChunkMessage, GitPackCompleteMessage } from '../../src/git/types'
import { createHash } from 'crypto'

// =============================================================================
// PackStreamer Tests
// =============================================================================

describe('PackStreamer', () => {
  let streamer: PackStreamer
  let mockSendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    streamer = createPackStreamer({ timeoutMs: 5000 })
    mockSendMessage = vi.fn().mockResolvedValue(undefined)
    streamer.setSendMessage(mockSendMessage)
  })

  describe('streamPack', () => {
    it('should stream pack data in chunks', async () => {
      const data = Buffer.alloc(200, 'x') // 200 bytes
      const chunkSize = 64

      await streamer.streamPack('peer-1', 'corr-123', data, { chunkSize })

      // Should send: init message, 4 chunk messages (200/64 = 4 chunks), complete message
      expect(mockSendMessage).toHaveBeenCalledTimes(6)

      // First call: stream init
      const initCall = mockSendMessage.mock.calls[0]
      expect(initCall[0]).toBe('peer-1')
      expect(initCall[1].type).toBe('git/pack-stream')
      expect(initCall[1].correlationId).toBe('corr-123')
      expect(initCall[1].totalSize).toBe(200)

      // Last call: complete
      const completeCall = mockSendMessage.mock.calls[5]
      expect(completeCall[1].type).toBe('git/pack-complete')
      expect(completeCall[1].totalBytes).toBe(200)
    })

    it('should calculate correct checksum', async () => {
      const data = Buffer.from('hello world')
      const expectedChecksum = createHash('sha256').update(data).digest('hex')

      await streamer.streamPack('peer-1', 'corr-123', data, { chunkSize: 1024 })

      const completeCall = mockSendMessage.mock.calls.find(
        (call) => call[1].type === 'git/pack-complete'
      )
      expect(completeCall[1].checksum).toBe(expectedChecksum)
    })

    it('should report progress', async () => {
      const data = Buffer.alloc(300, 'y')
      const progressFn = vi.fn()

      await streamer.streamPack('peer-1', 'corr-123', data, {
        chunkSize: 100,
        onProgress: progressFn,
      })

      expect(progressFn).toHaveBeenCalledTimes(3)
      expect(progressFn).toHaveBeenNthCalledWith(1, 100, 300)
      expect(progressFn).toHaveBeenNthCalledWith(2, 200, 300)
      expect(progressFn).toHaveBeenNthCalledWith(3, 300, 300)
    })

    it('should emit events during streaming', async () => {
      const data = Buffer.from('test data')
      const progressHandler = vi.fn()
      const completeHandler = vi.fn()

      streamer.on('progress', progressHandler)
      streamer.on('complete', completeHandler)

      await streamer.streamPack('peer-1', 'corr-123', data)

      expect(progressHandler).toHaveBeenCalled()
      expect(completeHandler).toHaveBeenCalledWith(
        expect.any(String), // checksum
        data.length
      )
    })

    it('should throw if send message not set', async () => {
      const noSenderStreamer = createPackStreamer()
      const data = Buffer.from('test')

      await expect(
        noSenderStreamer.streamPack('peer-1', 'corr-123', data)
      ).rejects.toThrow('Send message function not set')
    })

    it('should respect abort signal', async () => {
      const controller = new AbortController()
      const data = Buffer.alloc(1000, 'z')

      // Abort after first chunk
      mockSendMessage.mockImplementation(async () => {
        controller.abort()
      })

      await expect(
        streamer.streamPack('peer-1', 'corr-123', data, {
          chunkSize: 100,
          signal: controller.signal,
        })
      ).rejects.toThrow('Stream aborted')
    })

    it('should mark chunks as final correctly', async () => {
      const data = Buffer.alloc(150, 'a')
      const chunkSize = 64

      await streamer.streamPack('peer-1', 'corr-123', data, { chunkSize })

      const chunkCalls = mockSendMessage.mock.calls.filter(
        (call) => call[1].type === 'git/pack-chunk'
      )

      // 3 chunks: 64, 64, 22 bytes
      expect(chunkCalls).toHaveLength(3)
      expect(chunkCalls[0][1].final).toBe(false)
      expect(chunkCalls[1][1].final).toBe(false)
      expect(chunkCalls[2][1].final).toBe(true)
    })
  })

  describe('receivePack', () => {
    it('should timeout if no complete message received', async () => {
      const promise = streamer.receivePack('peer-1', 'corr-123', 100, 100)

      await expect(promise).rejects.toThrow('Pack stream timeout')
    })
  })

  describe('handleMessage', () => {
    it('should handle stream init message', () => {
      const result = streamer.handleMessage('peer-1', {
        type: 'git/pack-stream',
        correlationId: 'corr-123',
        direction: 'download',
        totalSize: 1000,
      })

      expect(result).toBe(true)
    })

    it('should return false for unknown message type', () => {
      const result = streamer.handleMessage('peer-1', {
        type: 'git/list-refs',
        correlationId: 'corr-123',
        request: {},
      } as AnyGitMessage)

      expect(result).toBe(false)
    })
  })

  describe('cancelIncoming', () => {
    it('should cancel an incoming stream', async () => {
      // Start receiving (creates the stream entry)
      const promise = streamer.receivePack('peer-1', 'corr-123', 100, 60000)

      // Cancel it
      streamer.cancelIncoming('corr-123')

      await expect(promise).rejects.toThrow('Stream cancelled')
    })
  })

  describe('getStats', () => {
    it('should return stream counts', () => {
      const stats = streamer.getStats()

      expect(stats).toEqual({
        incoming: 0,
        outgoing: 0,
      })
    })
  })
})

// =============================================================================
// PackReceiver Tests
// =============================================================================

describe('PackReceiver', () => {
  describe('addChunk', () => {
    it('should accept in-order chunks', () => {
      const receiver = createPackReceiver(300)

      receiver.addChunk(0, Buffer.from('aaa'))
      receiver.addChunk(1, Buffer.from('bbb'))
      receiver.addChunk(2, Buffer.from('ccc'))

      const progress = receiver.getProgress()
      expect(progress.receivedBytes).toBe(9)
      expect(progress.pendingChunks).toBe(0)
    })

    it('should buffer out-of-order chunks', () => {
      const receiver = createPackReceiver()

      receiver.addChunk(2, Buffer.from('ccc'))
      receiver.addChunk(0, Buffer.from('aaa'))

      const progress = receiver.getProgress()
      expect(progress.pendingChunks).toBe(1) // chunk 2 still pending
    })

    it('should process buffered chunks when in-order', () => {
      const receiver = createPackReceiver()

      receiver.addChunk(2, Buffer.from('ccc'))
      receiver.addChunk(0, Buffer.from('aaa'))
      receiver.addChunk(1, Buffer.from('bbb'))

      const progress = receiver.getProgress()
      expect(progress.receivedBytes).toBe(9)
      expect(progress.pendingChunks).toBe(0)
    })

    it('should ignore duplicate chunks', () => {
      const receiver = createPackReceiver()

      receiver.addChunk(0, Buffer.from('aaa'))
      receiver.addChunk(0, Buffer.from('xxx')) // duplicate, should be ignored

      const progress = receiver.getProgress()
      expect(progress.receivedBytes).toBe(3) // only first chunk counted
    })
  })

  describe('complete', () => {
    it('should return complete data with valid checksum', () => {
      const receiver = createPackReceiver()
      const chunk1 = Buffer.from('hello ')
      const chunk2 = Buffer.from('world')
      const fullData = Buffer.concat([chunk1, chunk2])
      const checksum = createHash('sha256').update(fullData).digest('hex')

      receiver.addChunk(0, chunk1)
      receiver.addChunk(1, chunk2)

      const result = receiver.complete(checksum, fullData.length)
      expect(result.toString()).toBe('hello world')
    })

    it('should throw on checksum mismatch', () => {
      const receiver = createPackReceiver()

      receiver.addChunk(0, Buffer.from('data'))

      expect(() => receiver.complete('wrong-checksum', 4)).toThrow('Checksum mismatch')
    })

    it('should throw on size mismatch', () => {
      const receiver = createPackReceiver()
      const data = Buffer.from('test')
      const checksum = createHash('sha256').update(data).digest('hex')

      receiver.addChunk(0, data)

      expect(() => receiver.complete(checksum, 100)).toThrow('Size mismatch')
    })

    it('should throw if chunks are missing', () => {
      const receiver = createPackReceiver()

      receiver.addChunk(0, Buffer.from('aaa'))
      receiver.addChunk(2, Buffer.from('ccc')) // chunk 1 missing

      expect(() => receiver.complete('any', 6)).toThrow('Missing chunks')
    })
  })

  describe('getProgress', () => {
    it('should track total size', () => {
      const receiver = createPackReceiver(1000)

      const progress = receiver.getProgress()
      expect(progress.totalSize).toBe(1000)
    })

    it('should track received bytes', () => {
      const receiver = createPackReceiver()

      receiver.addChunk(0, Buffer.alloc(100))
      receiver.addChunk(1, Buffer.alloc(50))

      const progress = receiver.getProgress()
      expect(progress.receivedBytes).toBe(150)
    })
  })
})

// =============================================================================
// Factory Functions Tests
// =============================================================================

describe('Factory Functions', () => {
  it('createPackStreamer should create a PackStreamer instance', () => {
    const streamer = createPackStreamer()
    expect(streamer).toBeInstanceOf(PackStreamer)
  })

  it('createPackStreamer should accept options', () => {
    const streamer = createPackStreamer({ timeoutMs: 10000 })
    expect(streamer).toBeInstanceOf(PackStreamer)
  })

  it('createPackReceiver should create a PackReceiver instance', () => {
    const receiver = createPackReceiver()
    expect(receiver).toBeInstanceOf(PackReceiver)
  })

  it('createPackReceiver should accept totalSize', () => {
    const receiver = createPackReceiver(5000)
    expect(receiver.getProgress().totalSize).toBe(5000)
  })
})
