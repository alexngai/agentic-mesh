// ExecutionRouter - Remote execution routing between peers
// Implements: i-9ot8, i-8hgy (streaming)

import { EventEmitter } from 'events'
import type { NebulaMesh } from './nebula-mesh'
import type { PeerInfo } from '../types'
import { MessageChannel } from '../channel/message-channel'
import {
  ExecutionStream,
  StreamBuffer,
  type ExecutionStreamMessage,
  type StreamingExecutionOptions,
  type StreamingExecutionRequestEvent,
  type StreamingExecutionHandler,
} from './execution-stream'

// =============================================================================
// Types
// =============================================================================

export interface ExecutionRequest {
  /** Unique request ID for correlation */
  requestId: string
  /** Command to execute */
  command: string
  /** Optional arguments */
  args?: string[]
  /** Optional working directory */
  cwd?: string
  /** Optional environment variables */
  env?: Record<string, string>
  /** Optional timeout in ms (default: 30000) */
  timeout?: number
}

export interface ExecutionResponse {
  /** Request ID for correlation */
  requestId: string
  /** Whether execution was successful */
  success: boolean
  /** Exit code (0 for success) */
  exitCode?: number
  /** Standard output */
  stdout?: string
  /** Standard error */
  stderr?: string
  /** Error message if execution failed */
  error?: string
}

export interface ExecutionRequestEvent {
  /** The execution request */
  request: ExecutionRequest
  /** The peer that requested execution */
  from: PeerInfo
  /** Function to send the response */
  respond: (response: Omit<ExecutionResponse, 'requestId'>) => void
}

export interface ExecutionRouterConfig {
  /** Default timeout for execution requests in ms (default: 30000) */
  defaultTimeout?: number
  /** Required groups for execution permission (empty = allow all) */
  requiredGroups?: string[]
  /** Maximum concurrent executions (default: 10) */
  maxConcurrent?: number
}

type ExecutionMessage =
  | { type: 'request'; data: ExecutionRequest }
  | { type: 'response'; data: ExecutionResponse }

// =============================================================================
// ExecutionRouter
// =============================================================================

const DEFAULT_TIMEOUT = 30000
const DEFAULT_MAX_CONCURRENT = 10

