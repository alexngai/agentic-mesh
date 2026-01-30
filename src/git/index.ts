/**
 * Git Transport Module
 *
 * Provides git transport over agentic-mesh for MAP integration.
 * Allows multi-agent systems to sync repositories through the mesh network.
 *
 * Components:
 * - GitProtocolHandler: Handles git protocol operations (upload-pack, receive-pack)
 * - GitTransportService: HTTP server for git-remote-mesh helper + peer routing
 * - GitSyncClient: High-level sync API for agents
 * - git-remote-mesh: CLI helper that git spawns for mesh:// URLs
 *
 * Usage (via standard git commands):
 * ```bash
 * # Add mesh remote pointing to a peer
 * git remote add peer-b mesh://peer-b-id/
 *
 * # Fetch/push as normal
 * git fetch peer-b
 * git push peer-b main
 * ```
 *
 * Usage (via GitSyncClient for agents):
 * ```typescript
 * // Get sync client from MeshPeer
 * const client = peer.git.createSyncClient('/path/to/repo')
 *
 * // Sync with remote peer
 * await client.sync('peer-b', { branch: 'main', bidirectional: true })
 *
 * // Or individual operations
 * await client.pull('peer-b', 'main')
 * await client.push('peer-b', 'feature-branch')
 *
 * // Clone from peer
 * await client.clone('peer-b', '/path/to/new/repo')
 * ```
 */

// Types
export * from './types'

// Protocol handler
export {
  GitProtocolHandlerImpl,
  GitProtocolError,
  DefaultGitAccessControl,
  createGitProtocolHandler,
  type GitProtocolHandlerOptions,
} from './protocol-handler'

// Transport service
export {
  GitTransportService,
  createGitTransportService,
  DEFAULT_GIT_SERVICE_CONFIG,
  type GitTransportServiceConfig,
  type GitTransportServiceEvents,
  type PeerMessageSender,
} from './transport-service'

// Sync client
export {
  GitSyncClient,
  createGitSyncClient,
  type SyncOptions,
  type SyncResult,
  type CloneOptions,
  type PushOptions,
  type PullOptions,
  type GitSyncClientEvents,
} from './sync-client'

// Pack streamer (for advanced use)
export {
  PackStreamer,
  PackReceiver,
  createPackStreamer,
  createPackReceiver,
} from './pack-streamer'
