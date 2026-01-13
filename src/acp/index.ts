// ACP integration module exports
// Implements: s-4hjr

export { AcpMeshAdapter } from './adapter'
export type { RespondFn, SessionUpdateCallback } from './adapter'
export type {
  AcpMessage,
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpError,
  AcpMeshEnvelope,
  AcpMeshAdapterConfig,
  BroadcastTarget,
  // Session observation types (Phase 3)
  SessionInfo,
  SessionObserveRequest,
  SessionObserveResponse,
  SessionUnobserveRequest,
  SessionListRequest,
  SessionListResponse,
  SessionEndedNotification,
} from './types'
export {
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  // Session observation type guards (Phase 3)
  isSessionObserveRequest,
  isSessionUnobserveRequest,
  isSessionListRequest,
  isSessionEndedNotification,
} from './types'

// Mesh stream for ACP SDK integration
export { meshStream, createConnectedStreams } from './mesh-stream'
export type { MeshStreamConfig, AcpMeshEnvelope as AcpSdkMeshEnvelope } from './mesh-stream'

// Re-export useful types from ACP SDK
export type { Stream as AcpStream, AnyMessage as AcpAnyMessage } from '@agentclientprotocol/sdk'
