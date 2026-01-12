// ACP integration module exports
// Implements: s-4hjr

export { AcpMeshAdapter } from './adapter'
export type { RespondFn } from './adapter'
export type {
  AcpMessage,
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpError,
  AcpMeshEnvelope,
  AcpMeshAdapterConfig,
  BroadcastTarget,
} from './types'
export { isAcpRequest, isAcpResponse, isAcpNotification } from './types'

// Mesh stream for ACP SDK integration
export { meshStream, createConnectedStreams } from './mesh-stream'
export type { MeshStreamConfig, AcpMeshEnvelope as AcpSdkMeshEnvelope } from './mesh-stream'

// Re-export useful types from ACP SDK
export type { Stream as AcpStream, AnyMessage as AcpAnyMessage } from '@agentclientprotocol/sdk'
