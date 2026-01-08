// MessageChannel - P2P messaging
// Implements: s-9689

import { EventEmitter } from 'events'
import type { MessageChannelConfig, PeerInfo, ChannelStats } from '../types'
import type { NebulaMesh } from '../mesh/nebula-mesh'
import { OfflineQueue } from './offline-queue'

// Error types for RPC
export class RPCTimeoutError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly timeout: number
  ) {
    super(`RPC request ${requestId} timed out after ${timeout}ms`)
    this.name = 'RPCTimeoutError'
  }
}

export class RPCError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly originalMessage: string
  ) {
    super(`RPC error for request ${requestId}: ${originalMessage}`)
    this.name = 'RPCError'
  }
}

// Pending request tracking
interface PendingRequest {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// Request handler type
type RequestHandler<T> = (message: T, from: PeerInfo) => Promise<unknown>

export class MessageChannel<T = unknown> extends EventEmitter {
  readonly name: string
  private mesh: NebulaMesh
  private config: Required<Omit<MessageChannelConfig, 'requiredGroups'>> & {
    requiredGroups: string[]
  }
  private _open = false
  private offlineQueue: OfflineQueue | null = null
  private stats: ChannelStats & { permissionDenied: number } = {
    messagesSent: 0,
    messagesReceived: 0,
    queuedMessages: 0,
    failedDeliveries: 0,
    permissionDenied: 0,
  }

  // RPC support
  private pendingRequests: Map<string, PendingRequest> = new Map()
  private requestHandler: RequestHandler<T> | null = null
  private requestCounter = 0

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
      requiredGroups: config?.requiredGroups ?? [],
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

    // Cancel all pending RPC requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Channel ${this.name} closed while request ${requestId} pending`))
    }
    this.pendingRequests.clear()
    this.requestHandler = null

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
  // RPC (Request/Response)
  // ==========================================================================

  /**
   * Send a request and wait for a response.
   * @param peerId Target peer to send request to
   * @param message Request message
   * @param timeout Timeout in ms (default: from config, typically 30000)
   * @returns Response from peer
   * @throws RPCTimeoutError if no response within timeout
   * @throws RPCError if handler returns an error
   */
  request<R>(peerId: string, message: T, timeout?: number): Promise<R> {
    if (!this._open) {
      return Promise.reject(new Error(`Channel ${this.name} is not open`))
    }

    const requestId = this.generateRequestId()
    const timeoutMs = timeout ?? this.config.timeout

    return new Promise<R>((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new RPCTimeoutError(requestId, timeoutMs))
      }, timeoutMs)

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve: resolve as (response: unknown) => void,
        reject,
        timer,
      })

      // Send the request
      const success = this.mesh._sendRpc(peerId, this.name, message, 'request', requestId)

      if (!success) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        reject(new Error(`Failed to send request to peer ${peerId}`))
      }

      this.stats.messagesSent++
    })
  }

  /**
   * Register a handler for incoming requests.
   * The handler receives the request message and peer info, and returns a response.
   * Only one handler can be registered per channel.
   * @param handler Async function that processes requests and returns responses
   */
  onRequest(handler: (message: T, from: PeerInfo) => Promise<unknown>): void {
    this.requestHandler = handler
  }

  /**
   * Remove the request handler.
   */
  offRequest(): void {
    this.requestHandler = null
  }

  /**
   * Check if a request handler is registered.
   */
  hasRequestHandler(): boolean {
    return this.requestHandler !== null
  }

  private generateRequestId(): string {
    return `${this.mesh._getPeerId()}:${this.name}:${++this.requestCounter}`
  }

  // ==========================================================================
  // Receiving (called by NebulaMesh)
  // ==========================================================================

  /** @internal - Called by NebulaMesh when a message arrives */
  _receiveMessage(message: T, from: PeerInfo): void {
    // Check permission if required groups are configured
    if (!this.checkSenderPermission(from)) {
      this.stats.permissionDenied++
      this.emit('permission:denied', {
        from,
        reason: 'Sender lacks required group membership',
        requiredGroups: this.config.requiredGroups,
        senderGroups: from.groups,
      })
      return // Drop the message
    }

    this.stats.messagesReceived++
    this.emit('message', message, from)
  }

  /** @internal - Called by NebulaMesh when an RPC request arrives */
  async _receiveRequest(message: T, from: PeerInfo, requestId: string): Promise<void> {
    // Check permission
    if (!this.checkSenderPermission(from)) {
      this.stats.permissionDenied++
      // Send error response
      this.mesh._sendRpc(
        from.id,
        this.name,
        { error: 'Permission denied', code: 'PERMISSION_DENIED' } as unknown as T,
        'response',
        requestId
      )
      return
    }

    this.stats.messagesReceived++

    // Check if handler is registered
    if (!this.requestHandler) {
      // Send error response - no handler
      this.mesh._sendRpc(
        from.id,
        this.name,
        { error: 'No handler registered', code: 'NO_HANDLER' } as unknown as T,
        'response',
        requestId
      )
      return
    }

    try {
      // Call handler and get response
      const response = await this.requestHandler(message, from)

      // Send response
      this.mesh._sendRpc(from.id, this.name, response as T, 'response', requestId)
      this.stats.messagesSent++
    } catch (err) {
      // Send error response
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.mesh._sendRpc(
        from.id,
        this.name,
        { error: errorMessage, code: 'HANDLER_ERROR' } as unknown as T,
        'response',
        requestId
      )
      this.stats.messagesSent++
    }
  }

  /** @internal - Called by NebulaMesh when an RPC response arrives */
  _receiveResponse(response: unknown, from: PeerInfo, requestId: string): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      // Response for unknown request (possibly timed out already)
      return
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)

    this.stats.messagesReceived++

    // Check for error response
    const maybeError = response as { error?: string; code?: string }
    if (maybeError && typeof maybeError === 'object' && 'error' in maybeError && 'code' in maybeError) {
      pending.reject(new RPCError(requestId, maybeError.error as string))
      return
    }

    // Success - resolve with response
    pending.resolve(response)
  }

  // ==========================================================================
  // Permission Checking
  // ==========================================================================

  /**
   * Check if a peer has permission to send messages on this channel.
   * Returns true if no required groups are configured or if peer has at least one required group.
   */
  private checkSenderPermission(peer: PeerInfo): boolean {
    // If no required groups, allow all
    if (this.config.requiredGroups.length === 0) {
      return true
    }

    // Check if peer has at least one required group
    return this.config.requiredGroups.some((group) => peer.groups.includes(group))
  }

  /**
   * Get the required groups for this channel.
   */
  getRequiredGroups(): string[] {
    return [...this.config.requiredGroups]
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
      permissionDenied: 0,
    }
  }
}
