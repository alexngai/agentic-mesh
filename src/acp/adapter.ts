// AcpMeshAdapter - Tunnels ACP messages through mesh transport
// Implements: s-4hjr, i-78pc

import { EventEmitter } from 'events'
import type { NebulaMesh } from '../mesh/nebula-mesh'
import type { PeerInfo } from '../types'
import { MessageChannel } from '../channel/message-channel'
import type {
  AcpMessage,
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpMeshEnvelope,
  AcpMeshAdapterConfig,
  BroadcastTarget,
  SessionInfo,
} from './types'
import { isAcpRequest, isAcpResponse } from './types'

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CHANNEL = 'acp'
const DEFAULT_TIMEOUT = 30000

// =============================================================================
// Types
// =============================================================================

/** Response function passed to request handlers */
export type RespondFn = (response: AcpResponse) => void

/** Callback for session update notifications */
export type SessionUpdateCallback = (update: AcpNotification) => void

// =============================================================================
// AcpMeshAdapter
// =============================================================================

/**
 * Adapter that tunnels ACP messages through the mesh transport.
 *
 * Library consumers use this to connect their own ACP server to the mesh.
 * The adapter handles message routing, request/response correlation, and
 * group-based broadcast filtering.
 *
 * @example
 * ```typescript
 * import { NebulaMesh, AcpMeshAdapter } from 'agentic-mesh'
 *
 * const mesh = new NebulaMesh(config)
 * await mesh.start()
 *
 * const adapter = new AcpMeshAdapter(mesh)
 * await adapter.start()
 *
 * // Send ACP message to peer
 * adapter.send('peer-id', {
 *   jsonrpc: '2.0',
 *   method: 'session/update',
 *   params: { status: 'working' }
 * })
 *
 * // Receive messages from mesh
 * adapter.onMessage((message, from) => {
 *   // Route to your ACP server
 * })
 *
 * // Handle requests with response
 * adapter.onRequest((request, from, respond) => {
 *   respond({
 *     jsonrpc: '2.0',
 *     id: request.id,
 *     result: { success: true }
 *   })
 * })
 * ```
 */
export class AcpMeshAdapter extends EventEmitter {
  private mesh: NebulaMesh
  private config: Required<Omit<AcpMeshAdapterConfig, 'allowAllGroups'>> & { allowAllGroups: boolean }
  private channel: MessageChannel<AcpMeshEnvelope>
  private _started = false

  // Observer registry: sessionId -> Set<peerId>
  private observers: Map<string, Set<string>> = new Map()
  // Reverse index: peerId -> Set<sessionId> (for cleanup on disconnect)
  private peerSessions: Map<string, Set<string>> = new Map()

  // Session update callbacks: "peerId:sessionId" -> callback
  private sessionCallbacks: Map<string, SessionUpdateCallback> = new Map()
  private sessionUpdateListenerSetup = false

