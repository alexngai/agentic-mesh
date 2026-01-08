export { NebulaMesh } from './nebula-mesh'
export { ExecutionRouter } from './execution-router'
export type {
  ExecutionRequest,
  ExecutionResponse,
  ExecutionRequestEvent,
  ExecutionRouterConfig,
} from './execution-router'

// Execution Streaming (Phase 7.1)
export {
  ExecutionStream,
  StreamBuffer,
} from './execution-stream'
export type {
  ExecutionStreamMessage,
  StreamingExecutionOptions,
  StreamingExecutionHandler,
  StreamingExecutionRequestEvent,
} from './execution-stream'

// Nebula Auto-Discovery (Phase 7.2)
export {
  parseNebulaConfig,
  parseNebulaSetup,
  parseCertificate,
  validateNebulaSetup,
  parseYaml,
} from './nebula-config-parser'
export type {
  ParsedNebulaConfig,
  ParsedCertInfo,
  NebulaSetup,
} from './nebula-config-parser'

export { PeerDiscovery, discoveryPeerToPeerConfig, peerInfoToDiscoveryPeer } from './peer-discovery'
export type {
  DiscoveryRequest,
  DiscoveryResponse,
  DiscoveryRegister,
  DiscoveryUnregister,
  DiscoveryMessage,
  DiscoveryPeerInfo,
  PeerDiscoveryConfig,
  PeerDiscoveryEventType,
} from './peer-discovery'
