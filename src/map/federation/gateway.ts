/**
 * Federation Gateway
 *
 * Enables cross-mesh communication by routing messages between
 * separate MAP systems while maintaining visibility boundaries.
 */

import { EventEmitter } from 'events'
import type {
  Message,
  AgentId,
  ParticipantId,
  MapGatewayConfig,
  FederationMetadata,
  FederationEnvelope,
  GatewayReconnectionEvent,
} from '../types'
import {
  PROTOCOL_VERSION,
  FEDERATION_METHODS,
  FEDERATION_ERROR_CODES,
  EVENT_TYPES,
} from '../types'
import type { MapServer } from '../server/map-server'
import type { MapStream } from '../stream/types'
import { BaseConnection } from '../connection/base'

/**
 * Buffer for messages during disconnection.
 */
interface MessageBuffer {
  messages: Array<{ envelope: FederationEnvelope<Message>; timestamp: number }>
  maxMessages: number
  maxBytes: number
  retentionMs: number
  currentBytes: number
}

/**
 * Events emitted by the federation gateway.
 */
export interface FederationGatewayEvents {
  'connected': (systemId: string) => void
  'disconnected': (systemId: string, reason?: string) => void
  'reconnecting': (systemId: string, attempt: number) => void
  'reconnected': (systemId: string) => void
  'message:received': (envelope: FederationEnvelope<Message>) => void
  'message:routed': (envelope: FederationEnvelope<Message>) => void
  'error': (error: Error) => void
}

/**
 * Federation Gateway - routes messages between MAP systems.
 */
export class FederationGateway extends EventEmitter {
  readonly localSystemId: string
  readonly remoteSystemId: string

  private readonly mapServer: MapServer
  private readonly config: MapGatewayConfig
  private connection: BaseConnection | null = null
  private stream: MapStream | null = null
  private buffer: MessageBuffer
  private connected = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(mapServer: MapServer, config: MapGatewayConfig) {
    super()
    this.mapServer = mapServer
    this.config = config
    this.localSystemId = config.localSystemId
    this.remoteSystemId = config.remoteSystemId

    // Initialize buffer
    this.buffer = {
      messages: [],
      maxMessages: config.buffer?.maxMessages ?? 1000,
      maxBytes: config.buffer?.maxBytes ?? 10 * 1024 * 1024, // 10MB
      retentionMs: config.buffer?.retentionMs ?? 3600000, // 1 hour
      currentBytes: 0,
    }
  }

  /**
   * Whether connected to the remote system.
   */
  get isConnected(): boolean {
    return this.connected
  }

  /**
   * Number of buffered messages.
   */
  get bufferedMessageCount(): number {
    return this.buffer.messages.length
  }

