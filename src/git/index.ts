/**
 * Git Transport Module
 *
 * Provides git transport over agentic-mesh for MAP integration.
 * Allows multi-agent systems to sync repositories through the mesh network.
 *
 * Components:
 * - GitProtocolHandler: Handles git protocol operations (upload-pack, receive-pack)
 * - GitTransportService: HTTP server for git-remote-mesh helper + peer routing
 * - git-remote-mesh: CLI helper that git spawns for mesh:// URLs
 *
 * Usage:
 * ```typescript
 * import { createGitTransportService, createGitProtocolHandler } from 'agentic-mesh/git'
 *
 * // Create and start the git transport service
 * const gitService = createGitTransportService({
 *   httpPort: 3456,
 *   git: {
 *     repoPath: '/path/to/repo',
 *   },
 * })
 *
 * await gitService.start()
 *
 * // Users can now use:
 * // git remote add peer mesh://remote-peer-id
 * // git fetch peer main
 * // git push peer feature-branch
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