export class ExecutionRouter extends EventEmitter {
  private mesh: NebulaMesh
  private config: Required<ExecutionRouterConfig>
  private channel: MessageChannel<ExecutionMessage>
  private streamChannel: MessageChannel<ExecutionStreamMessage>
  private pendingRequests: Map<
    string,
    {
      resolve: (response: ExecutionResponse) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  > = new Map()
  private activeExecutions = 0
  private _started = false

  // Streaming support
  private activeStreams: Map<string, ExecutionStream> = new Map()
  private streamCancelHandlers: Map<string, () => void> = new Map()

  constructor(mesh: NebulaMesh, config: ExecutionRouterConfig = {}) {
    super()
    this.mesh = mesh
    this.config = {
      defaultTimeout: config.defaultTimeout ?? DEFAULT_TIMEOUT,
      requiredGroups: config.requiredGroups ?? [],
      maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    }

    // Create dedicated channel for execution messages
    this.channel = mesh.createChannel<ExecutionMessage>('exec:router')

    // Create dedicated channel for streaming execution
    this.streamChannel = mesh.createChannel<ExecutionStreamMessage>('exec:stream')

    // Handle incoming messages
    this.channel.on('message', (msg, from) => {
      if (msg.type === 'request') {
        this.handleRequest(msg.data, from)
      } else if (msg.type === 'response') {
        this.handleResponse(msg.data)
      }
    })

    // Handle streaming messages
    this.streamChannel.on('message', (msg, from) => {
      this.handleStreamMessage(msg, from)
    })

    // Auto-start the router (open channel)
    this.start().catch(() => {
      // Ignore startup errors - will be handled when trying to send
    })
  }

  /**
   * Start the execution router (opens the channels).
   * Called automatically in constructor, but can be called manually if needed.
   */
  async start(): Promise<void> {
    if (this._started) return
    await this.channel.open()
    await this.streamChannel.open()
    this._started = true
  }

  /**
   * Stop the execution router and close the channels.
   */
  async stop(): Promise<void> {
    if (!this._started) return
    this.cancelAll()
    this.cancelAllStreams()
    await this.channel.close()
    await this.streamChannel.close()
    this._started = false
  }

  /**
   * Cancel all active streams.
   */
  private cancelAllStreams(): void {
    for (const stream of this.activeStreams.values()) {
      stream.cancel().catch(() => {
        // Ignore cancel errors during shutdown
      })
    }
    this.activeStreams.clear()
    this.streamCancelHandlers.clear()
  }

  /**
   * Check if the router is started.
   */
  get started(): boolean {
    return this._started
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Request execution of a command on a remote peer.
   * Returns a promise that resolves with the execution result.
   */
  async requestExecution(
    peerId: string,
    command: string,
    options: Omit<ExecutionRequest, 'requestId' | 'command'> = {}
  ): Promise<ExecutionResponse> {
    const peer = this.mesh.getPeer(peerId)
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`)
    }

    if (peer.status !== 'online') {
      throw new Error(`Peer is not online: ${peerId}`)
    }

    const requestId = crypto.randomUUID()
    const timeout = options.timeout ?? this.config.defaultTimeout

    const request: ExecutionRequest = {
      requestId,
      command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      timeout,
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Execution request timed out after ${timeout}ms`))
      }, timeout)

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject, timer })

      // Send request
      const sent = this.channel.send(peerId, { type: 'request', data: request })
      if (!sent) {
        this.pendingRequests.delete(requestId)
        clearTimeout(timer)
        reject(new Error(`Failed to send execution request to peer: ${peerId}`))
      }
    })
  }

  /**
   * Broadcast an execution request to all peers.
   * Returns results from all peers that respond before timeout.
   */
  async broadcastExecution(
    command: string,
    options: Omit<ExecutionRequest, 'requestId' | 'command'> = {}
  ): Promise<Map<string, ExecutionResponse>> {
    const peers = this.mesh.getPeers().filter((p) => p.status === 'online')
    const results = new Map<string, ExecutionResponse>()

    const promises = peers.map(async (peer) => {
      try {
        const response = await this.requestExecution(peer.id, command, options)
        results.set(peer.id, response)
      } catch (error) {
        results.set(peer.id, {
          requestId: '',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    })

    await Promise.all(promises)
    return results
  }

  /**
   * Get the number of pending execution requests.
   */
  get pendingCount(): number {
    return this.pendingRequests.size
  }

  /**
   * Get the number of active executions on this peer.
   */
  get activeCount(): number {
    return this.activeExecutions
  }

  /**
   * Cancel a pending execution request.
   */
  cancelRequest(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Request cancelled'))
      this.pendingRequests.delete(requestId)
      return true
    }
    return false
  }

  /**
   * Cancel all pending requests.
   */
  cancelAll(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Request cancelled'))
    }
    this.pendingRequests.clear()
  }

  // ==========================================================================
  // Streaming Execution API
  // ==========================================================================

  /**
   * Request streaming execution of a command on a remote peer.
   * Returns an ExecutionStream that emits stdout/stderr/exit events in real-time.
   *
   * @param peerId Target peer to execute on
   * @param command Command to execute
   * @param options Execution options
   * @returns ExecutionStream for receiving output
   *
   * @example
   * ```typescript
   * const stream = router.requestExecutionWithStream('peer-id', 'npm test')
   * stream.on('stdout', (data) => console.log(data))
   * stream.on('stderr', (data) => console.error(data))
   * stream.on('exit', (code) => console.log('Done:', code))
   * ```
   */
  requestExecutionWithStream(
    peerId: string,
    command: string,
    options: StreamingExecutionOptions = {}
  ): ExecutionStream {
    const peer = this.mesh.getPeer(peerId)
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`)
    }

    if (peer.status !== 'online') {
      throw new Error(`Peer is not online: ${peerId}`)
    }

    const executionId = crypto.randomUUID()

    // Create cancel function
    const cancelFn = async () => {
      this.streamChannel.send(peerId, {
        type: 'exec:cancel',
        executionId,
      })
      this.activeStreams.delete(executionId)
    }

    // Create stream
    const stream = new ExecutionStream(executionId, peerId, command, cancelFn)
    this.activeStreams.set(executionId, stream)

    // Send start message
    const startMsg: ExecutionStreamMessage = {
      type: 'exec:start',
      executionId,
      command,
      args: options.args,
      cwd: options.cwd,
    }

    const sent = this.streamChannel.send(peerId, startMsg)
    if (!sent) {
      this.activeStreams.delete(executionId)
      throw new Error(`Failed to send streaming execution request to peer: ${peerId}`)
    }

    return stream
  }

  /**
   * Get the number of active streaming executions.
   */
  get activeStreamCount(): number {
    return this.activeStreams.size
  }

  /**
   * Cancel a streaming execution by ID.
   */
  cancelStream(executionId: string): boolean {
    const stream = this.activeStreams.get(executionId)
    if (stream) {
      stream.cancel().catch(() => {})
      this.activeStreams.delete(executionId)
      return true
    }
    return false
  }

  // ==========================================================================
  // Internal: Message Handling
  // ==========================================================================

  private handleRequest(request: ExecutionRequest, from: PeerInfo): void {
    // Check permission
    if (!this.checkPermission(from)) {
      this.sendResponse(from.id, {
        requestId: request.requestId,
        success: false,
        error: 'Permission denied: insufficient group membership',
      })
      return
    }

    // Check concurrent execution limit
    if (this.activeExecutions >= this.config.maxConcurrent) {
      this.sendResponse(from.id, {
        requestId: request.requestId,
        success: false,
        error: 'Execution limit reached: too many concurrent executions',
      })
      return
    }

    this.activeExecutions++

    // Create response function
    const respond = (response: Omit<ExecutionResponse, 'requestId'>) => {
      this.activeExecutions--
      this.sendResponse(from.id, {
        ...response,
        requestId: request.requestId,
      })
    }

    // Emit event for handler to process
    const event: ExecutionRequestEvent = {
      request,
      from,
      respond,
    }

    this.emit('execution:requested', event)

    // If no handler responds within the request timeout, send error
    const timeout = request.timeout ?? this.config.defaultTimeout
    setTimeout(() => {
      // Check if this request is still active (not responded to)
      // We can't easily track this, so we rely on the handler to respond
    }, timeout)
  }

  private handleResponse(response: ExecutionResponse): void {
    const pending = this.pendingRequests.get(response.requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingRequests.delete(response.requestId)
      pending.resolve(response)
    }
  }

  private sendResponse(peerId: string, response: ExecutionResponse): void {
    this.channel.send(peerId, { type: 'response', data: response })
  }

  private checkPermission(peer: PeerInfo): boolean {
    // If no required groups, allow all
    if (this.config.requiredGroups.length === 0) {
      return true
    }

    // Check if peer has at least one required group
    return this.config.requiredGroups.some((group) => peer.groups.includes(group))
  }

  // ==========================================================================
  // Internal: Streaming Message Handling
  // ==========================================================================

  private handleStreamMessage(msg: ExecutionStreamMessage, from: PeerInfo): void {
    switch (msg.type) {
      case 'exec:start':
        this.handleStreamStart(msg, from)
        break
      case 'exec:stdout':
        this.handleStreamOutput(msg.executionId, 'stdout', msg.data)
        break
      case 'exec:stderr':
        this.handleStreamOutput(msg.executionId, 'stderr', msg.data)
        break
      case 'exec:exit':
        this.handleStreamExit(msg.executionId, msg.code, msg.signal)
        break
      case 'exec:error':
        this.handleStreamError(msg.executionId, msg.error)
        break
      case 'exec:cancel':
        this.handleStreamCancel(msg.executionId)
        break
    }
  }

  private handleStreamStart(
    msg: Extract<ExecutionStreamMessage, { type: 'exec:start' }>,
    from: PeerInfo
  ): void {
    // Check permission
    if (!this.checkPermission(from)) {
      this.streamChannel.send(from.id, {
        type: 'exec:error',
        executionId: msg.executionId,
        error: 'Permission denied: insufficient group membership',
      })
      return
    }

    // Check concurrent execution limit
    if (this.activeExecutions >= this.config.maxConcurrent) {
      this.streamChannel.send(from.id, {
        type: 'exec:error',
        executionId: msg.executionId,
        error: 'Execution limit reached: too many concurrent executions',
      })
      return
    }

    this.activeExecutions++

    // Create buffered stream handlers
    const stdoutBuffer = new StreamBuffer((data) => {
      this.streamChannel.send(from.id, {
        type: 'exec:stdout',
        executionId: msg.executionId,
        data,
      })
    })

    const stderrBuffer = new StreamBuffer((data) => {
      this.streamChannel.send(from.id, {
        type: 'exec:stderr',
        executionId: msg.executionId,
        data,
      })
    })

    // Create streaming handler
    const streamHandler: StreamingExecutionHandler = {
      stdout: (data: string) => stdoutBuffer.write(data),
      stderr: (data: string) => stderrBuffer.write(data),
      exit: (code: number, signal?: string) => {
        stdoutBuffer.close()
        stderrBuffer.close()
        this.activeExecutions--
        this.streamCancelHandlers.delete(msg.executionId)
        this.streamChannel.send(from.id, {
          type: 'exec:exit',
          executionId: msg.executionId,
          code,
          signal,
        })
      },
      error: (message: string) => {
        stdoutBuffer.close()
        stderrBuffer.close()
        this.activeExecutions--
        this.streamCancelHandlers.delete(msg.executionId)
        this.streamChannel.send(from.id, {
          type: 'exec:error',
          executionId: msg.executionId,
          error: message,
        })
      },
    }

    // Track cancel handler
    let cancelHandler: (() => void) | null = null
    this.streamCancelHandlers.set(msg.executionId, () => {
      if (cancelHandler) cancelHandler()
    })

    // Emit event for handler to process
    const event: StreamingExecutionRequestEvent = {
      executionId: msg.executionId,
      command: msg.command,
      args: msg.args,
      cwd: msg.cwd,
      from,
      stream: streamHandler,
      onCancel: (handler) => {
        cancelHandler = handler
      },
    }

    this.emit('execution:streaming', event)
  }

  private handleStreamOutput(executionId: string, type: 'stdout' | 'stderr', data: string): void {
    const stream = this.activeStreams.get(executionId)
    if (stream) {
      if (type === 'stdout') {
        stream._receiveStdout(data)
      } else {
        stream._receiveStderr(data)
      }
    }
  }

  private handleStreamExit(executionId: string, code: number, signal?: string): void {
    const stream = this.activeStreams.get(executionId)
    if (stream) {
      stream._receiveExit(code, signal)
      this.activeStreams.delete(executionId)
    }
  }

  private handleStreamError(executionId: string, error: string): void {
    const stream = this.activeStreams.get(executionId)
    if (stream) {
      stream._receiveError(error)
      this.activeStreams.delete(executionId)
    }
  }

  private handleStreamCancel(executionId: string): void {
    const cancelHandler = this.streamCancelHandlers.get(executionId)
    if (cancelHandler) {
      cancelHandler()
      this.streamCancelHandlers.delete(executionId)
    }
  }
}
