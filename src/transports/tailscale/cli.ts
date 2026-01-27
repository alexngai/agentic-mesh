// TailscaleCLI - Wrapper for tailscale command-line tool
// Provides methods to query Tailscale status, peers, and network info

import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// =============================================================================
// Types
// =============================================================================

/**
 * Tailscale peer status from `tailscale status --json`.
 */
export interface TailscalePeer {
  /** Tailscale hostname */
  HostName: string
  /** DNS name (e.g., "hostname.tailnet-name.ts.net") */
  DNSName: string
  /** Tailscale IP addresses */
  TailscaleIPs: string[]
  /** Whether the peer is currently online */
  Online: boolean
  /** Operating system */
  OS: string
  /** User ID that owns the device */
  UserID: number
  /** Whether this is the current (self) node */
  Self?: boolean
  /** Tags applied to this peer */
  Tags?: string[]
  /** Last seen timestamp (ISO 8601) */
  LastSeen?: string
  /** Relay server being used (empty if direct) */
  Relay?: string
  /** Connection type: direct, relay, etc. */
  CurAddr?: string
  /** Whether peer is an exit node */
  ExitNode?: boolean
  /** Whether peer is an exit node option */
  ExitNodeOption?: boolean
}

/**
 * Tailscale self status.
 */
export interface TailscaleSelfStatus {
  /** Public key */
  PublicKey: string
  /** Tailscale IPs */
  TailscaleIPs: string[]
  /** DNS name */
  DNSName: string
  /** Hostname */
  HostName: string
  /** Operating system */
  OS: string
  /** User ID */
  UserID: number
  /** Tags */
  Tags?: string[]
  /** Whether acting as exit node */
  ExitNode?: boolean
}

/**
 * Full status output from `tailscale status --json`.
 */
export interface TailscaleStatus {
  /** Backend state: Running, Stopped, NeedsLogin, etc. */
  BackendState: string
  /** Authentication URL if NeedsLogin */
  AuthURL?: string
  /** Self status */
  Self: TailscaleSelfStatus
  /** Peer map (keyed by public key) */
  Peer: Record<string, TailscalePeer>
  /** Current Tailnet name */
  CurrentTailnet?: {
    Name: string
    MagicDNSSuffix: string
  }
  /** Health warnings */
  Health?: string[]
  /** MagicDNS status */
  MagicDNSEnabled?: boolean
}

/**
 * Simplified peer info for mesh use.
 */
export interface TailscalePeerInfo {
  /** Hostname (without DNS suffix) */
  hostname: string
  /** Full DNS name */
  dnsName: string
  /** Tailscale IPv4 address */
  ipv4: string
  /** Tailscale IPv6 address (if available) */
  ipv6?: string
  /** Whether peer is online */
  online: boolean
  /** Tags applied to peer */
  tags: string[]
  /** Last seen timestamp */
  lastSeen?: Date
  /** Whether connection is direct or relayed */
  direct: boolean
}

// =============================================================================
// TailscaleCLI
// =============================================================================

/**
 * Wrapper for the Tailscale CLI.
 * Provides methods to query Tailscale status and peer information.
 */
export class TailscaleCLI {
  private tailscaleBin: string

