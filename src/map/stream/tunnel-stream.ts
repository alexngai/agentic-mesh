/**
 * Tunnel Stream Adapter
 *
 * Wraps an agentic-mesh TransportAdapter connection as a MAP-compatible stream.
 * Uses NDJSON (newline-delimited JSON) framing for MAP protocol messages.
 */

import { EventEmitter } from 'events'
import type { TransportAdapter } from '../../transports/types'
import type { MapStream, FramingOptions, NdjsonFramer } from './types'
import type { MapFrame, MapConnectionState } from '../types'

/**
 * Creates an NDJSON framer for encoding/decoding MAP frames.
 */
export function createNdjsonFramer(options: FramingOptions = {}): NdjsonFramer {
  const maxFrameSize = options.maxFrameSize ?? 1024 * 1024 // 1MB default
  const encoding = options.encoding ?? 'utf-8'
  const delimiter = options.delimiter ?? '\n'

  let buffer = Buffer.alloc(0)

  return {
    encode(frame: MapFrame): Buffer {
      const json = JSON.stringify(frame)
      if (json.length > maxFrameSize) {
        throw new Error(`Frame exceeds maximum size: ${json.length} > ${maxFrameSize}`)
      }
      return Buffer.from(json + delimiter, encoding)
    },

    decode(data: Buffer): { frames: MapFrame[]; remainder: Buffer } {
      buffer = Buffer.concat([buffer, data])
      const frames: MapFrame[] = []

      while (true) {
        const delimiterIndex = buffer.indexOf(delimiter, 0, encoding)
        if (delimiterIndex === -1) {
          break
        }

        const line = buffer.subarray(0, delimiterIndex).toString(encoding)
        buffer = buffer.subarray(delimiterIndex + delimiter.length)

        if (line.length === 0) {
          continue // Skip empty lines
        }

        if (line.length > maxFrameSize) {
          throw new Error(`Frame exceeds maximum size: ${line.length} > ${maxFrameSize}`)
        }

        try {
          const frame = JSON.parse(line) as MapFrame
          frames.push(frame)
        } catch (err) {
          throw new Error(`Invalid JSON frame: ${(err as Error).message}`)
        }
      }

      return { frames, remainder: buffer }
    },

    reset(): void {
      buffer = Buffer.alloc(0)
    },
  }
}

/**
 * Configuration for a tunnel stream.
 */
export interface TunnelStreamConfig {
  /** The underlying transport adapter */
  transport: TransportAdapter

  /** Remote peer ID */
  peerId: string

  /** Stream identifier */
  streamId?: string

  /** Framing options */
  framing?: FramingOptions
}

/**
 * A MAP stream that communicates over an agentic-mesh transport connection.
 */
export class TunnelStream extends EventEmitter implements MapStream {
  readonly id: string
  private readonly transport: TransportAdapter
  private readonly peerId: string
  private readonly framer: NdjsonFramer
  private _state: MapConnectionState = 'connecting'
  private _isOpen = false
  private frameQueue: MapFrame[] = []
  private waitingReaders: Array<{
    resolve: (value: IteratorResult<MapFrame>) => void
    reject: (error: Error) => void
  }> = []
  private dataHandler: ((peerId: string, data: Buffer) => void) | null = null
  private disconnectHandler: ((peerId: string, reason?: string) => void) | null = null

  constructor(config: TunnelStreamConfig) {
    super()
    this.id = config.streamId ?? `tunnel-${config.peerId}-${Date.now()}`
    this.transport = config.transport
    this.peerId = config.peerId
    this.framer = createNdjsonFramer(config.framing)
    this.setupHandlers()
  }

  get isOpen(): boolean {
    return this._isOpen
  }

  get state(): MapConnectionState {
    return this._state
  }

  private setupHandlers(): void {
    this.dataHandler = (peerId: string, data: Buffer) => {
      if (peerId !== this.peerId) return

      try {
        const { frames } = this.framer.decode(data)
        for (const frame of frames) {
          this.enqueueFrame(frame)
        }
      } catch (err) {
        this.emit('error', err)
      }
    }

    this.disconnectHandler = (peerId: string, reason?: string) => {
      if (peerId !== this.peerId) return
      this.handleDisconnect(reason)
    }

    this.transport.on('data', this.dataHandler)
    this.transport.on('peer:disconnected', this.disconnectHandler)

    // Check if already connected
    if (this.transport.isConnected(this.peerId)) {
      this._state = 'connected'
      this._isOpen = true
    }
  }

  private enqueueFrame(frame: MapFrame): void {
    if (this.waitingReaders.length > 0) {
      const reader = this.waitingReaders.shift()!
      reader.resolve({ value: frame, done: false })
    } else {
      this.frameQueue.push(frame)
    }
  }

  private handleDisconnect(reason?: string): void {
    this._state = 'disconnected'
    this._isOpen = false

    // Reject all waiting readers
    const error = new Error(`Stream disconnected: ${reason ?? 'unknown'}`)
    for (const reader of this.waitingReaders) {
      reader.reject(error)
    }
    this.waitingReaders = []

    this.emit('close')
  }

  async write(frame: MapFrame): Promise<void> {
    if (!this._isOpen) {
      throw new Error('Stream is not open')
    }

    const data = this.framer.encode(frame)
    const sent = this.transport.send(this.peerId, data)

    if (!sent) {
      throw new Error(`Failed to send frame to peer ${this.peerId}`)
    }
  }

  async close(): Promise<void> {
    if (!this._isOpen) return

    this._state = 'disconnecting'

    // Clean up handlers
    if (this.dataHandler) {
      this.transport.off('data', this.dataHandler)
    }
    if (this.disconnectHandler) {
      this.transport.off('peer:disconnected', this.disconnectHandler)
    }

    this._state = 'disconnected'
    this._isOpen = false
    this.framer.reset()

    // Signal end to any waiting readers
    for (const reader of this.waitingReaders) {
      reader.resolve({ value: undefined as unknown as MapFrame, done: true })
    }
    this.waitingReaders = []

    this.emit('close')
  }

  [Symbol.asyncIterator](): AsyncIterator<MapFrame> {
    return {
      next: async (): Promise<IteratorResult<MapFrame>> => {
        // Return queued frames first
        if (this.frameQueue.length > 0) {
          return { value: this.frameQueue.shift()!, done: false }
        }

        // If stream is closed, we're done
        if (!this._isOpen) {
          return { value: undefined as unknown as MapFrame, done: true }
        }

        // Wait for next frame
        return new Promise((resolve, reject) => {
          this.waitingReaders.push({ resolve, reject })
        })
      },
    }
  }

  /**
   * Open the stream (establish connection if needed).
   */
  async open(): Promise<void> {
    if (this._isOpen) return

    this._state = 'connecting'

    if (!this.transport.isConnected(this.peerId)) {
      throw new Error(`Not connected to peer ${this.peerId}`)
    }

    this._state = 'connected'
    this._isOpen = true
  }
}

/**
 * Create a tunnel stream for a peer connection.
 */
export function createTunnelStream(config: TunnelStreamConfig): TunnelStream {
  return new TunnelStream(config)
}
