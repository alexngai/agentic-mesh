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

// Transport implementations
export { NebulaTransport } from './nebula'
export {
  TailscaleTransport,
  TailscaleCLI,
  type TailscalePeer,
  type TailscaleSelfStatus,
  type TailscaleStatus,
  type TailscalePeerInfo,
} from './tailscale'
