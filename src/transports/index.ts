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
  TailscaleHealthMonitor,
  type TailscaleHealthMonitorConfig,
  type TailscalePeer,
  type TailscaleSelfStatus,
  type TailscaleStatus,
  type TailscalePeerInfo,
} from './tailscale'
export {
  HeadscaleTransport,
  HeadscaleCLI,
  type HeadscaleConfig,
  type HeadscaleNode,
  type HeadscaleUser,
  type HeadscalePreAuthKey,
} from './headscale'