  /**
   * Connect to the remote system.
   */
  async connect(stream: MapStream): Promise<void> {
    if (this.connected) return

    this.stream = stream

    // Create base connection
    this.connection = new BaseConnection({
      stream,
      onRequest: (method, params) => this.handleRequest(method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
    })

    await this.connection.start()

    // Send federation connect request
    try {
      const result = await this.connection.request<{ connected: boolean }>(
        FEDERATION_METHODS.FEDERATION_CONNECT,
        {
          systemId: this.localSystemId,
          endpoint: '', // Local endpoint not needed for incoming
          auth: this.config.auth,
        }
      )

      if (result.connected) {
        this.connected = true
        this.reconnectAttempts = 0

        // Emit connected event
        this.emitReconnectionEvent('connected')
        this.emit('connected', this.remoteSystemId)

        // Flush buffer
        await this.flushBuffer()
      }
    } catch (err) {
      this.emit('error', err as Error)
      throw err
    }
  }

  /**
   * Disconnect from the remote system.
   */
  async disconnect(reason?: string): Promise<void> {
    if (!this.connected) return

    this.cancelReconnect()

    try {
      await this.connection?.request('map/disconnect', { reason })
    } catch {
      // Ignore disconnect errors
    }

    await this.cleanup()

    this.emitReconnectionEvent('disconnected')
    this.emit('disconnected', this.remoteSystemId, reason)
  }

  /**
   * Route a message to the remote system.
   */
  async route(message: Message, targetAgentIds: AgentId[]): Promise<boolean> {
    const envelope = this.createEnvelope(message)

    if (!this.connected) {
      // Buffer the message
      if (this.config.buffer?.enabled !== false) {
        this.bufferMessage(envelope)
        return true // Buffered for later delivery
      }
      return false
    }

    return this.sendEnvelope(envelope)
  }

  /**
   * Create a federation envelope for a message.
   */
  private createEnvelope(message: Message): FederationEnvelope<Message> {
    const routing = this.config.routing

    const federation: FederationMetadata = {
      sourceSystem: this.localSystemId,
      targetSystem: this.remoteSystemId,
      hopCount: 0,
      maxHops: routing?.maxHops ?? 10,
      path: routing?.trackPath ? [this.localSystemId] : undefined,
      originTimestamp: Date.now(),
      correlationId: message.meta?.correlationId,
    }

    return { payload: message, federation }
  }

  /**
   * Send an envelope to the remote system.
   */
  private async sendEnvelope(envelope: FederationEnvelope<Message>): Promise<boolean> {
    if (!this.connection?.isConnected) {
      return false
    }

    try {
      await this.connection.request(FEDERATION_METHODS.FEDERATION_ROUTE, {
        systemId: this.remoteSystemId,
        envelope,
      })

      this.emit('message:routed', envelope)
      return true
    } catch (err) {
      this.emit('error', err as Error)
      return false
    }
  }

  /**
   * Buffer a message for later delivery.
   */
  private bufferMessage(envelope: FederationEnvelope<Message>): void {
    const messageSize = JSON.stringify(envelope).length

    // Check limits
    if (this.buffer.messages.length >= this.buffer.maxMessages) {
      // Handle overflow based on strategy
      const strategy = this.config.buffer?.overflowStrategy ?? 'drop-oldest'
      if (strategy === 'drop-oldest') {
        const dropped = this.buffer.messages.shift()
        if (dropped) {
          this.buffer.currentBytes -= JSON.stringify(dropped.envelope).length
        }
      } else if (strategy === 'drop-newest') {
        return // Don't add new message
      } else {
        throw new Error('Buffer full')
      }
    }

    if (this.buffer.currentBytes + messageSize > this.buffer.maxBytes) {
      // Remove oldest until we have room
      while (
        this.buffer.messages.length > 0 &&
        this.buffer.currentBytes + messageSize > this.buffer.maxBytes
      ) {
        const dropped = this.buffer.messages.shift()
        if (dropped) {
          this.buffer.currentBytes -= JSON.stringify(dropped.envelope).length
        }
      }
    }

    this.buffer.messages.push({
      envelope,
      timestamp: Date.now(),
    })
    this.buffer.currentBytes += messageSize
  }

  /**
   * Flush buffered messages to the remote system.
   */
  private async flushBuffer(): Promise<void> {
    if (!this.connected || this.buffer.messages.length === 0) return

    const now = Date.now()
    const validMessages = this.buffer.messages.filter(
      (m) => now - m.timestamp < this.buffer.retentionMs
    )

    for (const { envelope } of validMessages) {
      // Update hop count
      envelope.federation.hopCount++

      if (envelope.federation.path) {
        envelope.federation.path.push(this.localSystemId)
      }

      await this.sendEnvelope(envelope)
    }

    // Clear buffer
    this.buffer.messages = []
    this.buffer.currentBytes = 0
  }

  /**
   * Handle incoming request from remote system.
   */
  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case FEDERATION_METHODS.FEDERATION_CONNECT: {
        const p = params as { systemId: string }
        // Verify system ID matches
        if (p.systemId !== this.remoteSystemId) {
          throw Object.assign(new Error('System ID mismatch'), {
            code: FEDERATION_ERROR_CODES.FEDERATION_AUTH_FAILED,
          })
        }
        return { connected: true }
      }

      case FEDERATION_METHODS.FEDERATION_ROUTE: {
        const p = params as { envelope?: FederationEnvelope<Message>; message?: Message }
        const envelope = p.envelope ?? this.wrapLegacyMessage(p.message!)

        // Validate envelope
        const validationError = this.validateEnvelope(envelope)
        if (validationError) {
          throw validationError
        }

        // Process the message
        await this.processIncomingEnvelope(envelope)

        return { routed: true }
      }

      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), {
          code: -32601,
        })
    }
  }

  /**
   * Handle incoming notification from remote system.
   */
  private handleNotification(method: string, params: unknown): void {
    // Handle event notifications if needed
  }

  /**
   * Validate an incoming federation envelope.
   */
  private validateEnvelope(envelope: FederationEnvelope<Message>): Error | null {
    const { federation } = envelope

    // Check target system
    if (federation.targetSystem !== this.localSystemId) {
      return Object.assign(new Error('Wrong target system'), {
        code: FEDERATION_ERROR_CODES.FEDERATION_ROUTE_REJECTED,
      })
    }

    // Check hop count
    const maxHops = this.config.routing?.maxHops ?? 10
    if (federation.hopCount >= maxHops) {
      return Object.assign(new Error('Maximum hops exceeded'), {
        code: FEDERATION_ERROR_CODES.FEDERATION_MAX_HOPS_EXCEEDED,
      })
    }

    // Check for loops
    if (federation.path?.includes(this.localSystemId)) {
      return Object.assign(new Error('Loop detected'), {
        code: FEDERATION_ERROR_CODES.FEDERATION_LOOP_DETECTED,
      })
    }

    // Check allowed sources
    const allowedSources = this.config.routing?.allowedSources
    if (allowedSources && !allowedSources.includes(federation.sourceSystem)) {
      return Object.assign(new Error('Source system not allowed'), {
        code: FEDERATION_ERROR_CODES.FEDERATION_ROUTE_REJECTED,
      })
    }

    return null
  }

  /**
   * Process an incoming federation envelope.
   */
  private async processIncomingEnvelope(envelope: FederationEnvelope<Message>): Promise<void> {
    const message = envelope.payload

    // Emit for external handlers
    this.emit('message:received', envelope)

    // Route to local agents, preserving _meta from both message levels
    await this.mapServer.send(
      `${envelope.federation.sourceSystem}:${message.from}`,
      message.to,
      message.payload,
      {
        ...message.meta,
        correlationId: envelope.federation.correlationId,
        _meta: message._meta ?? message.meta?._meta,
      }
    )
  }

  /**
   * Wrap a legacy message in a federation envelope.
   */
  private wrapLegacyMessage(message: Message): FederationEnvelope<Message> {
    return {
      payload: message,
      federation: {
        sourceSystem: 'unknown',
        targetSystem: this.localSystemId,
        hopCount: 0,
        originTimestamp: Date.now(),
      },
    }
  }

  /**
   * Clean up resources.
   */
  private async cleanup(): Promise<void> {
    if (this.connection) {
      await this.connection.stop()
      this.connection = null
    }

    if (this.stream) {
      await this.stream.close()
      this.stream = null
    }

    this.connected = false
  }

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    const reconnection = this.config.reconnection
    if (!reconnection?.enabled) return

    const maxRetries = reconnection.maxRetries ?? Infinity
    if (this.reconnectAttempts >= maxRetries) {
      this.emitReconnectionEvent('reconnect_failed')
      return
    }

    const initialDelay = reconnection.initialDelayMs ?? 1000
    const maxDelay = reconnection.maxDelayMs ?? 30000
    const multiplier = 2

    const delay = Math.min(initialDelay * Math.pow(multiplier, this.reconnectAttempts), maxDelay)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attemptReconnect()
    }, delay)
  }

  /**
   * Attempt reconnection.
   */
  private async attemptReconnect(): Promise<void> {
    this.reconnectAttempts++
    this.emitReconnectionEvent('reconnecting')

    // Note: The actual reconnection would require creating a new stream
    // This is typically handled at a higher level (MeshPeer)
  }

  /**
   * Cancel scheduled reconnection.
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Emit a reconnection event.
   */
  private emitReconnectionEvent(
    type: GatewayReconnectionEvent['type'],
    extra?: Partial<GatewayReconnectionEvent>
  ): void {
    const event: GatewayReconnectionEvent = {
      type,
      systemId: this.remoteSystemId,
      timestamp: Date.now(),
      attempt: type === 'reconnecting' ? this.reconnectAttempts : undefined,
      bufferedCount: type === 'buffer_overflow' ? this.buffer.messages.length : undefined,
      ...extra,
    }

    // Could add a reconnection event handler here if configured
  }
}

/**
 * Create a federation gateway.
 */
export function createFederationGateway(
  mapServer: MapServer,
  config: MapGatewayConfig
): FederationGateway {
  return new FederationGateway(mapServer, config)
}
