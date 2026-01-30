/**
 * Git Transport Service
 *
 * Provides git transport over agentic-mesh. This service:
 * - Exposes HTTP endpoints for the local git-remote-mesh helper
 * - Routes git operations to remote peers via MAP messages
 * - Handles incoming git requests from remote peers
 * - Supports binary streaming for large pack transfers
 */

import { EventEmitter } from 'events'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import type {
  GitTransportConfig,
  ListRefsRequest,
  ListRefsResponse,
  UploadPackRequest,
  UploadPackResponse,
  ReceivePackRequest,
  ReceivePackResponse,
  GitProtocolHandler,
  GitMessageType,
  AnyGitMessage,
  GitListRefsMessage,
  GitUploadPackMessage,
  GitReceivePackMessage,
  GitErrorMessage,
  GitPackStreamMessage,
  GitPackChunkMessage,
  GitPackCompleteMessage,
} from './types'
import { DEFAULT_GIT_TRANSPORT_CONFIG } from './types'
import { GitProtocolHandlerImpl, GitProtocolError } from './protocol-handler'
import { PackStreamer, PackReceiver, createPackStreamer, createPackReceiver } from './pack-streamer'
import { GitSyncClient, createGitSyncClient } from './sync-client'

// =============================================================================
// Types
// =============================================================================

/** Configuration for the git transport service */
export interface GitTransportServiceConfig {
  /** HTTP server port for git-remote-mesh helper */
  httpPort: number
  /** HTTP server host (default: localhost for security) */
  httpHost: string
  /** Git protocol handler configuration */
  git: Partial<GitTransportConfig>
  /** Request timeout in milliseconds */
  requestTimeoutMs: number
  /** Streaming configuration */
  streaming: {
    /** Enable streaming for large packs (default: true) */
    enabled: boolean
    /** Threshold in bytes above which to use streaming (default: 1MB) */
    threshold: number
    /** Chunk size for streaming (default: 64KB) */
    chunkSize: number
  }
}

/** Default service configuration */
export const DEFAULT_GIT_SERVICE_CONFIG: GitTransportServiceConfig = {
  httpPort: 3456,
  httpHost: '127.0.0.1',
  git: {},
  requestTimeoutMs: 300000, // 5 minutes
  streaming: {
    enabled: true,
    threshold: 1024 * 1024, // 1MB
    chunkSize: 64 * 1024, // 64KB
  },
}

/** Events emitted by the git transport service */
export interface GitTransportServiceEvents {
  started: () => void
  stopped: () => void
  'request:list-refs': (peerId: string, request: ListRefsRequest) => void
  'request:upload-pack': (peerId: string, request: UploadPackRequest) => void
  'request:receive-pack': (peerId: string, request: ReceivePackRequest) => void
  'stream:started': (peerId: string, correlationId: string, totalSize: number) => void
  'stream:progress': (peerId: string, correlationId: string, bytesTransferred: number) => void
  'stream:completed': (peerId: string, correlationId: string, totalBytes: number) => void
  error: (error: Error) => void
}

/** Pending request tracker */
interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Pending stream tracker */
interface PendingStream {
  receiver: PackReceiver
  resolve: (data: Buffer) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Interface for sending messages to peers */
export interface PeerMessageSender {
  sendToPeer(peerId: string, message: AnyGitMessage): Promise<void>
  isConnected(peerId: string): boolean
}

// =============================================================================
// Git Transport Service
// =============================================================================

export class GitTransportService extends EventEmitter {
  private readonly config: GitTransportServiceConfig
  private readonly handler: GitProtocolHandler
  private readonly packStreamer: PackStreamer
  private httpServer: Server | null = null
  private peerSender: PeerMessageSender | null = null
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()
  private readonly pendingStreams = new Map<string, PendingStream>()
  private running = false

  constructor(config: Partial<GitTransportServiceConfig> = {}) {
    super()
    this.config = { ...DEFAULT_GIT_SERVICE_CONFIG, ...config }
    this.handler = new GitProtocolHandlerImpl({ config: this.config.git })
    this.packStreamer = createPackStreamer({ timeoutMs: this.config.requestTimeoutMs })
    this.setupPackStreamerEvents()
  }

  /** Set up event handlers for pack streaming */
  private setupPackStreamerEvents(): void {
    this.packStreamer.on('progress', (bytesTransferred: number, totalBytes?: number) => {
      // Progress events are emitted per-stream via pending streams
    })

    this.packStreamer.on('complete', (checksum: string, totalBytes: number) => {
      // Completion events are handled per-stream
    })
  }

