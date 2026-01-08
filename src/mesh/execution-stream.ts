// ExecutionStream - Real-time streaming of execution output
// Implements: i-8hgy

import { EventEmitter } from 'events'

// =============================================================================
// Types
// =============================================================================

/**
 * Streaming execution message types
 */
export type ExecutionStreamMessage =
  | { type: 'exec:start'; executionId: string; command: string; args?: string[]; cwd?: string }
  | { type: 'exec:stdout'; executionId: string; data: string }
  | { type: 'exec:stderr'; executionId: string; data: string }
  | { type: 'exec:exit'; executionId: string; code: number; signal?: string }
  | { type: 'exec:error'; executionId: string; error: string }
  | { type: 'exec:cancel'; executionId: string }

/**
 * Options for streaming execution
 */
export interface StreamingExecutionOptions {
  /** Working directory for command */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Arguments to pass to command */
  args?: string[]
  /** Timeout in ms (0 = no timeout, default: 0 for streaming) */
  timeout?: number
}

/**
 * Streaming execution handler for the server side
 */
export interface StreamingExecutionHandler {
  /** Send stdout data */
  stdout(data: string): void
  /** Send stderr data */
  stderr(data: string): void
  /** Send exit event (final) */
  exit(code: number, signal?: string): void
  /** Send error event (final) */
  error(message: string): void
}

/**
 * Event for incoming streaming execution request
 */
export interface StreamingExecutionRequestEvent {
  /** Unique execution ID */
  executionId: string
  /** Command to execute */
  command: string
  /** Command arguments */
  args?: string[]
  /** Working directory */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Peer that requested execution */
  from: import('../types').PeerInfo
  /** Streaming handler to send output */
  stream: StreamingExecutionHandler
  /** Called when client requests cancellation */
  onCancel: (handler: () => void) => void
}

// =============================================================================
// ExecutionStream
// =============================================================================

/**
 * ExecutionStream represents a streaming execution session.
 *
 * Use this to receive real-time stdout/stderr output from a remote command execution.
 *
 * @example
 * ```typescript
 * const stream = router.requestExecutionWithStream('peer-id', 'npm test')
 *
 * stream.on('stdout', (data) => console.log(data))
 * stream.on('stderr', (data) => console.error(data))
 * stream.on('exit', (code, signal) => console.log('Exited:', code))
 * stream.on('error', (err) => console.error('Error:', err))
 *
 * // Cancel if needed
 * await stream.cancel()
 * ```
 */
export class ExecutionStream extends EventEmitter {
  readonly executionId: string
  readonly peerId: string
  readonly command: string

  private _completed = false
  private _cancelled = false
  private cancelFn: (() => Promise<void>) | null = null

  // Buffered output for convenience
  private _stdout = ''
  private _stderr = ''
  private _exitCode: number | null = null
  private _exitSignal: string | undefined

  constructor(
    executionId: string,
    peerId: string,
    command: string,
    cancelFn: () => Promise<void>
  ) {
    super()
    this.executionId = executionId
    this.peerId = peerId
    this.command = command
    this.cancelFn = cancelFn
  }

  /**
   * Whether the execution has completed (exit or error received)
   */
  get completed(): boolean {
    return this._completed
  }

  /**
   * Whether the execution was cancelled
   */
  get cancelled(): boolean {
    return this._cancelled
  }

  /**
   * Get all stdout output received so far
   */
  get stdout(): string {
    return this._stdout
  }

  /**
   * Get all stderr output received so far
   */
  get stderr(): string {
    return this._stderr
  }

  /**
   * Get the exit code (null if not yet exited)
   */
  get exitCode(): number | null {
    return this._exitCode
  }

  /**
   * Get the exit signal (undefined if not killed by signal)
   */
  get exitSignal(): string | undefined {
    return this._exitSignal
  }

  /**
   * Cancel the execution.
   * Sends a cancel request to the remote peer.
   */
  async cancel(): Promise<void> {
    if (this._completed || this._cancelled) return

    this._cancelled = true

    if (this.cancelFn) {
      await this.cancelFn()
    }

    this.emit('cancelled')
  }

  /**
   * Wait for the execution to complete.
   * Returns the exit code.
   */
  async wait(): Promise<number> {
    if (this._completed) {
      if (this._exitCode !== null) {
        return this._exitCode
      }
      throw new Error('Execution completed with error')
    }

    return new Promise((resolve, reject) => {
      this.once('exit', (code) => resolve(code))
      this.once('error', (err) => reject(err))
    })
  }

  // ==========================================================================
  // Internal: Called by ExecutionRouter when messages arrive
  // ==========================================================================

  /** @internal */
  _receiveStdout(data: string): void {
    if (this._completed) return
    this._stdout += data
    this.emit('stdout', data)
  }

  /** @internal */
  _receiveStderr(data: string): void {
    if (this._completed) return
    this._stderr += data
    this.emit('stderr', data)
  }

  /** @internal */
  _receiveExit(code: number, signal?: string): void {
    if (this._completed) return
    this._completed = true
    this._exitCode = code
    this._exitSignal = signal
    this.emit('exit', code, signal)
  }

  /** @internal */
  _receiveError(error: string): void {
    if (this._completed) return
    this._completed = true
    this.emit('error', new Error(error))
  }
}

// =============================================================================
// StreamBuffer - Output buffering for efficiency
// =============================================================================

const BUFFER_FLUSH_INTERVAL = 100 // ms
const BUFFER_MAX_SIZE = 4096 // 4KB

/**
 * StreamBuffer accumulates output and flushes periodically or when full.
 * This reduces network overhead for rapid output.
 */
export class StreamBuffer {
  private buffer = ''
  private flushTimer: NodeJS.Timeout | null = null
  private flushCallback: (data: string) => void

  constructor(flushCallback: (data: string) => void) {
    this.flushCallback = flushCallback
  }

  /**
   * Add data to the buffer
   */
  write(data: string): void {
    this.buffer += data

    // Flush immediately if buffer is full
    if (this.buffer.length >= BUFFER_MAX_SIZE) {
      this.flush()
      return
    }

    // Schedule a flush if not already scheduled
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), BUFFER_FLUSH_INTERVAL)
    }
  }

  /**
   * Flush the buffer immediately
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (this.buffer.length > 0) {
      this.flushCallback(this.buffer)
      this.buffer = ''
    }
  }

  /**
   * Stop buffering and flush remaining data
   */
  close(): void {
    this.flush()
  }
}
