export { MessageChannel, RPCTimeoutError, RPCError } from './message-channel'
export { OfflineQueue } from './offline-queue'
export type { QueuedOperation, OfflineQueueConfig } from './offline-queue'

// Serializers (Phase 6.2)
export {
  JsonSerializer,
  MsgpackSerializer,
  SerializerManager,
  FORMAT_JSON,
  FORMAT_MSGPACK,
  FORMAT_MSGPACK_COMPRESSED,
} from './serializers'
export type {
  Serializer,
  SerializationFormat,
  SerializerCapabilities,
  NegotiatedFormat,
} from './serializers'
