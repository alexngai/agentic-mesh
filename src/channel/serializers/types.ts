// Serializer types for binary protocol support
// Implements: i-8shy

/**
 * Format byte prefixes for wire protocol
 */
export const FORMAT_JSON = 0x00
export const FORMAT_MSGPACK = 0x01
export const FORMAT_MSGPACK_COMPRESSED = 0x02

/**
 * Serialization format options
 */
export type SerializationFormat = 'json' | 'binary' | 'auto'

/**
 * Serializer interface for encoding/decoding messages
 */
export interface Serializer {
  /**
   * The format identifier for this serializer
   */
  readonly format: 'json' | 'binary'

  /**
   * Encode data to a buffer with format prefix byte
   */
  encode(data: unknown): Buffer

  /**
   * Decode data from a buffer (without format prefix)
   */
  decode(buffer: Buffer): unknown

  /**
   * Check if this serializer can decode a buffer based on format prefix
   */
  canDecode(formatByte: number): boolean
}

/**
 * Serializer capabilities advertised during handshake
 */
export interface SerializerCapabilities {
  /**
   * Supported formats in order of preference (most preferred first)
   */
  supportedFormats: ('json' | 'binary')[]

  /**
   * Whether compression is supported
   */
  compressionSupported: boolean
}

/**
 * Negotiated serialization settings between two peers
 */
export interface NegotiatedFormat {
  /**
   * The format to use for this peer
   */
  format: 'json' | 'binary'

  /**
   * Whether to compress large messages
   */
  compress: boolean
}
