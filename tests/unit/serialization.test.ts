import { describe, it, expect, beforeEach } from 'vitest'
import {
  JsonSerializer,
  MsgpackSerializer,
  SerializerManager,
  FORMAT_JSON,
  FORMAT_MSGPACK,
  FORMAT_MSGPACK_COMPRESSED,
} from '../../src/channel/serializers'

describe('JsonSerializer', () => {
  let serializer: JsonSerializer

  beforeEach(() => {
    serializer = new JsonSerializer()
  })

  describe('encode', () => {
    it('should encode data with JSON format prefix', () => {
      const data = { type: 'test', value: 42 }
      const encoded = serializer.encode(data)

      expect(encoded[0]).toBe(FORMAT_JSON)
      expect(encoded.length).toBeGreaterThan(1)
    })

    it('should encode strings correctly', () => {
      const data = 'hello world'
      const encoded = serializer.encode(data)

      expect(encoded[0]).toBe(FORMAT_JSON)
      const payload = encoded.subarray(1).toString('utf-8')
      expect(JSON.parse(payload)).toBe('hello world')
    })

    it('should encode arrays correctly', () => {
      const data = [1, 2, 3]
      const encoded = serializer.encode(data)

      expect(encoded[0]).toBe(FORMAT_JSON)
      const payload = encoded.subarray(1).toString('utf-8')
      expect(JSON.parse(payload)).toEqual([1, 2, 3])
    })

    it('should encode nested objects correctly', () => {
      const data = { nested: { deep: { value: 'test' } } }
      const encoded = serializer.encode(data)

      expect(encoded[0]).toBe(FORMAT_JSON)
      const payload = encoded.subarray(1).toString('utf-8')
      expect(JSON.parse(payload)).toEqual(data)
    })
  })

  describe('decode', () => {
    it('should decode JSON buffer (without format prefix)', () => {
      const data = { type: 'test', value: 42 }
      const buffer = Buffer.from(JSON.stringify(data), 'utf-8')
      const decoded = serializer.decode(buffer)

      expect(decoded).toEqual(data)
    })

    it('should decode strings', () => {
      const buffer = Buffer.from('"hello"', 'utf-8')
      expect(serializer.decode(buffer)).toBe('hello')
    })

    it('should decode numbers', () => {
      const buffer = Buffer.from('123', 'utf-8')
      expect(serializer.decode(buffer)).toBe(123)
    })
  })

  describe('canDecode', () => {
    it('should return true for JSON format byte', () => {
      expect(serializer.canDecode(FORMAT_JSON)).toBe(true)
    })

    it('should return false for MessagePack format byte', () => {
      expect(serializer.canDecode(FORMAT_MSGPACK)).toBe(false)
    })
  })
})

describe('MsgpackSerializer', () => {
  let serializer: MsgpackSerializer

  beforeEach(() => {
    serializer = new MsgpackSerializer()
  })

  describe('encode', () => {
    it('should encode data with MessagePack format prefix', () => {
      const data = { type: 'test', value: 42 }
      const encoded = serializer.encode(data)

      expect([FORMAT_MSGPACK, FORMAT_MSGPACK_COMPRESSED]).toContain(encoded[0])
      expect(encoded.length).toBeGreaterThan(1)
    })

    it('should produce smaller output than JSON for typical messages', () => {
      const data = {
        id: 'test-message-id-12345',
        channel: 'sync:namespace:test',
        type: 'update',
        payload: { entities: ['entity1', 'entity2', 'entity3'] },
        timestamp: Date.now(),
      }

      const msgpackSize = serializer.encode(data).length
      const jsonSize = Buffer.from(JSON.stringify(data)).length

      // MessagePack should generally be smaller
      expect(msgpackSize).toBeLessThanOrEqual(jsonSize)
    })

    it('should handle complex nested structures', () => {
      const data = {
        specs: [{ id: 's-1', title: 'Spec 1' }],
        issues: [{ id: 'i-1', title: 'Issue 1', status: 'open' }],
        nested: { a: { b: { c: { d: 'deep' } } } },
      }
      const encoded = serializer.encode(data)

      expect(encoded.length).toBeGreaterThan(1)
      expect([FORMAT_MSGPACK, FORMAT_MSGPACK_COMPRESSED]).toContain(encoded[0])
    })
  })

  describe('decode', () => {
    it('should decode MessagePack buffer', () => {
      const data = { type: 'test', value: 42 }
      const encoded = serializer.encode(data)

      // Get payload without format prefix
      const payload = encoded.subarray(1)
      const formatByte = encoded[0]

      let decoded: unknown
      if (formatByte === FORMAT_MSGPACK_COMPRESSED) {
        decoded = serializer.decodeCompressed(payload)
      } else {
        decoded = serializer.decode(payload)
      }

      expect(decoded).toEqual(data)
    })

    it('should handle round-trip encoding/decoding', () => {
      const data = {
        string: 'hello',
        number: 123,
        boolean: true,
        array: [1, 2, 3],
        object: { key: 'value' },
        null: null,
      }

      const encoded = serializer.encode(data)
      const payload = encoded.subarray(1)
      const formatByte = encoded[0]

      let decoded: unknown
      if (formatByte === FORMAT_MSGPACK_COMPRESSED) {
        decoded = serializer.decodeCompressed(payload)
      } else {
        decoded = serializer.decode(payload)
      }

      expect(decoded).toEqual(data)
    })
  })

  describe('compression', () => {
    it('should compress large messages', () => {
      // Create a large, repetitive message (compresses well)
      const largeData = {
        entries: Array.from({ length: 100 }, (_, i) => ({
          id: `item-${i}`,
          type: 'test-entry',
          data: 'repeated-content-that-compresses-well',
        })),
      }

      const encoded = serializer.encode(largeData)
      const formatByte = encoded[0]

      // Should use compression for large payloads
      expect(formatByte).toBe(FORMAT_MSGPACK_COMPRESSED)
    })

    it('should not compress small messages', () => {
      const smallData = { type: 'ping' }
      const encoded = serializer.encode(smallData)

      // Small messages shouldn't be compressed
      expect(encoded[0]).toBe(FORMAT_MSGPACK)
    })

    it('should compress and decompress correctly', () => {
      const largeData = {
        entries: Array.from({ length: 100 }, (_, i) => ({
          id: `item-${i}`,
          type: 'test-entry',
          data: 'repeated-content',
        })),
      }

      const encoded = serializer.encode(largeData)
      const payload = encoded.subarray(1)

      // Should be compressed
      expect(encoded[0]).toBe(FORMAT_MSGPACK_COMPRESSED)

      // Decompress and verify
      const decoded = serializer.decodeCompressed(payload)
      expect(decoded).toEqual(largeData)
    })
  })

  describe('canDecode', () => {
    it('should return true for MessagePack format byte', () => {
      expect(serializer.canDecode(FORMAT_MSGPACK)).toBe(true)
    })

    it('should return true for compressed MessagePack format byte', () => {
      expect(serializer.canDecode(FORMAT_MSGPACK_COMPRESSED)).toBe(true)
    })

    it('should return false for JSON format byte', () => {
      expect(serializer.canDecode(FORMAT_JSON)).toBe(false)
    })
  })
})

