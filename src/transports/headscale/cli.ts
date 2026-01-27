// HeadscaleCLI - Wrapper for tailscale CLI configured for Headscale server
// Extends TailscaleCLI with Headscale-specific functionality

import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import {
  TailscaleCLI,
  type TailscaleStatus,
  type TailscaleSelfStatus,
  type TailscalePeerInfo,
} from '../tailscale/cli'

const execAsync = promisify(exec)

// =============================================================================
// Types
// =============================================================================

/**
 * Headscale-specific configuration.
 */
export interface HeadscaleConfig {
  /** Headscale server URL (e.g., "https://headscale.example.com") */
  serverUrl: string
  /** Pre-auth key for automatic registration */
  preAuthKey?: string
  /** API key for Headscale admin operations */
  apiKey?: string
  /** Hostname to register with */
  hostname?: string
  /** Path to tailscale binary */
  tailscaleBin?: string
  /** Accept advertised routes from peers */
  acceptRoutes?: boolean
  /** Advertise exit node capability */
  exitNode?: boolean
  /** Accept DNS configuration from Headscale */
  acceptDns?: boolean
}

/**
 * Headscale node information from API.
 */
export interface HeadscaleNode {
  id: string
  name: string
  givenName: string
  ipAddresses: string[]
  user: {
    id: string
    name: string
  }
  online: boolean
  lastSeen?: string
  expiry?: string
  createdAt: string
  registerMethod: string
  forcedTags?: string[]
}

/**
 * Headscale user information.
 */
export interface HeadscaleUser {
  id: string
  name: string
  createdAt: string
}

/**
 * Pre-auth key information.
 */
export interface HeadscalePreAuthKey {
  id: string
  key: string
  user: string
  reusable: boolean
  ephemeral: boolean
  used: boolean
  expiration: string
  createdAt: string
  aclTags?: string[]
}

// =============================================================================
// HeadscaleCLI
// =============================================================================

/**
 * CLI wrapper for Tailscale connected to a Headscale server.
 *
 * This class extends TailscaleCLI functionality with:
 * - Headscale server URL configuration
 * - Pre-auth key support for automated registration
 * - Optional Headscale API operations (requires API key)
 *
 * The underlying implementation uses the standard Tailscale CLI,
 * configured to use a Headscale server instead of the default
 * Tailscale control plane.
 */
export class HeadscaleCLI extends TailscaleCLI {
  private config: HeadscaleConfig

