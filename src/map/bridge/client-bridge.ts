/**
 * Client Bridge
 *
 * Exposes MAP protocol to external clients via WebSocket.
 * Allows dashboards and monitoring tools to observe the mesh.
 */

import { EventEmitter } from 'events'
import { createServer, type Server, type IncomingMessage } from 'http'
import { createServer as createHttpsServer } from 'https'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { readFileSync } from 'fs'
import type { MapServer } from '../server/map-server'
import type {
  ParticipantId,
  SessionId,
  Agent,
  Scope,
  Event,
  Message,
  Address,
  SubscriptionFilter,
  SubscriptionOptions,
  MapClientBridgeConfig,
  MapFrame,
  MapRequestFrame,
  MapResponseFrame,
  MapNotificationFrame,
} from '../types'
import {
  JSONRPC_VERSION,
  PROTOCOL_VERSION,
  MAP_METHODS,
  PROTOCOL_ERROR_CODES,
  AUTH_ERROR_CODES,
  type MAPError,
  type EventSubscription,
  type RequestId,
} from '../types'

/**
 * Connected client state.
 */
interface ConnectedClient {
  id: ParticipantId
  sessionId: SessionId
  socket: WebSocket
  authenticated: boolean
  subscriptions: Map<string, EventSubscription>
  createdAt: number
  lastActiveAt: number
}

/**
 * Events emitted by the client bridge.
 */
export interface ClientBridgeEvents {
  'client:connected': (clientId: ParticipantId) => void
  'client:disconnected': (clientId: ParticipantId, reason?: string) => void
  'client:authenticated': (clientId: ParticipantId) => void
  'error': (error: Error) => void
}

/**
 * Client Bridge - WebSocket server for external MAP clients.
 */
export class ClientBridge extends EventEmitter {
  private readonly mapServer: MapServer
  private readonly config: MapClientBridgeConfig
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private readonly clients = new Map<ParticipantId, ConnectedClient>()
  private running = false

  constructor(mapServer: MapServer, config: MapClientBridgeConfig = {}) {
    super()
    this.mapServer = mapServer
    this.config = {
      port: config.port ?? 0,
      host: config.host ?? '0.0.0.0',
      ...config,
    }
  }

  /**
   * Whether the bridge is running.
   */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * Number of connected clients.
   */
  get clientCount(): number {
    return this.clients.size
  }

