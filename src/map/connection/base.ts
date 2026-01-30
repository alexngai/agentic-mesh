/**
 * Base Connection for MAP Protocol
 *
 * Provides JSON-RPC 2.0 request/response handling over a MAP stream.
 */

import { EventEmitter } from 'events'
import type { MapStream } from '../stream/types'
import type {
  MapFrame,
  MapRequestFrame,
  MapResponseFrame,
  MapNotificationFrame,
  MapConnectionState,
} from '../types'
import {
  JSONRPC_VERSION,
  PROTOCOL_ERROR_CODES,
  type MAPError,
  type RequestId,
} from '../../multi-agent-protocol/ts-sdk/src/types'

/**
 * Pending request awaiting a response.
 */
interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  method: string
}

/**
 * Handler for incoming requests.
 */
export type RequestHandler = (
  method: string,
  params: unknown,
  requestId: RequestId
) => Promise<unknown>

/**
 * Handler for incoming notifications.
 */
export type NotificationHandler = (method: string, params: unknown) => void

/**
 * Configuration for the base connection.
 */
export interface BaseConnectionConfig {
  /** The underlying MAP stream */
  stream: MapStream

  /** Default request timeout in milliseconds */
  requestTimeout?: number

  /** Handler for incoming requests */
  onRequest?: RequestHandler

  /** Handler for incoming notifications */
  onNotification?: NotificationHandler
}

/**
 * Base class for MAP protocol connections.
 * Handles JSON-RPC 2.0 request/response correlation and timeout management.
 */
export class BaseConnection extends EventEmitter {
  protected readonly stream: MapStream
  protected readonly requestTimeout: number
  protected readonly pendingRequests = new Map<RequestId, PendingRequest>()
  protected requestHandler: RequestHandler | null = null
  protected notificationHandler: NotificationHandler | null = null
  private nextRequestId = 1
  private readLoopPromise: Promise<void> | null = null
  private isRunning = false

  constructor(config: BaseConnectionConfig) {
    super()
    this.stream = config.stream
    this.requestTimeout = config.requestTimeout ?? 30000
    this.requestHandler = config.onRequest ?? null
    this.notificationHandler = config.onNotification ?? null
  }

  /**
   * Current connection state.
   */
  get state(): MapConnectionState {
    return this.stream.state
  }

  /**
   * Whether the connection is open and ready.
   */
  get isConnected(): boolean {
    return this.stream.isOpen
  }

  /**
   * Start the connection (begin reading from the stream).
   */
  async start(): Promise<void> {
    if (this.isRunning) return

    this.isRunning = true
    this.readLoopPromise = this.readLoop()

    this.stream.on('close', () => {
      this.handleClose()
    })

    this.stream.on('error', (error: Error) => {
      this.emit('error', error)
    })
  }

  /**
   * Stop the connection.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    this.isRunning = false

    // Cancel all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Connection closed'))
      this.pendingRequests.delete(id)
    }

    await this.stream.close()

    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => {})
    }
  }

  /**
   * Send a request and wait for a response.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.stream.isOpen) {
      throw new Error('Connection is not open')
    }

    const id = this.nextRequestId++
    const frame: MapRequestFrame = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, this.requestTimeout)

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
        method,
      })

      this.stream.write(frame).catch((err) => {
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        reject(err)
      })
    })
  }

  /**
   * Send a notification (no response expected).
   */
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.stream.isOpen) {
      throw new Error('Connection is not open')
    }

    const frame: MapNotificationFrame = {
      jsonrpc: JSONRPC_VERSION,
      method,
      params,
    }

    await this.stream.write(frame)
  }

  /**
   * Send a response to a request.
   */
  async respond(requestId: RequestId, result: unknown): Promise<void> {
    const frame: MapResponseFrame = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      result,
    }

    await this.stream.write(frame)
  }

  /**
   * Send an error response to a request.
   */
  async respondWithError(requestId: RequestId, error: MAPError): Promise<void> {
    const frame: MapResponseFrame = {
      jsonrpc: JSONRPC_VERSION,
      id: requestId,
      error,
    }

    await this.stream.write(frame)
  }

  /**
   * Set the request handler.
   */
  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Set the notification handler.
   */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * Main read loop - processes incoming frames.
   */
  private async readLoop(): Promise<void> {
    try {
      for await (const frame of this.stream) {
        if (!this.isRunning) break
        await this.handleFrame(frame)
      }
    } catch (err) {
      if (this.isRunning) {
        this.emit('error', err)
      }
    }
  }

  /**
   * Handle an incoming frame.
   */
  private async handleFrame(frame: MapFrame): Promise<void> {
    if (!frame || typeof frame !== 'object') {
      this.emit('error', new Error('Invalid frame received'))
      return
    }

    // Check for response
    if ('id' in frame && ('result' in frame || 'error' in frame)) {
      this.handleResponse(frame as MapResponseFrame)
      return
    }

    // Check for request
    if ('id' in frame && 'method' in frame) {
      await this.handleRequest(frame as MapRequestFrame)
      return
    }

    // Must be a notification
    if ('method' in frame && !('id' in frame)) {
      this.handleNotification(frame as MapNotificationFrame)
      return
    }

    this.emit('error', new Error('Unknown frame type'))
  }

  /**
   * Handle a response frame.
   */
  private handleResponse(frame: MapResponseFrame): void {
    const pending = this.pendingRequests.get(frame.id)
    if (!pending) {
      // Response for unknown request - ignore
      return
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(frame.id)

    if (frame.error) {
      const error = new Error(frame.error.message) as Error & { code?: number; data?: unknown }
      error.code = frame.error.code
      error.data = frame.error.data
      pending.reject(error)
    } else {
      pending.resolve(frame.result)
    }
  }

  /**
   * Handle a request frame.
   */
  private async handleRequest(frame: MapRequestFrame): Promise<void> {
    if (!this.requestHandler) {
      await this.respondWithError(frame.id, {
        code: PROTOCOL_ERROR_CODES.METHOD_NOT_FOUND,
        message: `No handler for method: ${frame.method}`,
      })
      return
    }

    try {
      const result = await this.requestHandler(frame.method, frame.params, frame.id)
      await this.respond(frame.id, result)
    } catch (err) {
      const error = err as Error & { code?: number; data?: unknown }
      await this.respondWithError(frame.id, {
        code: error.code ?? PROTOCOL_ERROR_CODES.INTERNAL_ERROR,
        message: error.message,
        data: error.data,
      })
    }
  }

  /**
   * Handle a notification frame.
   */
  private handleNotification(frame: MapNotificationFrame): void {
    if (this.notificationHandler) {
      this.notificationHandler(frame.method, frame.params)
    }
    this.emit('notification', frame.method, frame.params)
  }

  /**
   * Handle stream close.
   */
  private handleClose(): void {
    // Cancel all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Connection closed'))
      this.pendingRequests.delete(id)
    }

    this.isRunning = false
    this.emit('close')
  }
}

/**
 * Create a JSON-RPC error object.
 */
export function createError(
  code: number,
  message: string,
  data?: Record<string, unknown>
): MAPError {
  return { code, message, data }
}
