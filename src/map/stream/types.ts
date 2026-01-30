/**
 * Stream Types for MAP Protocol
 *
 * Defines the stream interface for MAP communication over various transports.
 */

import type { MapFrame, MapConnectionState } from '../types'

/**
 * A bidirectional stream for MAP JSON-RPC communication.
 */
export interface MapStream {
  /** Write a frame to the stream */
  write(frame: MapFrame): Promise<void>

  /** Async iterator for reading frames */
  [Symbol.asyncIterator](): AsyncIterator<MapFrame>

  /** Close the stream */
  close(): Promise<void>

  /** Whether the stream is currently open */
  readonly isOpen: boolean

  /** Current connection state */
  readonly state: MapConnectionState

  /** Stream identifier (for debugging) */
  readonly id: string

  /** Event handlers */
  on(event: 'close', handler: () => void): void
  on(event: 'error', handler: (error: Error) => void): void
  off(event: 'close', handler: () => void): void
  off(event: 'error', handler: (error: Error) => void): void
}

/**
 * Factory for creating MAP streams.
 */
export interface MapStreamFactory {
  /** Create a stream for an established connection */
  createStream(connectionId: string): MapStream
}

/**
 * Options for stream framing.
 */
export interface FramingOptions {
  /** Maximum frame size in bytes (default: 1MB) */
  maxFrameSize?: number

  /** Encoding for JSON (default: utf-8) */
  encoding?: BufferEncoding

  /** Line delimiter (default: \n) */
  delimiter?: string
}

/**
 * NDJSON framing utilities.
 */
export interface NdjsonFramer {
  /** Encode a frame to bytes */
  encode(frame: MapFrame): Buffer

  /** Decode bytes to frames (handles partial data) */
  decode(data: Buffer): { frames: MapFrame[]; remainder: Buffer }

  /** Reset internal state */
  reset(): void
}