  constructor(mesh: NebulaMesh, config: AcpMeshAdapterConfig = {}) {
    super()
    this.mesh = mesh
    this.config = {
      channel: config.channel ?? DEFAULT_CHANNEL,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      allowAllGroups: config.allowAllGroups ?? false,
    }

    // Create dedicated channel for ACP messages
    this.channel = mesh.createChannel<AcpMeshEnvelope>(this.config.channel)

    // Handle incoming messages
    this.channel.on('message', (envelope, from) => {
      this.handleIncomingMessage(envelope, from)
    })

    // Listen for peer disconnects to cleanup observers
    this.mesh.on('peer:left', (peer: PeerInfo) => {
      this.handlePeerDisconnect(peer.id)
    })
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the adapter (opens the channel)
   */
  async start(): Promise<void> {
    if (this._started) return
    await this.channel.open()
    this._started = true
  }

  /**
   * Stop the adapter (closes the channel)
   */
  async stop(): Promise<void> {
    if (!this._started) return
    await this.channel.close()
    this._started = false
  }

  /**
   * Check if the adapter is started
   */
  get started(): boolean {
    return this._started
  }

  // ===========================================================================
  // Sending
  // ===========================================================================

  /**
   * Send an ACP message to a specific peer.
   *
   * @param peerId Target peer ID
   * @param message ACP message to send
   * @returns true if sent successfully, false if peer is offline
   */
  send(peerId: string, message: AcpMessage): boolean {
    if (!this._started) {
      throw new Error('AcpMeshAdapter is not started')
    }

    const envelope: AcpMeshEnvelope = {
      type: 'acp:message',
      message,
    }

    return this.channel.send(peerId, envelope)
  }

  /**
   * Send an ACP request and wait for response.
   *
   * Uses the underlying MessageChannel RPC support for request/response
   * correlation with timeout.
   *
   * @param peerId Target peer ID
   * @param request ACP request to send
   * @param timeout Timeout in ms (default: from config)
   * @returns Promise that resolves with the ACP response
   * @throws Error if timeout or peer not found
   */
  async request(
    peerId: string,
    request: AcpRequest,
    timeout?: number
  ): Promise<AcpResponse> {
    if (!this._started) {
      throw new Error('AcpMeshAdapter is not started')
    }

    const envelope: AcpMeshEnvelope = {
      type: 'acp:message',
      message: request,
    }

    const responseEnvelope = await this.channel.request<AcpMeshEnvelope>(
      peerId,
      envelope,
      timeout ?? this.config.timeout
    )

    if (responseEnvelope.type !== 'acp:message') {
      throw new Error('Invalid response envelope type')
    }

    const response = responseEnvelope.message
    if (!isAcpResponse(response)) {
      throw new Error('Expected ACP response but got different message type')
    }

    return response
  }

  /**
   * Broadcast an ACP message to peers.
   *
   * @param message ACP message to broadcast
   * @param target Optional target filter (default: all peers)
   */
  broadcast(message: AcpMessage, target?: BroadcastTarget): void {
    if (!this._started) {
      throw new Error('AcpMeshAdapter is not started')
    }

    const envelope: AcpMeshEnvelope = {
      type: 'acp:message',
      message,
    }

    if (target?.kind === 'group') {
      // Include target groups for receiver-side filtering
      envelope.targetGroups = target.groups
    }

    this.channel.broadcast(envelope)
  }

  // ===========================================================================
  // Receiving
  // ===========================================================================

  /**
   * Register a handler for incoming ACP messages.
   *
   * Called for all message types (requests, responses, notifications).
   *
   * @param handler Function to handle messages
   */
  onMessage(handler: (message: AcpMessage, from: PeerInfo) => void): void {
    this.on('message', handler)
  }

  /**
   * Remove a message handler.
   */
  offMessage(handler: (message: AcpMessage, from: PeerInfo) => void): void {
    this.off('message', handler)
  }

  /**
   * Register a handler for incoming ACP requests.
   *
   * Called only for messages that are requests (have id and method).
   * The respond callback should be used to send the response.
   *
   * @param handler Function to handle requests
   */
  onRequest(
    handler: (request: AcpRequest, from: PeerInfo, respond: RespondFn) => void
  ): void {
    this.on('request', handler)
  }

  /**
   * Remove a request handler.
   */
  offRequest(
    handler: (request: AcpRequest, from: PeerInfo, respond: RespondFn) => void
  ): void {
    this.off('request', handler)
  }

  // ===========================================================================
  // Observer Registry (Phase 3)
  // ===========================================================================

  /**
   * Register a peer as an observer of a session.
   *
   * @param peerId The peer ID to register as observer
   * @param sessionId The session ID to observe
   */
  registerObserver(peerId: string, sessionId: string): void {
    // Add to session observers
    if (!this.observers.has(sessionId)) {
      this.observers.set(sessionId, new Set())
    }
    this.observers.get(sessionId)!.add(peerId)

    // Add to reverse index
    if (!this.peerSessions.has(peerId)) {
      this.peerSessions.set(peerId, new Set())
    }
    this.peerSessions.get(peerId)!.add(sessionId)
  }

  /**
   * Unregister a peer from observing a session.
   *
   * @param peerId The peer ID to unregister
   * @param sessionId The session ID to stop observing
   */
  unregisterObserver(peerId: string, sessionId: string): void {
    this.observers.get(sessionId)?.delete(peerId)
    this.peerSessions.get(peerId)?.delete(sessionId)

    // Cleanup empty sets
    if (this.observers.get(sessionId)?.size === 0) {
      this.observers.delete(sessionId)
    }
    if (this.peerSessions.get(peerId)?.size === 0) {
      this.peerSessions.delete(peerId)
    }
  }

  /**
   * Get all observer peer IDs for a session.
   *
   * @param sessionId The session ID to get observers for
   * @returns Array of peer IDs observing the session
   */
  getObservers(sessionId: string): string[] {
    return Array.from(this.observers.get(sessionId) ?? [])
  }

  /**
   * Handle peer disconnect - cleanup all their observations.
   * Called automatically on peer:left events.
   *
   * @param peerId The peer ID that disconnected
   */
  handlePeerDisconnect(peerId: string): void {
    const sessions = this.peerSessions.get(peerId)
    if (sessions) {
      for (const sessionId of sessions) {
        this.observers.get(sessionId)?.delete(peerId)
        if (this.observers.get(sessionId)?.size === 0) {
          this.observers.delete(sessionId)
        }
      }
      this.peerSessions.delete(peerId)
    }
  }

  /**
   * Notify all observers that a session has ended.
   * Sends session/ended notification to all observers and cleans up.
   *
   * @param sessionId The session ID that ended
   * @param reason The reason the session ended
   */
  notifySessionEnded(
    sessionId: string,
    reason: 'completed' | 'cancelled' | 'error' | 'timeout'
  ): void {
    const observerList = this.getObservers(sessionId)

    const notification: AcpNotification = {
      jsonrpc: '2.0',
      method: 'session/ended',
      params: { sessionId, reason },
    }

    for (const peerId of observerList) {
      this.send(peerId, notification)
    }

    // Clean up observers for ended session
    for (const peerId of observerList) {
      this.unregisterObserver(peerId, sessionId)
    }
  }

  // ===========================================================================
  // Access Control
  // ===========================================================================

  /**
   * Check if a peer can access this peer's sessions.
   *
   * Access is granted if:
   * - allowAllGroups config is true, OR
   * - The peer shares at least one group with the local peer
   *
   * @param peer The peer requesting access
   * @returns true if access is allowed
   */
  canAccess(peer: PeerInfo): boolean {
    if (this.config.allowAllGroups) return true
    const localGroups = this.mesh.getSelf().groups
    return peer.groups.some((g) => localGroups.includes(g))
  }

  // ===========================================================================
  // Session Observation Helpers
  // ===========================================================================

  /**
   * Observe a session on a remote peer.
   *
   * Sends a session/observe request to the peer and registers a callback
   * for session/update notifications. The remote peer must accept the
   * observation request.
   *
   * @param peerId Remote peer ID
   * @param sessionId Session ID to observe
   * @param callback Called when session updates are received
   * @throws Error if adapter not started, peer denies access, or request fails
   *
   * @example
   * ```typescript
   * await adapter.observeSession('peer-b', 'session-1', (update) => {
   *   console.log('Session update:', update.params)
   * })
   * ```
   */
  async observeSession(
    peerId: string,
    sessionId: string,
    callback: SessionUpdateCallback
  ): Promise<void> {
    if (!this._started) {
      throw new Error('AcpMeshAdapter is not started')
    }

    const request: AcpRequest = {
      jsonrpc: '2.0',
      id: `observe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: 'session/observe',
      params: { sessionId },
    }

    const response = await this.request(peerId, request)
    const result = response.result as { success: boolean; error?: string } | undefined

    if (!result?.success) {
      throw new Error(result?.error ?? 'Failed to observe session')
    }

    // Register callback
    const key = `${peerId}:${sessionId}`
    this.sessionCallbacks.set(key, callback)

    // Setup listener for session updates if not already listening
    this.ensureSessionUpdateListener()
  }

  /**
   * Stop observing a session on a remote peer.
   *
   * Sends a session/unobserve request and removes the local callback.
   *
   * @param peerId Remote peer ID
   * @param sessionId Session ID to stop observing
   * @throws Error if adapter not started
   */
  async unobserveSession(peerId: string, sessionId: string): Promise<void> {
    if (!this._started) {
      throw new Error('AcpMeshAdapter is not started')
    }

    const request: AcpRequest = {
      jsonrpc: '2.0',
      id: `unobserve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: 'session/unobserve',
      params: { sessionId },
    }

    await this.request(peerId, request)

    // Remove callback
    const key = `${peerId}:${sessionId}`
    this.sessionCallbacks.delete(key)
  }

  /**
   * Setup listener for session/update notifications.
   * Routes updates to registered callbacks.
   */
  private ensureSessionUpdateListener(): void {
    if (this.sessionUpdateListenerSetup) return
    this.sessionUpdateListenerSetup = true

    this.onMessage((message, from) => {
      // Check if this is a session/update notification
      if ('method' in message && message.method === 'session/update') {
        const params = message.params as { sessionId?: string } | undefined
        const sessionId = params?.sessionId
        if (sessionId) {
          const key = `${from.id}:${sessionId}`
          const callback = this.sessionCallbacks.get(key)
          if (callback) {
            callback(message as AcpNotification)
          }
        }
      }
    })
  }

  /**
   * List sessions on a remote peer.
   *
   * Sends a session/list request to the peer and returns session metadata.
   *
   * @param peerId Remote peer ID
   * @param options Optional options
   * @param options.includeInactive Include inactive/ended sessions (default: false)
   * @param options.timeout Request timeout in ms (default: from config)
   * @returns Array of session info objects
   * @throws Error if adapter not started or request fails
   *
   * @example
   * ```typescript
   * const sessions = await adapter.listPeerSessions('peer-b')
   * for (const session of sessions) {
   *   console.log(`Session ${session.sessionId} (${session.mode})`)
   * }
   * ```
   */
  async listPeerSessions(
    peerId: string,
    options?: { includeInactive?: boolean; timeout?: number }
  ): Promise<SessionInfo[]> {
    if (!this._started) {
      throw new Error('AcpMeshAdapter is not started')
    }

    const request: AcpRequest = {
      jsonrpc: '2.0',
      id: `list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: 'session/list',
      params: { includeInactive: options?.includeInactive ?? false },
    }

    const response = await this.request(peerId, request, options?.timeout)
    const result = response.result as { sessions?: SessionInfo[] } | undefined

    return result?.sessions ?? []
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private handleIncomingMessage(envelope: AcpMeshEnvelope, from: PeerInfo): void {
    // Check group filtering for broadcasts
    if (envelope.targetGroups && envelope.targetGroups.length > 0) {
      const localGroups = this.mesh.getSelf().groups
      const hasMatch = envelope.targetGroups.some((g) => localGroups.includes(g))
      if (!hasMatch) {
        return // Not for us, filtered by group
      }
    }

    const message = envelope.message

    // Emit appropriate event based on message type
    if (isAcpRequest(message)) {
      const respond: RespondFn = (response: AcpResponse) => {
        this.send(from.id, response)
      }
      this.emit('request', message, from, respond)
    }

    // Always emit the raw message (for both requests and notifications)
    this.emit('message', message, from)
  }
}
