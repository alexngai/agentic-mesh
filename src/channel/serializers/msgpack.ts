// MessagePack Serializer
// Implements: i-8shy

import { encode, decode } from '@msgpack/msgpack'
import type { Serializer } from './types'
import { FORMAT_MSGPACK, FORMAT_MSGPACK_COMPRESSED } from './types'
import * as zlib from 'zlib'

// Threshold for compression (1KB)
const COMPRESSION_THRESHOLD = 1024

/**
 * MessagePack serializer for wire protocol.
 * Uses binary encoding with optional zlib compression for large messages.
 */
export class MsgpackSerializer implements Serializer {
  readonly format = 'binary' as const
  private compressionEnabled: boolean

  constructor(options?: { compression?: boolean }) {
    this.compressionEnabled = options?.compression ?? true
  }

  /**
   * Encode data to a buffer with MessagePack format prefix.
   * Large messages (>1KB) are compressed with zlib if compression is enabled.
   */
  encode(data: unknown): Buffer {
    const msgpackData = encode(data)
    const msgpackBuffer = Buffer.from(msgpackData)

    // Check if compression is needed
    if (this.compressionEnabled && msgpackBuffer.length > COMPRESSION_THRESHOLD) {
      const compressed = zlib.deflateSync(msgpackBuffer)

      // Only use compression if it's actually smaller
      if (compressed.length < msgpackBuffer.length) {
        const result = Buffer.allocUnsafe(1 + compressed.length)
        result[0] = FORMAT_MSGPACK_COMPRESSED
        compressed.copy(result, 1)
        return result
      }
    }

    // No compression - use plain MessagePack
    const result = Buffer.allocUnsafe(1 + msgpackBuffer.length)
    result[0] = FORMAT_MSGPACK
    msgpackBuffer.copy(result, 1)

    return result
  }

  /**
   * Decode MessagePack data from buffer (without format prefix).
   * Handles both compressed and uncompressed formats.
   */
  decode(buffer: Buffer): unknown {
    return decode(buffer)
  }

  /**
   * Decode compressed MessagePack data from buffer (without format prefix).
   */
  decodeCompressed(buffer: Buffer): unknown {
    const decompressed = zlib.inflateSync(buffer)
    return decode(decompressed)
  }

  /**
   * Check if this is a MessagePack formatted message
   */
  canDecode(formatByte: number): boolean {
    return formatByte === FORMAT_MSGPACK || formatByte === FORMAT_MSGPACK_COMPRESSED
  }

  /**
   * Check if the format byte indicates compression
   */
  isCompressed(formatByte: number): boolean {
    return formatByte === FORMAT_MSGPACK_COMPRESSED
  }
}