  constructor(config: HeadscaleConfig) {
    super(config.tailscaleBin ?? 'tailscale')
    this.config = config
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  /**
   * Get the Headscale server URL.
   */
  getServerUrl(): string {
    return this.config.serverUrl
  }

  /**
   * Check if API key is configured.
   */
  hasApiKey(): boolean {
    return !!this.config.apiKey
  }

  // ===========================================================================
  // Connection Management (Override)
  // ===========================================================================

  /**
   * Connect to the Headscale server.
   * Uses the configured server URL and optional pre-auth key.
   */
  override async up(options?: {
    authKey?: string
    hostname?: string
    acceptRoutes?: boolean
  }): Promise<void> {
    const tailscaleBin = this.config.tailscaleBin ?? 'tailscale'
    const args = ['up', '--reset', '--login-server', this.config.serverUrl]

    // Use provided authKey or fallback to config preAuthKey
    const authKey = options?.authKey ?? this.config.preAuthKey
    if (authKey) {
      args.push('--authkey', authKey)
    }

    // Use provided hostname or fallback to config hostname
    const hostname = options?.hostname ?? this.config.hostname
    if (hostname) {
      args.push('--hostname', hostname)
    }

    // Accept routes
    const acceptRoutes = options?.acceptRoutes ?? this.config.acceptRoutes
    if (acceptRoutes) {
      args.push('--accept-routes')
    }

    // Accept DNS from Headscale
    if (this.config.acceptDns !== false) {
      args.push('--accept-dns')
    }

    // Exit node capability
    if (this.config.exitNode) {
      args.push('--advertise-exit-node')
    }

    try {
      await execAsync(`${tailscaleBin} ${args.join(' ')}`)
    } catch (error) {
      throw new Error(`Failed to connect to Headscale: ${(error as Error).message}`)
    }
  }

  /**
   * Disconnect from the Headscale server.
   */
  override async down(): Promise<void> {
    const tailscaleBin = this.config.tailscaleBin ?? 'tailscale'
    try {
      await execAsync(`${tailscaleBin} down`)
    } catch (error) {
      throw new Error(`Failed to disconnect from Headscale: ${(error as Error).message}`)
    }
  }

  /**
   * Logout from the Headscale server (removes node registration).
   */
  async logout(): Promise<void> {
    const tailscaleBin = this.config.tailscaleBin ?? 'tailscale'
    try {
      await execAsync(`${tailscaleBin} logout`)
    } catch (error) {
      throw new Error(`Failed to logout from Headscale: ${(error as Error).message}`)
    }
  }

  // ===========================================================================
  // Headscale API Operations (Requires API Key)
  // ===========================================================================

  /**
   * List all nodes in the Headscale network.
   * Requires API key to be configured.
   */
  async listNodes(): Promise<HeadscaleNode[]> {
    this.requireApiKey()

    try {
      const response = await this.apiRequest('/api/v1/machine')
      return response.machines ?? []
    } catch (error) {
      throw new Error(`Failed to list Headscale nodes: ${(error as Error).message}`)
    }
  }

  /**
   * Get a specific node by ID.
   * Requires API key to be configured.
   */
  async getNode(nodeId: string): Promise<HeadscaleNode | null> {
    this.requireApiKey()

    try {
      const response = await this.apiRequest(`/api/v1/machine/${nodeId}`)
      return response.machine ?? null
    } catch (error) {
      if ((error as Error).message.includes('404')) {
        return null
      }
      throw new Error(`Failed to get Headscale node: ${(error as Error).message}`)
    }
  }

  /**
   * Delete a node from the Headscale network.
   * Requires API key to be configured.
   */
  async deleteNode(nodeId: string): Promise<void> {
    this.requireApiKey()

    try {
      await this.apiRequest(`/api/v1/machine/${nodeId}`, 'DELETE')
    } catch (error) {
      throw new Error(`Failed to delete Headscale node: ${(error as Error).message}`)
    }
  }

  /**
   * Expire a node (force re-authentication).
   * Requires API key to be configured.
   */
  async expireNode(nodeId: string): Promise<void> {
    this.requireApiKey()

    try {
      await this.apiRequest(`/api/v1/machine/${nodeId}/expire`, 'POST')
    } catch (error) {
      throw new Error(`Failed to expire Headscale node: ${(error as Error).message}`)
    }
  }

  /**
   * List all users in the Headscale network.
   * Requires API key to be configured.
   */
  async listUsers(): Promise<HeadscaleUser[]> {
    this.requireApiKey()

    try {
      const response = await this.apiRequest('/api/v1/user')
      return response.users ?? []
    } catch (error) {
      throw new Error(`Failed to list Headscale users: ${(error as Error).message}`)
    }
  }

  /**
   * Create a pre-auth key.
   * Requires API key to be configured.
   */
  async createPreAuthKey(options: {
    user: string
    reusable?: boolean
    ephemeral?: boolean
    expiration?: string
    aclTags?: string[]
  }): Promise<HeadscalePreAuthKey> {
    this.requireApiKey()

    try {
      const response = await this.apiRequest('/api/v1/preauthkey', 'POST', {
        user: options.user,
        reusable: options.reusable ?? false,
        ephemeral: options.ephemeral ?? false,
        expiration: options.expiration,
        aclTags: options.aclTags,
      })
      return response.preAuthKey
    } catch (error) {
      throw new Error(`Failed to create pre-auth key: ${(error as Error).message}`)
    }
  }

  /**
   * List pre-auth keys for a user.
   * Requires API key to be configured.
   */
  async listPreAuthKeys(user: string): Promise<HeadscalePreAuthKey[]> {
    this.requireApiKey()

    try {
      const response = await this.apiRequest(`/api/v1/preauthkey?user=${encodeURIComponent(user)}`)
      return response.preAuthKeys ?? []
    } catch (error) {
      throw new Error(`Failed to list pre-auth keys: ${(error as Error).message}`)
    }
  }

  /**
   * Set tags on a node.
   * Requires API key to be configured.
   */
  async setNodeTags(nodeId: string, tags: string[]): Promise<void> {
    this.requireApiKey()

    try {
      await this.apiRequest(`/api/v1/machine/${nodeId}/tags`, 'POST', { tags })
    } catch (error) {
      throw new Error(`Failed to set node tags: ${(error as Error).message}`)
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Check that API key is configured.
   */
  private requireApiKey(): void {
    if (!this.config.apiKey) {
      throw new Error('Headscale API key is required for this operation')
    }
  }

  /**
   * Make an API request to the Headscale server.
   */
  private async apiRequest(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: unknown
  ): Promise<any> {
    const url = new URL(path, this.config.serverUrl)

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
    }

    if (body) {
      fetchOptions.body = JSON.stringify(body)
    }

    const response = await fetch(url.toString(), fetchOptions)

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Headscale API error ${response.status}: ${text}`)
    }

    const contentType = response.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      return response.json()
    }

    return {}
  }
}

// Re-export types from TailscaleCLI for convenience
export type { TailscaleStatus, TailscaleSelfStatus, TailscalePeerInfo }
