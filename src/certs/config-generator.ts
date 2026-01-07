// Nebula Configuration Generator
// Implements: i-2drt

import * as fs from 'fs'
import * as path from 'path'

// =============================================================================
// Types
// =============================================================================

export interface NebulaConfigOptions {
  /** Path to CA certificate */
  caCertPath: string
  /** Path to host certificate */
  certPath: string
  /** Path to host private key */
  keyPath: string
  /** Lighthouse hosts - map of Nebula IP to public IP:port */
  lighthouses: Record<string, string>
  /** This host's Nebula IP (for lighthouse self-identification) */
  nebulaIp?: string
  /** Listen host for UDP. Default: "0.0.0.0" */
  listenHost?: string
  /** Listen port for UDP. Default: 4242 */
  listenPort?: number
  /** TUN device name. Default: "nebula1" */
  tunDevice?: string
  /** Enable TUN device. Default: true */
  tunEnabled?: boolean
  /** MTU for TUN device. Default: 1300 */
  mtu?: number
  /** Cipher to use. Default: "aes" */
  cipher?: 'aes' | 'chachapoly'
  /** Firewall rules */
  firewall?: FirewallConfig
  /** Logging config */
  logging?: LoggingConfig
  /** Additional raw YAML to merge */
  extraConfig?: Record<string, unknown>
}

export interface LighthouseConfigOptions extends NebulaConfigOptions {
  /** Serve DNS. Default: false */
  dns?: DnsConfig
  /** Answer Lighthouse queries. Default: true */
  amLighthouse?: boolean
}

export interface FirewallConfig {
  /** Connection tracking timeout. Default: "10m" */
  conntrackTimeout?: string
  /** Inbound rules */
  inbound?: FirewallRule[]
  /** Outbound rules */
  outbound?: FirewallRule[]
}

export interface FirewallRule {
  /** Protocol: any, tcp, udp, icmp */
  proto: 'any' | 'tcp' | 'udp' | 'icmp'
  /** Port or port range (e.g., "22", "8000-9000", "any") */
  port: string
  /** Source/dest host: any, group:name, cidr, or specific Nebula IP */
  host: string
  /** Groups required (optional) */
  groups?: string[]
}

export interface DnsConfig {
  /** Enable DNS server */
  enabled: boolean
  /** DNS listen host. Default: "0.0.0.0" */
  host?: string
  /** DNS listen port. Default: 53 */
  port?: number
}

export interface LoggingConfig {
  /** Log level: debug, info, warn, error */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Log format: text, json */
  format?: 'text' | 'json'
}

// =============================================================================
// Default Firewall Rules
// =============================================================================

const DEFAULT_INBOUND_RULES: FirewallRule[] = [
  // Allow ICMP for diagnostics
  { proto: 'icmp', port: 'any', host: 'any' },
  // Allow SSH from any Nebula peer
  { proto: 'tcp', port: '22', host: 'any' },
]

const DEFAULT_OUTBOUND_RULES: FirewallRule[] = [
  // Allow all outbound traffic
  { proto: 'any', port: 'any', host: 'any' },
]

const MESH_INBOUND_RULES: FirewallRule[] = [
  // Allow ICMP for diagnostics
  { proto: 'icmp', port: 'any', host: 'any' },
  // Allow agentic-mesh traffic (default port 7946)
  { proto: 'tcp', port: '7946', host: 'any' },
  // Allow SSH
  { proto: 'tcp', port: '22', host: 'any' },
]

// =============================================================================
// Internal Config Structure
// =============================================================================

