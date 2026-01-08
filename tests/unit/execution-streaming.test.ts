import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import {
  ExecutionStream,
  StreamBuffer,
  type ExecutionStreamMessage,
} from '../../src/mesh/execution-stream'

describe('ExecutionStream', () => {
  let stream: ExecutionStream
  let cancelFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    cancelFn = vi.fn().mockResolvedValue(undefined)
    stream = new ExecutionStream('exec-123', 'peer-1', 'npm test', cancelFn)
  })

  describe('properties', () => {
    it('should have correct initial properties', () => {
      expect(stream.executionId).toBe('exec-123')
      expect(stream.peerId).toBe('peer-1')
      expect(stream.command).toBe('npm test')
      expect(stream.completed).toBe(false)
      expect(stream.cancelled).toBe(false)
      expect(stream.stdout).toBe('')
      expect(stream.stderr).toBe('')
      expect(stream.exitCode).toBeNull()
    })
  })

  describe('stdout handling', () => {
    it('should emit stdout events', () => {
      const handler = vi.fn()
      stream.on('stdout', handler)

      stream._receiveStdout('line 1\n')
      stream._receiveStdout('line 2\n')

      expect(handler).toHaveBeenCalledTimes(2)
      expect(handler).toHaveBeenCalledWith('line 1\n')
      expect(handler).toHaveBeenCalledWith('line 2\n')
    })

    it('should accumulate stdout in buffer', () => {
      stream._receiveStdout('line 1\n')
      stream._receiveStdout('line 2\n')

      expect(stream.stdout).toBe('line 1\nline 2\n')
    })

    it('should not emit after completion', () => {
      const handler = vi.fn()
      stream.on('stdout', handler)

      stream._receiveExit(0)
      stream._receiveStdout('late data')

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('stderr handling', () => {
    it('should emit stderr events', () => {
      const handler = vi.fn()
      stream.on('stderr', handler)

      stream._receiveStderr('error 1\n')

      expect(handler).toHaveBeenCalledWith('error 1\n')
    })

    it('should accumulate stderr in buffer', () => {
      stream._receiveStderr('error 1\n')
      stream._receiveStderr('error 2\n')

      expect(stream.stderr).toBe('error 1\nerror 2\n')
    })
  })

  describe('exit handling', () => {
    it('should emit exit event with code', () => {
      const handler = vi.fn()
      stream.on('exit', handler)

      stream._receiveExit(0)

      expect(handler).toHaveBeenCalledWith(0, undefined)
      expect(stream.completed).toBe(true)
      expect(stream.exitCode).toBe(0)
    })

    it('should emit exit event with signal', () => {
      const handler = vi.fn()
      stream.on('exit', handler)

      stream._receiveExit(137, 'SIGKILL')

      expect(handler).toHaveBeenCalledWith(137, 'SIGKILL')
      expect(stream.exitSignal).toBe('SIGKILL')
    })
  })

  describe('error handling', () => {
    it('should emit error event', () => {
      const handler = vi.fn()
      stream.on('error', handler)

      stream._receiveError('Execution failed')

      expect(handler).toHaveBeenCalled()
      const error = handler.mock.calls[0][0]
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('Execution failed')
      expect(stream.completed).toBe(true)
    })
  })

  describe('cancel', () => {
    it('should call cancel function', async () => {
      await stream.cancel()

      expect(cancelFn).toHaveBeenCalled()
      expect(stream.cancelled).toBe(true)
    })

    it('should emit cancelled event', async () => {
      const handler = vi.fn()
      stream.on('cancelled', handler)

      await stream.cancel()

      expect(handler).toHaveBeenCalled()
    })

    it('should be idempotent', async () => {
      await stream.cancel()
      await stream.cancel()

      expect(cancelFn).toHaveBeenCalledTimes(1)
    })

    it('should not cancel if already completed', async () => {
      stream._receiveExit(0)
      await stream.cancel()

      expect(cancelFn).not.toHaveBeenCalled()
    })
  })

  describe('wait', () => {
    it('should resolve with exit code when complete', async () => {
      const waitPromise = stream.wait()
      stream._receiveExit(42)

      const code = await waitPromise
      expect(code).toBe(42)
    })

    it('should reject on error', async () => {
      const waitPromise = stream.wait()
      stream._receiveError('Failed')

      await expect(waitPromise).rejects.toThrow('Failed')
    })

    it('should resolve immediately if already exited', async () => {
      stream._receiveExit(0)
      const code = await stream.wait()
      expect(code).toBe(0)
    })
  })
})

describe('StreamBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('buffering', () => {
    it('should buffer small writes', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      buffer.write('hello')
      buffer.write(' world')

      // Not flushed immediately
      expect(flushFn).not.toHaveBeenCalled()
    })

    it('should flush after interval', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      buffer.write('hello')

      // Advance timer past flush interval
      vi.advanceTimersByTime(150)

      expect(flushFn).toHaveBeenCalledWith('hello')
    })

    it('should combine multiple writes in single flush', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      buffer.write('line 1\n')
      buffer.write('line 2\n')
      buffer.write('line 3\n')

      vi.advanceTimersByTime(150)

      expect(flushFn).toHaveBeenCalledTimes(1)
      expect(flushFn).toHaveBeenCalledWith('line 1\nline 2\nline 3\n')
    })

    it('should flush immediately when buffer is full', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      // Write more than 4KB
      const largeData = 'x'.repeat(5000)
      buffer.write(largeData)

      expect(flushFn).toHaveBeenCalled()
    })

    it('should not flush empty buffer', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      buffer.flush()

      expect(flushFn).not.toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('should flush remaining data on close', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      buffer.write('remaining data')
      buffer.close()

      expect(flushFn).toHaveBeenCalledWith('remaining data')
    })

    it('should clear pending timer on close', () => {
      const flushFn = vi.fn()
      const buffer = new StreamBuffer(flushFn)

      buffer.write('data')
      buffer.close()

      // Advance timer - should not double-flush
      vi.advanceTimersByTime(150)

      expect(flushFn).toHaveBeenCalledTimes(1)
    })
  })
})

describe('ExecutionStreamMessage types', () => {
  it('should have correct type discriminators', () => {
    const startMsg: ExecutionStreamMessage = {
      type: 'exec:start',
      executionId: 'id-1',
      command: 'echo hello',
    }
    expect(startMsg.type).toBe('exec:start')

    const stdoutMsg: ExecutionStreamMessage = {
      type: 'exec:stdout',
      executionId: 'id-1',
      data: 'hello\n',
    }
    expect(stdoutMsg.type).toBe('exec:stdout')

    const stderrMsg: ExecutionStreamMessage = {
      type: 'exec:stderr',
      executionId: 'id-1',
      data: 'error\n',
    }
    expect(stderrMsg.type).toBe('exec:stderr')

    const exitMsg: ExecutionStreamMessage = {
      type: 'exec:exit',
      executionId: 'id-1',
      code: 0,
    }
    expect(exitMsg.type).toBe('exec:exit')

    const errorMsg: ExecutionStreamMessage = {
      type: 'exec:error',
      executionId: 'id-1',
      error: 'failed',
    }
    expect(errorMsg.type).toBe('exec:error')

    const cancelMsg: ExecutionStreamMessage = {
      type: 'exec:cancel',
      executionId: 'id-1',
    }
    expect(cancelMsg.type).toBe('exec:cancel')
  })
})
