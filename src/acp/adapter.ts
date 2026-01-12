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
  AcpMeshEnvelope,
  AcpMeshAdapterConfig,
  BroadcastTarget,
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
  private config: Required<AcpMeshAdapterConfig>
  private channel: MessageChannel<AcpMeshEnvelope>
  private _started = false

  constructor(mesh: NebulaMesh, config: AcpMeshAdapterConfig = {}) {
    super()
    this.mesh = mesh
    this.config = {
      channel: config.channel ?? DEFAULT_CHANNEL,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    }

    // Create dedicated channel for ACP messages
    this.channel = mesh.createChannel<AcpMeshEnvelope>(this.config.channel)

    // Handle incoming messages
    this.channel.on('message', (envelope, from) => {
      this.handleIncomingMessage(envelope, from)
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