  /**
   * Get the actual port the server is listening on.
   */
  get port(): number {
    const address = this.httpServer?.address()
    if (address && typeof address === 'object') {
      return address.port
    }
    return 0
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    if (this.running) return

    // Create HTTP(S) server
    if (this.config.tls) {
      this.httpServer = createHttpsServer({
        cert: readFileSync(this.config.tls.cert),
        key: readFileSync(this.config.tls.key),
        ca: this.config.tls.ca ? readFileSync(this.config.tls.ca) : undefined,
      })
    } else {
      this.httpServer = createServer()
    }

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer })

    this.wss.on('connection', (socket, request) => {
      this.handleConnection(socket, request)
    })

    this.wss.on('error', (error) => {
      this.emit('error', error)
    })

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        resolve()
      })
      this.httpServer!.on('error', reject)
    })

    this.running = true
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    if (!this.running) return

    // Close all client connections
    for (const [clientId, client] of this.clients) {
      client.socket.close(1001, 'Server shutting down')
      this.cleanupClient(clientId)
    }

    // Close WebSocket server
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.running = false
  }

  /**
   * Handle a new WebSocket connection.
   */
  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const clientId = this.generateClientId()
    const sessionId = this.generateSessionId()

    const client: ConnectedClient = {
      id: clientId,
      sessionId,
      socket,
      authenticated: !this.config.auth?.required,
      subscriptions: new Map(),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }

    this.clients.set(clientId, client)

    socket.on('message', (data) => {
      this.handleMessage(clientId, data)
    })

    socket.on('close', (code, reason) => {
      this.handleDisconnect(clientId, reason.toString())
    })

    socket.on('error', (error) => {
      this.emit('error', error)
    })

    this.emit('client:connected', clientId)
  }

  /**
   * Handle a message from a client.
   */
  private async handleMessage(clientId: ParticipantId, data: RawData): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) return

    client.lastActiveAt = Date.now()

    let frame: MapFrame
    try {
      frame = JSON.parse(data.toString()) as MapFrame
    } catch {
      this.sendError(client, null, PROTOCOL_ERROR_CODES.PARSE_ERROR, 'Invalid JSON')
      return
    }

    // Check if this is a request (has id and method)
    if ('id' in frame && 'method' in frame) {
      await this.handleRequest(client, frame as MapRequestFrame)
    }
    // Check if this is a notification (has method but no id)
    else if ('method' in frame && !('id' in frame)) {
      this.handleNotification(client, frame as MapNotificationFrame)
    }
    // Unknown frame type
    else {
      this.sendError(client, null, PROTOCOL_ERROR_CODES.INVALID_REQUEST, 'Invalid frame type')
    }
  }

  /**
   * Handle a request from a client.
   */
  private async handleRequest(client: ConnectedClient, request: MapRequestFrame): Promise<void> {
    const { id, method, params } = request

    // Check authentication for protected methods
    if (!client.authenticated && method !== MAP_METHODS.CONNECT) {
      this.sendError(client, id, AUTH_ERROR_CODES.AUTH_REQUIRED, 'Authentication required')
      return
    }

    try {
      const result = await this.routeRequest(client, method, params)
      this.sendResponse(client, id, result)
    } catch (err) {
      const error = err as Error & { code?: number }
      this.sendError(
        client,
        id,
        error.code ?? PROTOCOL_ERROR_CODES.INTERNAL_ERROR,
        error.message
      )
    }
  }

  /**
   * Route a request to the appropriate handler.
   */
  private async routeRequest(
    client: ConnectedClient,
    method: string,
    params: unknown
  ): Promise<unknown> {
    switch (method) {
      case MAP_METHODS.CONNECT:
        return this.handleConnect(client, params as Record<string, unknown>)

      case MAP_METHODS.DISCONNECT:
        return this.handleDisconnectRequest(client, params as Record<string, unknown>)

      case MAP_METHODS.AGENTS_LIST:
        return { agents: this.mapServer.listAgents(params as Record<string, unknown>) }

      case MAP_METHODS.AGENTS_GET: {
        const p = params as { agentId: string; include?: Record<string, boolean> }
        return this.mapServer.getAgentHierarchy(p.agentId, p.include)
      }

      case MAP_METHODS.SCOPES_LIST:
        return { scopes: this.mapServer.listScopes(params as Record<string, unknown>) }

      case MAP_METHODS.SCOPES_GET: {
        const p = params as { scopeId: string }
        const scope = this.mapServer.getScope(p.scopeId)
        if (!scope) throw Object.assign(new Error('Scope not found'), { code: 2002 })
        return { scope }
      }

      case MAP_METHODS.SCOPES_MEMBERS: {
        const p = params as { scopeId: string }
        return { members: this.mapServer.getScopeMembers(p.scopeId) }
      }

      case MAP_METHODS.SEND: {
        const p = params as { to: Address; payload: unknown; meta?: Record<string, unknown> }
        return this.mapServer.send(client.id, p.to, p.payload, p.meta)
      }

      case MAP_METHODS.SUBSCRIBE: {
        const p = params as { filter?: SubscriptionFilter; options?: SubscriptionOptions }
        return this.handleSubscribe(client, p.filter, p.options)
      }

      case MAP_METHODS.UNSUBSCRIBE: {
        const p = params as { subscriptionId: string }
        return this.handleUnsubscribe(client, p.subscriptionId)
      }

      case MAP_METHODS.REPLAY: {
        const p = params as {
          afterEventId?: string
          fromTimestamp?: number
          toTimestamp?: number
          filter?: SubscriptionFilter
          limit?: number
        }
        return this.mapServer.replay(p)
      }

      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), {
          code: PROTOCOL_ERROR_CODES.METHOD_NOT_FOUND,
        })
    }
  }

  /**
   * Handle connect request.
   */
  private handleConnect(
    client: ConnectedClient,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    // Validate protocol version
    const protocolVersion = params.protocolVersion as number
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw Object.assign(new Error(`Unsupported protocol version: ${protocolVersion}`), {
        code: PROTOCOL_ERROR_CODES.INVALID_PARAMS,
      })
    }

    // Check authentication if required
    if (this.config.auth?.required && !client.authenticated) {
      const auth = params.auth as { method: string; token?: string } | undefined
      if (!auth) {
        throw Object.assign(new Error('Authentication required'), {
          code: AUTH_ERROR_CODES.AUTH_REQUIRED,
        })
      }

      if (!this.authenticate(auth)) {
        throw Object.assign(new Error('Authentication failed'), {
          code: AUTH_ERROR_CODES.AUTH_FAILED,
        })
      }

      client.authenticated = true
      this.emit('client:authenticated', client.id)
    }

    const systemInfo = this.mapServer.getSystemInfo()

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: client.sessionId,
      participantId: client.id,
      capabilities: {
        observation: { canObserve: true, canQuery: true },
        messaging: { canSend: true, canReceive: false },
        streaming: { supportsAck: false },
      },
      systemInfo: {
        name: systemInfo.systemName,
        version: systemInfo.systemVersion,
      },
    }
  }

  /**
   * Handle disconnect request.
   */
  private handleDisconnectRequest(
    client: ConnectedClient,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const reason = (params.reason as string) ?? 'Client requested disconnect'

    // Schedule cleanup after sending response
    setImmediate(() => {
      client.socket.close(1000, reason)
      this.cleanupClient(client.id)
    })

    return {
      session: {
        id: client.sessionId,
        createdAt: client.createdAt,
        closedAt: Date.now(),
      },
    }
  }

  /**
   * Handle subscribe request.
   */
  private handleSubscribe(
    client: ConnectedClient,
    filter?: SubscriptionFilter,
    options?: SubscriptionOptions
  ): Record<string, unknown> {
    // Check rate limit
    const maxSubs = this.config.rateLimit?.maxSubscriptionsPerClient ?? 100
    if (client.subscriptions.size >= maxSubs) {
      throw Object.assign(new Error('Maximum subscriptions reached'), {
        code: 4002, // QUOTA_EXCEEDED
      })
    }

    const subscription = this.mapServer.subscribe(client.id, filter, options)

    // Store subscription
    client.subscriptions.set(subscription.id, subscription)

    // Start streaming events to client
    this.streamEvents(client, subscription)

    return { subscriptionId: subscription.id }
  }

  /**
   * Handle unsubscribe request.
   */
  private handleUnsubscribe(
    client: ConnectedClient,
    subscriptionId: string
  ): Record<string, unknown> {
    const subscription = client.subscriptions.get(subscriptionId)
    if (!subscription) {
      throw Object.assign(new Error('Subscription not found'), { code: 2002 })
    }

    subscription.unsubscribe()
    client.subscriptions.delete(subscriptionId)

    return {
      subscription: {
        id: subscriptionId,
        closedAt: Date.now(),
      },
    }
  }

  /**
   * Stream events from a subscription to the client.
   */
  private async streamEvents(
    client: ConnectedClient,
    subscription: EventSubscription
  ): Promise<void> {
    let sequenceNumber = 0

    try {
      for await (const event of subscription.events()) {
        if (!this.clients.has(client.id)) break
        if (!client.subscriptions.has(subscription.id)) break

        sequenceNumber++

        const notification: MapNotificationFrame = {
          jsonrpc: JSONRPC_VERSION,
          method: 'map/event',
          params: {
            subscriptionId: subscription.id,
            sequenceNumber,
            eventId: event.id,
            timestamp: event.timestamp,
            event,
          },
        }

        this.send(client, notification)
      }
    } catch (err) {
      // Subscription ended or error
    }
  }

  /**
   * Handle notification from client.
   */
  private handleNotification(client: ConnectedClient, notification: MapNotificationFrame): void {
    // Handle subscription acknowledgments if needed
    if (notification.method === 'map/subscribe.ack') {
      // Acknowledgment received - could implement backpressure here
    }
  }

  /**
   * Handle client disconnect.
   */
  private handleDisconnect(clientId: ParticipantId, reason?: string): void {
    this.cleanupClient(clientId)
    this.emit('client:disconnected', clientId, reason)
  }

  /**
   * Clean up client resources.
   */
  private cleanupClient(clientId: ParticipantId): void {
    const client = this.clients.get(clientId)
    if (!client) return

    // Unsubscribe all subscriptions
    for (const subscription of client.subscriptions.values()) {
      subscription.unsubscribe()
    }

    // Unsubscribe from server
    this.mapServer.unsubscribeAll(clientId)

    this.clients.delete(clientId)
  }

  /**
   * Authenticate a client.
   */
  private authenticate(auth: { method: string; token?: string }): boolean {
    if (!this.config.auth) return true

    if (auth.method === 'api-key' && this.config.auth.apiKeys) {
      return this.config.auth.apiKeys.includes(auth.token ?? '')
    }

    if (auth.method === 'bearer' && this.config.auth.jwt) {
      // Simple JWT validation - in production, use proper JWT library
      // For now, just check if token is provided
      return !!auth.token
    }

    return false
  }

  /**
   * Send a frame to a client.
   */
  private send(client: ConnectedClient, frame: MapFrame): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(frame))
    }
  }

  /**
   * Send a response to a client.
   */
  private sendResponse(client: ConnectedClient, id: RequestId, result: unknown): void {
    const response: MapResponseFrame = {
      jsonrpc: JSONRPC_VERSION,
      id,
      result,
    }
    this.send(client, response)
  }

  /**
   * Send an error response to a client.
   */
  private sendError(
    client: ConnectedClient,
    id: RequestId | null,
    code: number,
    message: string
  ): void {
    const response: MapResponseFrame = {
      jsonrpc: JSONRPC_VERSION,
      id: id ?? 0,
      error: { code, message },
    }
    this.send(client, response)
  }

  /**
   * Generate a unique client ID.
   */
  private generateClientId(): ParticipantId {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Generate a unique session ID.
   */
  private generateSessionId(): SessionId {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcastEvent(event: Event): void {
    for (const client of this.clients.values()) {
      if (!client.authenticated) continue

      // Events are delivered through subscriptions, not broadcast
      // This method is for special system-wide notifications if needed
    }
  }
}

/**
 * Create a client bridge.
 */
export function createClientBridge(
  mapServer: MapServer,
  config?: MapClientBridgeConfig
): ClientBridge {
  return new ClientBridge(mapServer, config)
}
