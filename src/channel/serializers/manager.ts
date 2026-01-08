// SerializerManager - handles format negotiation and message encoding/decoding
// Implements: i-8shy

import { JsonSerializer } from './json'
import { MsgpackSerializer } from './msgpack'
import type {
  SerializationFormat,
  SerializerCapabilities,
  NegotiatedFormat,
} from './types'
import { FORMAT_JSON, FORMAT_MSGPACK, FORMAT_MSGPACK_COMPRESSED } from './types'

/**
 * SerializerManager handles encoding/decoding messages with format negotiation.
 *
 * Features:
 * - Automatic format negotiation between peers
 * - Fallback to JSON for compatibility
 * - Per-peer format caching
 * - Compression support for large messages
 */
export class SerializerManager {
  private localFormat: SerializationFormat
  private jsonSerializer: JsonSerializer
  private msgpackSerializer: MsgpackSerializer
  private peerFormats: Map<string, NegotiatedFormat> = new Map()
  private compressionEnabled: boolean

  constructor(options?: { format?: SerializationFormat; compression?: boolean }) {
    this.localFormat = options?.format ?? 'auto'
    this.compressionEnabled = options?.compression ?? true

    this.jsonSerializer = new JsonSerializer()
    this.msgpackSerializer = new MsgpackSerializer({
      compression: this.compressionEnabled,
    })
  }

  /**
   * Get the local capabilities to advertise in handshake
   */
  getCapabilities(): SerializerCapabilities {
    const supportedFormats: ('json' | 'binary')[] =
      this.localFormat === 'json'
        ? ['json']
        : this.localFormat === 'binary'
          ? ['binary', 'json'] // Binary-preferred but JSON fallback
          : ['binary', 'json'] // Auto prefers binary

    return {
      supportedFormats,
      compressionSupported: this.compressionEnabled,
    }
  }

  /**
   * Negotiate format with a peer based on their capabilities
   */
  negotiateFormat(peerId: string, remoteCapabilities: SerializerCapabilities): NegotiatedFormat {
    const local = this.getCapabilities()

    // Find best mutual format (prefer binary if both support it)
    let format: 'json' | 'binary' = 'json'

    for (const localFormat of local.supportedFormats) {
      if (remoteCapabilities.supportedFormats.includes(localFormat)) {
        format = localFormat
        break
      }
    }

    // Compression only if both support it and format is binary
    const compress =
      format === 'binary' &&
      local.compressionSupported &&
      remoteCapabilities.compressionSupported

    const negotiated: NegotiatedFormat = { format, compress }
    this.peerFormats.set(peerId, negotiated)

    return negotiated
  }

  /**
   * Get the negotiated format for a peer, or default
   */
  getFormatForPeer(peerId: string): NegotiatedFormat {
    return (
      this.peerFormats.get(peerId) ?? {
        format: this.localFormat === 'binary' ? 'binary' : 'json',
        compress: this.compressionEnabled && this.localFormat !== 'json',
      }
    )
  }

  /**
   * Remove negotiated format when peer disconnects
   */
  removePeer(peerId: string): void {
    this.peerFormats.delete(peerId)
  }

  /**
   * Encode a message for a specific peer
   */
  encode(data: unknown, peerId?: string): Buffer {
    const format = peerId ? this.getFormatForPeer(peerId) : { format: 'json' as const, compress: false }

    if (format.format === 'binary') {
      return this.msgpackSerializer.encode(data)
    }

    return this.jsonSerializer.encode(data)
  }

  /**
   * Decode a message based on its format prefix byte
   */
  decode(buffer: Buffer): unknown {
    if (buffer.length === 0) {
      throw new Error('Cannot decode empty buffer')
    }

    const formatByte = buffer[0]
    const payload = buffer.subarray(1)

    switch (formatByte) {
      case FORMAT_JSON:
        return this.jsonSerializer.decode(payload)

      case FORMAT_MSGPACK:
        return this.msgpackSerializer.decode(payload)

      case FORMAT_MSGPACK_COMPRESSED:
        return this.msgpackSerializer.decodeCompressed(payload)

      default:
        throw new Error(`Unknown format byte: 0x${formatByte.toString(16)}`)
    }
  }

  /**
   * Check if a buffer is a binary format (MessagePack)
   */
  isBinaryFormat(buffer: Buffer): boolean {
    if (buffer.length === 0) return false
    const formatByte = buffer[0]
    return formatByte === FORMAT_MSGPACK || formatByte === FORMAT_MSGPACK_COMPRESSED
  }

  /**
   * Get the format name from a format byte
   */
  getFormatName(buffer: Buffer): 'json' | 'binary' | 'unknown' {
    if (buffer.length === 0) return 'unknown'
    const formatByte = buffer[0]

    if (formatByte === FORMAT_JSON) return 'json'
    if (formatByte === FORMAT_MSGPACK || formatByte === FORMAT_MSGPACK_COMPRESSED) return 'binary'

    return 'unknown'
  }

  /**
   * Encode a message to newline-delimited format for legacy JSON compatibility.
   * Used during the transition period.
   */
  encodeWithNewline(data: unknown, peerId?: string): Buffer {
    const encoded = this.encode(data, peerId)
    const newline = Buffer.from('\n')
    return Buffer.concat([encoded, newline])
  }

  /**
   * Legacy JSON encoding without format prefix (for backward compatibility).
   * Returns a string instead of buffer.
   */
  encodeLegacyJson(data: unknown): string {
    return JSON.stringify(data)
  }

  /**
   * Legacy JSON decoding without format prefix.
   */
  decodeLegacyJson(json: string): unknown {
    return JSON.parse(json)
  }
}
