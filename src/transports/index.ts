// Transport module exports

export type {
  // Core types
  PeerEndpoint,
  PeerConnection,
  TransportEvents,
  TransportAdapter,

  // Configuration types
  BaseTransportConfig,
  NebulaTransportConfig,
  TailscaleTransportConfig,
  HeadscaleTransportConfig,
  TcpTransportConfig,
  TransportConfig,

  // Factory
  TransportFactory,
} from './types'

// Re-export Nebula transport (when implemented)
// export { NebulaTransport } from './nebula'