describe('SerializerManager', () => {
  describe('capabilities', () => {
    it('should return correct capabilities for auto mode', () => {
      const manager = new SerializerManager({ format: 'auto' })
      const caps = manager.getCapabilities()

      expect(caps.supportedFormats).toContain('binary')
      expect(caps.supportedFormats).toContain('json')
      expect(caps.compressionSupported).toBe(true)
    })

    it('should return json-only capabilities when format is json', () => {
      const manager = new SerializerManager({ format: 'json' })
      const caps = manager.getCapabilities()

      expect(caps.supportedFormats).toContain('json')
      expect(caps.supportedFormats).not.toContain('binary')
    })

    it('should return binary+json capabilities when format is binary', () => {
      const manager = new SerializerManager({ format: 'binary' })
      const caps = manager.getCapabilities()

      expect(caps.supportedFormats).toContain('binary')
      expect(caps.supportedFormats).toContain('json')
      // Binary is preferred, should be first
      expect(caps.supportedFormats[0]).toBe('binary')
    })
  })

  describe('format negotiation', () => {
    it('should negotiate binary when both support it', () => {
      const manager = new SerializerManager({ format: 'auto' })

      const result = manager.negotiateFormat('peer-1', {
        supportedFormats: ['binary', 'json'],
        compressionSupported: true,
      })

      expect(result.format).toBe('binary')
      expect(result.compress).toBe(true)
    })

    it('should fallback to json when remote only supports json', () => {
      const manager = new SerializerManager({ format: 'auto' })

      const result = manager.negotiateFormat('peer-1', {
        supportedFormats: ['json'],
        compressionSupported: false,
      })

      expect(result.format).toBe('json')
      expect(result.compress).toBe(false)
    })

    it('should disable compression if remote does not support it', () => {
      const manager = new SerializerManager({ format: 'auto' })

      const result = manager.negotiateFormat('peer-1', {
        supportedFormats: ['binary', 'json'],
        compressionSupported: false,
      })

      expect(result.format).toBe('binary')
      expect(result.compress).toBe(false)
    })

    it('should store negotiated format per peer', () => {
      const manager = new SerializerManager({ format: 'auto' })

      manager.negotiateFormat('peer-1', {
        supportedFormats: ['binary', 'json'],
        compressionSupported: true,
      })

      manager.negotiateFormat('peer-2', {
        supportedFormats: ['json'],
        compressionSupported: false,
      })

      const peer1Format = manager.getFormatForPeer('peer-1')
      const peer2Format = manager.getFormatForPeer('peer-2')

      expect(peer1Format.format).toBe('binary')
      expect(peer2Format.format).toBe('json')
    })

    it('should remove peer format on disconnect', () => {
      const manager = new SerializerManager({ format: 'auto' })

      manager.negotiateFormat('peer-1', {
        supportedFormats: ['binary'],
        compressionSupported: true,
      })

      expect(manager.getFormatForPeer('peer-1').format).toBe('binary')

      manager.removePeer('peer-1')

      // Should fall back to default (auto prefers binary)
      const defaultFormat = manager.getFormatForPeer('peer-1')
      expect(defaultFormat).toBeDefined()
    })
  })

  describe('encode/decode', () => {
    it('should encode with JSON for json-only peer', () => {
      const manager = new SerializerManager({ format: 'auto' })
      manager.negotiateFormat('peer-json', {
        supportedFormats: ['json'],
        compressionSupported: false,
      })

      const data = { test: 'value' }
      const encoded = manager.encode(data, 'peer-json')

      expect(encoded[0]).toBe(FORMAT_JSON)
    })

    it('should encode with MessagePack for binary peer', () => {
      const manager = new SerializerManager({ format: 'auto' })
      manager.negotiateFormat('peer-binary', {
        supportedFormats: ['binary', 'json'],
        compressionSupported: true,
      })

      const data = { test: 'value' }
      const encoded = manager.encode(data, 'peer-binary')

      expect([FORMAT_MSGPACK, FORMAT_MSGPACK_COMPRESSED]).toContain(encoded[0])
    })

    it('should decode JSON format', () => {
      const manager = new SerializerManager()
      const jsonSerializer = new JsonSerializer()

      const data = { test: 'value' }
      const encoded = jsonSerializer.encode(data)
      const decoded = manager.decode(encoded)

      expect(decoded).toEqual(data)
    })

    it('should decode MessagePack format', () => {
      const manager = new SerializerManager()
      const msgpackSerializer = new MsgpackSerializer({ compression: false })

      const data = { test: 'value' }
      const encoded = msgpackSerializer.encode(data)
      const decoded = manager.decode(encoded)

      expect(decoded).toEqual(data)
    })

    it('should decode compressed MessagePack format', () => {
      const manager = new SerializerManager()
      const msgpackSerializer = new MsgpackSerializer({ compression: true })

      // Large data that will be compressed
      const data = {
        entries: Array.from({ length: 100 }, (_, i) => ({
          id: `item-${i}`,
          data: 'repetitive-content',
        })),
      }
      const encoded = msgpackSerializer.encode(data)

      expect(encoded[0]).toBe(FORMAT_MSGPACK_COMPRESSED)

      const decoded = manager.decode(encoded)
      expect(decoded).toEqual(data)
    })

    it('should throw on unknown format byte', () => {
      const manager = new SerializerManager()
      const buffer = Buffer.from([0xff, 0x01, 0x02]) // Unknown format

      expect(() => manager.decode(buffer)).toThrow('Unknown format byte')
    })

    it('should throw on empty buffer', () => {
      const manager = new SerializerManager()
      const buffer = Buffer.alloc(0)

      expect(() => manager.decode(buffer)).toThrow('Cannot decode empty buffer')
    })
  })

  describe('format detection', () => {
    it('should detect binary format', () => {
      const manager = new SerializerManager()
      const msgpackSerializer = new MsgpackSerializer()

      const encoded = msgpackSerializer.encode({ test: 'value' })

      expect(manager.isBinaryFormat(encoded)).toBe(true)
      expect(manager.getFormatName(encoded)).toBe('binary')
    })

    it('should detect JSON format', () => {
      const manager = new SerializerManager()
      const jsonSerializer = new JsonSerializer()

      const encoded = jsonSerializer.encode({ test: 'value' })

      expect(manager.isBinaryFormat(encoded)).toBe(false)
      expect(manager.getFormatName(encoded)).toBe('json')
    })

    it('should handle empty buffer', () => {
      const manager = new SerializerManager()
      const buffer = Buffer.alloc(0)

      expect(manager.isBinaryFormat(buffer)).toBe(false)
      expect(manager.getFormatName(buffer)).toBe('unknown')
    })
  })

  describe('size comparison', () => {
    it('should demonstrate size savings for typical Y.js sync messages', () => {
      const manager = new SerializerManager({ format: 'auto' })

      // Simulate a Y.js sync message structure
      const yjsMessage = {
        id: crypto.randomUUID(),
        channel: 'sync:sudocode:test-project',
        type: 'update',
        payload: {
          type: 'sync-step-2',
          diff: Buffer.alloc(512).toString('base64'), // Simulated Y.js diff
          stateVector: Buffer.alloc(64).toString('base64'),
        },
        from: 'peer-test-12345',
        to: 'peer-remote-67890',
        timestamp: Date.now(),
      }

      const jsonSize = Buffer.from(JSON.stringify(yjsMessage)).length
      const msgpackEncoded = manager.encode(yjsMessage, undefined)
      const binarySize = msgpackEncoded.length

      console.log(`JSON size: ${jsonSize} bytes, Binary size: ${binarySize} bytes`)
      console.log(`Size reduction: ${((1 - binarySize / jsonSize) * 100).toFixed(1)}%`)

      // Binary should generally be smaller or comparable
      expect(binarySize).toBeLessThanOrEqual(jsonSize * 1.1) // Allow 10% overhead
    })
  })
})