interface NebulaConfigInternal {
  pki: {
    ca: string
    cert: string
    key: string
  }
  static_host_map: Record<string, string[]>
  lighthouse: {
    am_lighthouse: boolean
    interval: number
    hosts?: string[]
    dns?: {
      host: string
      port: number
    }
  }
  listen: {
    host: string
    port: number
  }
  punchy: {
    punch: boolean
    respond: boolean
  }
  tun: {
    disabled: boolean
    dev: string
    drop_local_broadcast: boolean
    drop_multicast: boolean
    tx_queue: number
    mtu: number
  }
  logging: {
    level: string
    format: string
  }
  firewall: Record<string, unknown>
  cipher: string
  [key: string]: unknown
}

// =============================================================================
// Config Generator
// =============================================================================

export class ConfigGenerator {
  /**
   * Generate a peer Nebula configuration.
   */
  generateNebulaConfig(options: NebulaConfigOptions): string {
    const config = this.buildBaseConfig(options)
    return this.toYaml(config as Record<string, unknown>)
  }

  /**
   * Generate a lighthouse Nebula configuration.
   */
  generateLighthouseConfig(options: LighthouseConfigOptions): string {
    const config = this.buildBaseConfig(options)

    // Lighthouse-specific settings
    config.lighthouse = {
      am_lighthouse: options.amLighthouse ?? true,
      interval: 60,
    }

    // Remove static_host_map entry for self if this is a lighthouse
    if (options.nebulaIp) {
      const selfIp = options.nebulaIp.split('/')[0]
      if (config.static_host_map[selfIp]) {
        delete config.static_host_map[selfIp]
      }
      // Lighthouses don't query themselves
      config.lighthouse.hosts = Object.keys(options.lighthouses).filter(
        (ip) => ip !== selfIp
      )
    }

    // DNS configuration
    if (options.dns?.enabled) {
      config.lighthouse.dns = {
        host: options.dns.host ?? '0.0.0.0',
        port: options.dns.port ?? 53,
      }
    }

    return this.toYaml(config as Record<string, unknown>)
  }

  /**
   * Generate a minimal peer config for agentic-mesh usage.
   * Includes firewall rules for mesh communication.
   */
  generateMeshPeerConfig(options: NebulaConfigOptions): string {
    const meshOptions: NebulaConfigOptions = {
      ...options,
      firewall: {
        conntrackTimeout: options.firewall?.conntrackTimeout ?? '10m',
        inbound: options.firewall?.inbound ?? MESH_INBOUND_RULES,
        outbound: options.firewall?.outbound ?? DEFAULT_OUTBOUND_RULES,
      },
    }
    return this.generateNebulaConfig(meshOptions)
  }