  /** Get the protocol handler */
  get protocolHandler(): GitProtocolHandler {
    return this.handler
  }

  /** Whether the service is running */
  get isRunning(): boolean {
    return this.running
  }

  /** Get the HTTP port the service is running on */
  get httpPort(): number {
    return this.config.httpPort
  }

  /**
   * Create a sync client for a specific repository.
   * Use this for high-level git sync operations.
   *
   * @example
   * ```typescript
   * const client = gitService.createSyncClient('/path/to/repo')
   * await client.sync('peer-id', { branch: 'main' })
   * ```
   */
  createSyncClient(repoPath: string): GitSyncClient {
    return createGitSyncClient(repoPath, this, this.config.httpPort)
  }

  /** Set the peer message sender (called by MeshPeer) */
  setPeerSender(sender: PeerMessageSender): void {
    this.peerSender = sender
    // Configure pack streamer to use the same sender
    this.packStreamer.setSendMessage(async (peerId, message) => {
      await sender.sendToPeer(peerId, message)
    })
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Start the git transport service */
  async start(): Promise<void> {
    if (this.running) return

    // Start HTTP server for local helper communication
    await this.startHttpServer()

    this.running = true
    this.emit('started')
  }

  /** Stop the git transport service */
  async stop(): Promise<void> {
    if (!this.running) return

    // Cancel all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Service stopped'))
    }
    this.pendingRequests.clear()

    // Cancel all pending streams
    for (const [id, stream] of this.pendingStreams) {
      clearTimeout(stream.timeout)
      stream.reject(new Error('Service stopped'))
    }
    this.pendingStreams.clear()

    // Stop HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve())
      })
      this.httpServer = null
    }

    this.running = false
    this.emit('stopped')
  }

  // ==========================================================================
  // HTTP Server (for git-remote-mesh helper)
  // ==========================================================================

  private async startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          this.sendHttpError(res, 500, err.message)
        })
      })

      this.httpServer.on('error', (err) => {
        reject(err)
      })

      this.httpServer.listen(this.config.httpPort, this.config.httpHost, () => {
        resolve()
      })
    })
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Set CORS headers for local development
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost')

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'POST') {
      this.sendHttpError(res, 405, 'Method not allowed')
      return
    }

    // Parse request body
    const body = await this.readRequestBody(req)
    const url = req.url || '/'

    try {
      let result: unknown

      switch (url) {
        case '/git/list-refs':
          result = await this.handleListRefs(body)
          break

        case '/git/upload-pack':
          result = await this.handleUploadPack(body)
          break

        case '/git/receive-pack':
          result = await this.handleReceivePack(body)
          break

        case '/git/status':
          result = this.getStatus()
          break

        default:
          this.sendHttpError(res, 404, `Unknown endpoint: ${url}`)
          return
      }

      res.writeHead(200)
      res.end(JSON.stringify(result))
    } catch (err) {
      if (err instanceof GitProtocolError) {
        this.sendHttpError(res, 400, err.message, err.code)
      } else {
        this.sendHttpError(res, 500, err instanceof Error ? err.message : 'Unknown error')
      }
    }
  }

  private async readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []

      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve(body ? JSON.parse(body) : {})
        } catch (err) {
          reject(new Error('Invalid JSON body'))
        }
      })
      req.on('error', reject)
    })
  }

  private sendHttpError(
    res: ServerResponse,
    status: number,
    message: string,
    code?: string
  ): void {
    res.writeHead(status)
    res.end(JSON.stringify({ error: { code: code ?? 'ERROR', message } }))
  }

  // ==========================================================================
  // HTTP Endpoint Handlers
  // ==========================================================================

  private async handleListRefs(
    body: Record<string, unknown>
  ): Promise<ListRefsResponse> {
    const peerId = body.peerId as string
    const request: ListRefsRequest = {
      refPrefix: body.refPrefix as string | undefined,
      forPush: body.forPush as boolean | undefined,
    }

    this.emit('request:list-refs', peerId, request)

    // If peerId is provided, forward to remote peer
    if (peerId) {
      return this.forwardToRemote<ListRefsResponse>(peerId, 'git/list-refs', request)
    }

    // Otherwise handle locally
    return this.handler.listRefs(request)
  }

  private async handleUploadPack(
    body: Record<string, unknown>
  ): Promise<UploadPackResponse> {
    const peerId = body.peerId as string
    const request: UploadPackRequest = {
      wants: body.wants as string[],
      haves: (body.haves as string[]) ?? [],
      depth: body.depth as number | undefined,
      filter: body.filter as string | undefined,
      includeTags: body.includeTags as boolean | undefined,
      noProgress: body.noProgress as boolean | undefined,
    }

    this.emit('request:upload-pack', peerId, request)

    // If peerId is provided, forward to remote peer
    if (peerId) {
      return this.forwardToRemote<UploadPackResponse>(peerId, 'git/upload-pack', request)
    }

    // Otherwise handle locally
    return this.handler.uploadPack(request)
  }

  private async handleReceivePack(
    body: Record<string, unknown>
  ): Promise<ReceivePackResponse> {
    const peerId = body.peerId as string
    const request: ReceivePackRequest = {
      commands: body.commands as ReceivePackRequest['commands'],
      packData: body.packData as string | undefined,
      pushOptions: body.pushOptions as string[] | undefined,
      atomic: body.atomic as boolean | undefined,
    }

    this.emit('request:receive-pack', peerId, request)

    // If peerId is provided, forward to remote peer
    if (peerId) {
      return this.forwardToRemote<ReceivePackResponse>(peerId, 'git/receive-pack', request)
    }

    // Otherwise handle locally
    return this.handler.receivePack(request)
  }

  private getStatus(): Record<string, unknown> {
    return {
      running: this.running,
      config: this.handler.getConfig(),
      pendingRequests: this.pendingRequests.size,
    }
  }

  // ==========================================================================
  // Remote Peer Communication
  // ==========================================================================

  /** Forward a git request to a remote peer */
  private async forwardToRemote<T>(
    peerId: string,
    type: GitMessageType,
    request: unknown
  ): Promise<T> {
    if (!this.peerSender) {
      throw new GitProtocolError('NO_PEER_SENDER', 'Peer sender not configured')
    }

    if (!this.peerSender.isConnected(peerId)) {
      throw new GitProtocolError('PEER_NOT_CONNECTED', `Peer ${peerId} is not connected`)
    }

    const correlationId = this.generateCorrelationId()

    // Create the message
    const message = {
      type,
      correlationId,
      request,
    } as AnyGitMessage

    // Set up response promise
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(correlationId)
        reject(new GitProtocolError('TIMEOUT', 'Request timed out'))
      }, this.config.requestTimeoutMs)

      this.pendingRequests.set(correlationId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })
    })

    // Send the message
    await this.peerSender.sendToPeer(peerId, message)

    return responsePromise
  }

  /** Handle an incoming git message from a remote peer */
  async handleRemoteMessage(
    fromPeerId: string,
    message: AnyGitMessage
  ): Promise<void> {
    // Handle streaming messages first
    if (this.handleStreamMessage(fromPeerId, message)) {
      return
    }

    // Check if this is a response to a pending request
    const pending = this.pendingRequests.get(message.correlationId)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(message.correlationId)

      if (message.type === 'git/error') {
        const errorMsg = message as GitErrorMessage
        pending.reject(new GitProtocolError(errorMsg.code, errorMsg.message))
      } else {
        // Extract the response from the message
        pending.resolve((message as unknown as { response: unknown }).response)
      }
      return
    }

    // This is a new request from a remote peer - handle it
    try {
      let response: unknown
      let streamPackData: Buffer | null = null

      switch (message.type) {
        case 'git/list-refs': {
          const req = message as GitListRefsMessage
          response = await this.handler.listRefs(req.request)
          break
        }

        case 'git/upload-pack': {
          const req = message as GitUploadPackMessage
          const uploadResponse = await this.handler.uploadPack(req.request)

          // Check if we should stream the pack data
          if (
            this.config.streaming.enabled &&
            uploadResponse.packData &&
            this.shouldStreamPack(uploadResponse.packData)
          ) {
            // Decode the base64 pack data
            streamPackData = Buffer.from(uploadResponse.packData, 'base64')
            // Send response without pack data (it will be streamed)
            response = { ...uploadResponse, packData: undefined, streaming: true }
          } else {
            response = uploadResponse
          }
          break
        }

        case 'git/receive-pack': {
          const req = message as GitReceivePackMessage
          response = await this.handler.receivePack(req.request)
          break
        }

        default:
          throw new GitProtocolError('UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`)
      }

      // Send response back
      if (this.peerSender) {
        await this.peerSender.sendToPeer(fromPeerId, {
          type: message.type,
          correlationId: message.correlationId,
          response,
        } as AnyGitMessage)

        // Stream pack data if needed
        if (streamPackData) {
          this.emit('stream:started', fromPeerId, message.correlationId, streamPackData.length)
          await this.packStreamer.streamPack(
            fromPeerId,
            message.correlationId,
            streamPackData,
            {
              chunkSize: this.config.streaming.chunkSize,
              onProgress: (bytesTransferred, totalBytes) => {
                this.emit('stream:progress', fromPeerId, message.correlationId, bytesTransferred)
              },
            }
          )
          this.emit('stream:completed', fromPeerId, message.correlationId, streamPackData.length)
        }
      }
    } catch (err) {
      // Send error response
      if (this.peerSender) {
        const errorMessage: GitErrorMessage = {
          type: 'git/error',
          correlationId: message.correlationId,
          code: err instanceof GitProtocolError ? err.code : 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        }
        await this.peerSender.sendToPeer(fromPeerId, errorMessage)
      }
    }
  }

  /** Handle streaming-specific messages */
  private handleStreamMessage(fromPeerId: string, message: AnyGitMessage): boolean {
    switch (message.type) {
      case 'git/pack-stream': {
        const streamMsg = message as GitPackStreamMessage
        // Receiving side: start collecting chunks
        if (streamMsg.direction === 'download') {
          this.startReceivingStream(fromPeerId, streamMsg.correlationId, streamMsg.totalSize)
        }
        return true
      }

      case 'git/pack-chunk': {
        const chunkMsg = message as GitPackChunkMessage
        const stream = this.pendingStreams.get(chunkMsg.correlationId)
        if (stream) {
          const chunk = Buffer.from(chunkMsg.data, 'base64')
          stream.receiver.addChunk(chunkMsg.sequence, chunk)
          const progress = stream.receiver.getProgress()
          this.emit('stream:progress', fromPeerId, chunkMsg.correlationId, progress.receivedBytes)
        }
        return true
      }

      case 'git/pack-complete': {
        const completeMsg = message as GitPackCompleteMessage
        const stream = this.pendingStreams.get(completeMsg.correlationId)
        if (stream) {
          clearTimeout(stream.timeout)
          this.pendingStreams.delete(completeMsg.correlationId)
          try {
            const data = stream.receiver.complete(completeMsg.checksum, completeMsg.totalBytes)
            stream.resolve(data)
            this.emit('stream:completed', fromPeerId, completeMsg.correlationId, completeMsg.totalBytes)
          } catch (err) {
            stream.reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
        return true
      }

      default:
        return false
    }
  }

  /** Start receiving a streamed pack */
  private startReceivingStream(peerId: string, correlationId: string, totalSize?: number): void {
    const receiver = createPackReceiver(totalSize)
    const timeout = setTimeout(() => {
      this.pendingStreams.delete(correlationId)
      // Stream timed out - but we may already have a pending request waiting
    }, this.config.requestTimeoutMs)

    // Create a promise for the stream completion
    const streamPromise = new Promise<Buffer>((resolve, reject) => {
      this.pendingStreams.set(correlationId, {
        receiver,
        resolve,
        reject,
        timeout,
      })
    })

    // Update the pending request to wait for stream
    const pending = this.pendingRequests.get(correlationId)
    if (pending) {
      // The original request will be resolved with streamed data
      streamPromise.then((packData) => {
        // Merge pack data into the response
        const originalResolve = pending.resolve
        pending.resolve = (response: unknown) => {
          const uploadResponse = response as UploadPackResponse
          originalResolve({
            ...uploadResponse,
            packData: packData.toString('base64'),
          })
        }
      }).catch((err) => {
        pending.reject(err)
      })
    }

    this.emit('stream:started', peerId, correlationId, totalSize ?? 0)
  }

  /** Check if pack data should be streamed */
  private shouldStreamPack(packData: string): boolean {
    // packData is base64 encoded, so actual size is ~75% of string length
    const estimatedSize = Math.floor(packData.length * 0.75)
    return estimatedSize >= this.config.streaming.threshold
  }

  private generateCorrelationId(): string {
    return `git-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/** Create a git transport service */
export function createGitTransportService(
  config?: Partial<GitTransportServiceConfig>
): GitTransportService {
  return new GitTransportService(config)
}
