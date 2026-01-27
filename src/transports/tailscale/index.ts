// Tailscale transport module exports

export { TailscaleTransport } from './transport'
export {
  TailscaleCLI,
  type TailscalePeer,
  type TailscaleSelfStatus,
  type TailscaleStatus,
  type TailscalePeerInfo,
} from './cli'

// Health monitor (Phase 5: Pluggable Health Monitoring)
export { TailscaleHealthMonitor, type TailscaleHealthMonitorConfig } from './health-monitor'