  /**
   * Write config to file.
   */
  async writeConfig(configPath: string, config: string): Promise<void> {
    const dir = path.dirname(configPath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(configPath, config, 'utf-8')
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private buildBaseConfig(
    options: NebulaConfigOptions
  ): NebulaConfigInternal {
    const config: NebulaConfigInternal = {
      // PKI configuration
      pki: {
        ca: options.caCertPath,
        cert: options.certPath,
        key: options.keyPath,
      },

      // Static host map for lighthouses
      static_host_map: this.buildStaticHostMap(options.lighthouses),

      // Lighthouse configuration (for peers)
      lighthouse: {
        am_lighthouse: false,
        interval: 60,
        hosts: Object.keys(options.lighthouses),
      },

      // Listen configuration
      listen: {
        host: options.listenHost ?? '0.0.0.0',
        port: options.listenPort ?? 4242,
      },

      // Punchy configuration for NAT traversal
      punchy: {
        punch: true,
        respond: true,
      },

      // TUN device configuration
      tun: {
        disabled: !(options.tunEnabled ?? true),
        dev: options.tunDevice ?? 'nebula1',
        drop_local_broadcast: false,
        drop_multicast: false,
        tx_queue: 500,
        mtu: options.mtu ?? 1300,
      },

      // Logging
      logging: {
        level: options.logging?.level ?? 'info',
        format: options.logging?.format ?? 'text',
      },

      // Firewall
      firewall: this.buildFirewallConfig(options.firewall),

      // Cipher
      cipher: options.cipher ?? 'aes',
    }

    // Merge extra config if provided
    if (options.extraConfig) {
      this.deepMerge(config as Record<string, unknown>, options.extraConfig)
    }

    return config
  }

  private buildStaticHostMap(
    lighthouses: Record<string, string>
  ): Record<string, string[]> {
    const map: Record<string, string[]> = {}
    for (const [nebulaIp, publicEndpoint] of Object.entries(lighthouses)) {
      map[nebulaIp] = [publicEndpoint]
    }
    return map
  }

  private buildFirewallConfig(
    config?: FirewallConfig
  ): Record<string, unknown> {
    const inbound = config?.inbound ?? DEFAULT_INBOUND_RULES
    const outbound = config?.outbound ?? DEFAULT_OUTBOUND_RULES

    return {
      conntrack: {
        tcp_timeout: config?.conntrackTimeout ?? '10m',
        udp_timeout: '3m',
        default_timeout: '10m',
      },
      outbound: outbound.map((rule) => this.formatFirewallRule(rule)),
      inbound: inbound.map((rule) => this.formatFirewallRule(rule)),
    }
  }

  private formatFirewallRule(
    rule: FirewallRule
  ): Record<string, unknown> {
    const formatted: Record<string, unknown> = {
      port: rule.port,
      proto: rule.proto,
    }

    // Handle host specification
    if (rule.host === 'any') {
      formatted.host = 'any'
    } else if (rule.host.startsWith('group:')) {
      formatted.group = rule.host.substring(6)
    } else if (rule.host.includes('/')) {
      formatted.cidr = rule.host
    } else {
      formatted.host = rule.host
    }

    // Add groups if specified
    if (rule.groups && rule.groups.length > 0) {
      formatted.groups = rule.groups
    }

    return formatted
  }

  private toYaml(obj: Record<string, unknown>, indent = 0): string {
    const lines: string[] = []
    const prefix = '  '.repeat(indent)

    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) {
        continue
      }

      if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${prefix}${key}: []`)
        } else if (typeof value[0] === 'object') {
          lines.push(`${prefix}${key}:`)
          for (const item of value) {
            const itemYaml = this.toYaml(
              item as Record<string, unknown>,
              indent + 1
            )
            const itemLines = itemYaml.split('\n').filter((l) => l.trim())
            if (itemLines.length > 0) {
              lines.push(`${prefix}  - ${itemLines[0].trim()}`)
              for (let i = 1; i < itemLines.length; i++) {
                lines.push(`${prefix}    ${itemLines[i].trim()}`)
              }
            }
          }
        } else {
          lines.push(`${prefix}${key}:`)
          for (const item of value) {
            lines.push(`${prefix}  - ${this.formatValue(item)}`)
          }
        }
      } else if (typeof value === 'object') {
        lines.push(`${prefix}${key}:`)
        lines.push(this.toYaml(value as Record<string, unknown>, indent + 1))
      } else {
        lines.push(`${prefix}${key}: ${this.formatValue(value)}`)
      }
    }

    return lines.join('\n')
  }

  private formatValue(value: unknown): string {
    if (typeof value === 'string') {
      // Quote strings that might be interpreted as other types
      if (
        value === 'true' ||
        value === 'false' ||
        value === 'null' ||
        /^[\d.]+$/.test(value) ||
        value.includes(':') ||
        value.includes('#') ||
        value.includes('"') ||
        value.includes("'")
      ) {
        return `"${value.replace(/"/g, '\\"')}"`
      }
      return value
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false'
    }
    if (typeof value === 'number') {
      return String(value)
    }
    return String(value)
  }

  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): void {
    for (const [key, value] of Object.entries(source)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        this.deepMerge(
          target[key] as Record<string, unknown>,
          value as Record<string, unknown>
        )
      } else {
        target[key] = value
      }
    }
  }
}

// Export singleton for convenience
export const configGenerator = new ConfigGenerator()
