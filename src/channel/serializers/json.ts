// JSON Serializer
// Implements: i-8shy

import type { Serializer } from './types'
import { FORMAT_JSON } from './types'

/**
 * JSON serializer for wire protocol.
 * Uses UTF-8 encoded JSON with format prefix byte.
 */
export class JsonSerializer implements Serializer {
  readonly format = 'json' as const

  /**
   * Encode data to a buffer with JSON format prefix
   */
  encode(data: unknown): Buffer {
    const json = JSON.stringify(data)
    const jsonBuffer = Buffer.from(json, 'utf-8')

    // Prepend format byte
    const result = Buffer.allocUnsafe(1 + jsonBuffer.length)
    result[0] = FORMAT_JSON
    jsonBuffer.copy(result, 1)

    return result
  }

  /**
   * Decode JSON data from buffer (without format prefix)
   */
  decode(buffer: Buffer): unknown {
    const json = buffer.toString('utf-8')
    return JSON.parse(json)
  }

  /**
   * Check if this is a JSON formatted message
   */
  canDecode(formatByte: number): boolean {
    return formatByte === FORMAT_JSON
  }
}