  constructor(tailscaleBin = 'tailscale') {
    this.tailscaleBin = tailscaleBin
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  /**
   * Get the full Tailscale status.
   */
  async getStatus(): Promise<TailscaleStatus> {
    try {
      const { stdout } = await execAsync(`${this.tailscaleBin} status --json`)
      return JSON.parse(stdout) as TailscaleStatus
    } catch (error) {
      throw new Error(`Failed to get Tailscale status: ${(error as Error).message}`)
    }
  }

  /**
   * Check if Tailscale is running and connected.
   */
  async isConnected(): Promise<boolean> {
    try {
      const status = await this.getStatus()
      return status.BackendState === 'Running'
    } catch {
      return false
    }
  }

  /**
   * Get the current backend state.
   */
  async getBackendState(): Promise<string> {
    const status = await this.getStatus()
    return status.BackendState
  }

  // ===========================================================================
  // Self Info
  // ===========================================================================

  /**
   * Get info about the local node.
   */
  async getSelf(): Promise<TailscaleSelfStatus> {
    const status = await this.getStatus()
    return status.Self
  }

  /**
   * Get the local Tailscale IPv4 address.
   */
  async getLocalIP(): Promise<string> {
    const self = await this.getSelf()
    const ipv4 = self.TailscaleIPs.find((ip) => !ip.includes(':'))
    if (!ipv4) {
      throw new Error('No Tailscale IPv4 address found')
    }
    return ipv4
  }

  /**
   * Get the local hostname.
   */
  async getHostname(): Promise<string> {
    const self = await this.getSelf()
    return self.HostName
  }

  /**
   * Get the local DNS name.
   */
  async getDNSName(): Promise<string> {
    const self = await this.getSelf()
    return self.DNSName
  }

  // ===========================================================================
  // Peer Discovery
  // ===========================================================================

  /**
   * Get all peers in the tailnet.
   */
  async getPeers(): Promise<TailscalePeerInfo[]> {
    const status = await this.getStatus()
    const peers: TailscalePeerInfo[] = []

    for (const peer of Object.values(status.Peer)) {
      // Skip self
      if (peer.Self) continue

      const ipv4 = peer.TailscaleIPs.find((ip) => !ip.includes(':'))
      if (!ipv4) continue

      const ipv6 = peer.TailscaleIPs.find((ip) => ip.includes(':'))

      peers.push({
        hostname: peer.HostName,
        dnsName: peer.DNSName,
        ipv4,
        ipv6,
        online: peer.Online,
        tags: peer.Tags ?? [],
        lastSeen: peer.LastSeen ? new Date(peer.LastSeen) : undefined,
        direct: !peer.Relay || peer.Relay === '',
      })
    }

    return peers
  }

  /**
   * Get online peers only.
   */
  async getOnlinePeers(): Promise<TailscalePeerInfo[]> {
    const peers = await this.getPeers()
    return peers.filter((p) => p.online)
  }

  /**
   * Get peers with a specific tag.
   */
  async getPeersByTag(tag: string): Promise<TailscalePeerInfo[]> {
    const peers = await this.getPeers()
    // Tailscale tags are prefixed with "tag:"
    const normalizedTag = tag.startsWith('tag:') ? tag : `tag:${tag}`
    return peers.filter((p) => p.tags.includes(normalizedTag))
  }

  /**
   * Get a peer by hostname.
   */
  async getPeerByHostname(hostname: string): Promise<TailscalePeerInfo | null> {
    const peers = await this.getPeers()
    return peers.find((p) => p.hostname === hostname || p.dnsName.startsWith(hostname)) ?? null
  }

  /**
   * Get a peer by IP address.
   */
  async getPeerByIP(ip: string): Promise<TailscalePeerInfo | null> {
    const peers = await this.getPeers()
    return peers.find((p) => p.ipv4 === ip || p.ipv6 === ip) ?? null
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Bring Tailscale up (connect to the network).
   * This is idempotent - if already up, does nothing.
   */
  async up(options?: { authKey?: string; hostname?: string; acceptRoutes?: boolean }): Promise<void> {
    const args = ['up', '--reset']

    if (options?.authKey) {
      args.push('--authkey', options.authKey)
    }
    if (options?.hostname) {
      args.push('--hostname', options.hostname)
    }
    if (options?.acceptRoutes) {
      args.push('--accept-routes')
    }

    try {
      await execAsync(`${this.tailscaleBin} ${args.join(' ')}`)
    } catch (error) {
      throw new Error(`Failed to bring Tailscale up: ${(error as Error).message}`)
    }
  }

  /**
   * Bring Tailscale down (disconnect from the network).
   */
  async down(): Promise<void> {
    try {
      await execAsync(`${this.tailscaleBin} down`)
    } catch (error) {
      throw new Error(`Failed to bring Tailscale down: ${(error as Error).message}`)
    }
  }

  /**
   * Ping a peer (useful for connection testing).
   * @param target Hostname, DNS name, or IP to ping
   * @param timeout Timeout in seconds
   * @returns Latency in milliseconds, or null if failed
   */
  async ping(target: string, timeout = 5): Promise<number | null> {
    return new Promise((resolve) => {
      const proc = spawn(this.tailscaleBin, ['ping', '--c', '1', '--timeout', `${timeout}s`, target])

      let output = ''
      proc.stdout.on('data', (data) => {
        output += data.toString()
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(null)
          return
        }

        // Parse "pong from hostname (ip) via DERP(region) in 123ms" or similar
        const match = output.match(/in (\d+(?:\.\d+)?)ms/)
        if (match) {
          resolve(parseFloat(match[1]))
        } else {
          resolve(null)
        }
      })

      proc.on('error', () => {
        resolve(null)
      })
    })
  }

  // ===========================================================================
  // Tailnet Info
  // ===========================================================================

  /**
   * Get the current tailnet name.
   */
  async getTailnetName(): Promise<string | null> {
    const status = await this.getStatus()
    return status.CurrentTailnet?.Name ?? null
  }

  /**
   * Get the MagicDNS suffix.
   */
  async getMagicDNSSuffix(): Promise<string | null> {
    const status = await this.getStatus()
    return status.CurrentTailnet?.MagicDNSSuffix ?? null
  }

  /**
   * Check if MagicDNS is enabled.
   */
  async isMagicDNSEnabled(): Promise<boolean> {
    const status = await this.getStatus()
    return status.MagicDNSEnabled ?? false
  }

  // ===========================================================================
  // Version Info
  // ===========================================================================

  /**
   * Get the Tailscale version.
   */
  async getVersion(): Promise<string> {
    try {
      const { stdout } = await execAsync(`${this.tailscaleBin} version`)
      return stdout.trim().split('\n')[0]
    } catch (error) {
      throw new Error(`Failed to get Tailscale version: ${(error as Error).message}`)
    }
  }
}
