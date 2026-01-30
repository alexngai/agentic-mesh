/**
 * Git Transport Types
 *
 * Type definitions for tunneling git protocol through agentic-mesh.
 * Supports git-upload-pack (fetch) and git-receive-pack (push) operations.
 */

// =============================================================================
// Git Reference Types
// =============================================================================

/** A git reference (branch, tag, etc.) */
export interface GitRef {
  /** SHA-1 hash of the object */
  sha: string
  /** Full ref name (e.g., refs/heads/main) */
  name: string
  /** For symrefs like HEAD, the target ref */
  symref?: string
  /** Whether this ref is peeled (for annotated tags) */
  peeled?: string
}

/** Git capabilities advertised by the server */
export type GitCapability =
  | 'thin-pack'
  | 'side-band'
  | 'side-band-64k'
  | 'shallow'
  | 'no-progress'
  | 'include-tag'
  | 'multi_ack'
  | 'multi_ack_detailed'
  | 'no-done'
  | 'symref'
  | 'quiet'
  | 'atomic'
  | 'push-options'
  | 'object-format'
  | 'filter'
  | 'allow-tip-sha1-in-want'
  | 'allow-reachable-sha1-in-want'
  | 'deepen-since'
  | 'deepen-not'
  | 'deepen-relative'

// =============================================================================
// Request/Response Types
// =============================================================================

/** Request to list refs on a remote repository */
export interface ListRefsRequest {
  /** Optional prefix to filter refs (e.g., "refs/heads/") */
  refPrefix?: string
  /** Whether this is for a push operation (may affect visibility) */
  forPush?: boolean
  /** Symrefs to resolve (e.g., ["HEAD"]) */
  symrefs?: string[]
}

/** Response from listing refs */
export interface ListRefsResponse {
  /** List of refs */
  refs: GitRef[]
  /** Capabilities supported by the server */
  capabilities: GitCapability[]
  /** HEAD symref target if available */
  head?: string
}

/** Request for git-upload-pack (fetch) */
export interface UploadPackRequest {
  /** Object SHAs the client wants */
  wants: string[]
  /** Object SHAs the client already has (for negotiation) */
  haves: string[]
  /** Shallow clone depth */
  depth?: number
  /** Partial clone filter (e.g., "blob:none") */
  filter?: string
  /** Shallow commits to deepen from */
  shallowSince?: string
  /** Refs to exclude from deepening */
  deepenNot?: string[]
  /** Whether to include tags */
  includeTags?: boolean
  /** Disable progress output */
  noProgress?: boolean
}

/** Response from git-upload-pack */
export interface UploadPackResponse {
  /** Base64-encoded pack data (for JSON transport) */
  packData?: string
  /** Shallow commits if depth was specified */
  shallows?: string[]
  /** Acknowledged commits during negotiation */
  acks?: string[]
  /** Whether negotiation is complete */
  ready?: boolean
}

/** A ref update command for push */
export interface RefUpdateCommand {
  /** Source ref or SHA (what to push) */
  src: string
  /** Destination ref on remote */
  dst: string
  /** Expected current value on remote (for CAS) */
  oldSha?: string
  /** New value to set */
  newSha?: string
  /** Force update even if not fast-forward */
  force?: boolean
  /** Delete the ref */
  delete?: boolean
}

/** Request for git-receive-pack (push) */
export interface ReceivePackRequest {
  /** Ref update commands */
  commands: RefUpdateCommand[]
  /** Base64-encoded pack data containing objects to push */
  packData?: string
  /** Push options (if server supports push-options) */
  pushOptions?: string[]
  /** Atomic push - all or nothing */
  atomic?: boolean
}

/** Result of a single ref update */
export interface RefUpdateResult {
  /** The ref that was updated */
  ref: string
  /** Whether the update succeeded */
  status: 'ok' | 'rejected' | 'error'
  /** Reason for rejection/error */
  reason?: string
}

/** Response from git-receive-pack */
export interface ReceivePackResponse {
  /** Results for each ref update */
  results: RefUpdateResult[]
  /** Server-side messages */
  messages?: string[]
}

// =============================================================================
// Configuration Types
// =============================================================================

/** Configuration for the git transport handler */
export interface GitTransportConfig {
  /** Whether git transport is enabled */
  enabled: boolean

  /** Path to the git repository */
  repoPath: string

  /** Clone/fetch configuration */
  clone: {
    /** Allow shallow clones */
    allowShallow: boolean
    /** Maximum depth for shallow clones (0 = unlimited) */
    maxDepth?: number
    /** Allow partial clones */
    allowPartial: boolean
    /** Allowed partial clone filters */
    allowedFilters?: string[]
  }

  /** Push configuration */
  push: {
    /** Refs that cannot be force-pushed */
    protectedBranches: string[]
    /** Require signed commits */
    requireSigned: boolean
    /** Allow deleting refs */
    allowDelete: boolean
    /** Allow non-fast-forward pushes */
    allowNonFastForward: boolean
  }

  /** Timeout for git operations in milliseconds */
  operationTimeoutMs: number

  /** Maximum pack size in bytes (0 = unlimited) */
  maxPackSize: number
}

/** Default git transport configuration */
export const DEFAULT_GIT_TRANSPORT_CONFIG: GitTransportConfig = {
  enabled: true,
  repoPath: process.cwd(),
  clone: {
    allowShallow: true,
    maxDepth: 100,
    allowPartial: true,
    allowedFilters: ['blob:none', 'tree:0'],
  },
  push: {
    protectedBranches: ['main', 'master'],
    requireSigned: false,
    allowDelete: true,
    allowNonFastForward: false,
  },
  operationTimeoutMs: 300000, // 5 minutes
  maxPackSize: 100 * 1024 * 1024, // 100 MB
}

// =============================================================================
// Access Control Types
// =============================================================================

/** Git access level */
export type GitAccessLevel = 'none' | 'read' | 'write' | 'admin'

/** Git access check result */
export interface GitAccessCheckResult {
  allowed: boolean
  level: GitAccessLevel
  reason?: string
}

/** Interface for git access control */
export interface GitAccessControl {
  /** Check if peer can read from this repo */
  checkRead(peerId: string): Promise<GitAccessCheckResult>

  /** Check if peer can write to this repo */
  checkWrite(peerId: string): Promise<GitAccessCheckResult>

  /** Check if peer can update a specific ref */
  checkRefUpdate(
    peerId: string,
    ref: string,
    force: boolean
  ): Promise<GitAccessCheckResult>

  /** Check if peer can delete a ref */
  checkRefDelete(peerId: string, ref: string): Promise<GitAccessCheckResult>
}

// =============================================================================
// Protocol Handler Interface
// =============================================================================

/** Interface for handling git protocol operations */
export interface GitProtocolHandler {
  /** List refs in the repository */
  listRefs(request: ListRefsRequest): Promise<ListRefsResponse>

  /** Handle fetch (git-upload-pack) */
  uploadPack(request: UploadPackRequest): Promise<UploadPackResponse>

  /** Handle push (git-receive-pack) */
  receivePack(request: ReceivePackRequest): Promise<ReceivePackResponse>

  /** Get the current configuration */
  getConfig(): GitTransportConfig

  /** Update configuration */
  updateConfig(config: Partial<GitTransportConfig>): void
}

// =============================================================================
// Streaming Types (for large pack transfers)
// =============================================================================

/** Options for streaming pack data */
export interface PackStreamOptions {
  /** Chunk size for streaming (default: 64KB) */
  chunkSize?: number
  /** Progress callback */
  onProgress?: (bytesTransferred: number, totalBytes?: number) => void
  /** Abort signal */
  signal?: AbortSignal
}

/** A streaming pack transfer */
export interface PackStream {
  /** Async iterator for reading pack chunks */
  read(): AsyncIterable<Uint8Array>
  /** Total size if known */
  totalSize?: number
  /** Abort the transfer */
  abort(): void
}

// =============================================================================
// Wire Protocol Types (for MAP integration)
// =============================================================================

/** Git protocol message types for MAP routing */
export type GitMessageType =
  | 'git/list-refs'
  | 'git/upload-pack'
  | 'git/receive-pack'
  | 'git/pack-stream'
  | 'git/pack-chunk'
  | 'git/pack-complete'
  | 'git/error'

/** Base git protocol message */
export interface GitMessage {
  type: GitMessageType
  /** Correlation ID for request/response matching */
  correlationId: string
  /** Repository path (for multi-repo support) */
  repoPath?: string
}

/** Git list-refs request message */
export interface GitListRefsMessage extends GitMessage {
  type: 'git/list-refs'
  request: ListRefsRequest
}

/** Git upload-pack request message */
export interface GitUploadPackMessage extends GitMessage {
  type: 'git/upload-pack'
  request: UploadPackRequest
}

/** Git receive-pack request message */
export interface GitReceivePackMessage extends GitMessage {
  type: 'git/receive-pack'
  request: ReceivePackRequest
}

/** Git pack stream initiation message */
export interface GitPackStreamMessage extends GitMessage {
  type: 'git/pack-stream'
  /** Direction of the stream */
  direction: 'upload' | 'download'
  /** Total size if known */
  totalSize?: number
}

/** Git pack chunk message (for streaming) */
export interface GitPackChunkMessage extends GitMessage {
  type: 'git/pack-chunk'
  /** Base64-encoded chunk data */
  data: string
  /** Chunk sequence number */
  sequence: number
  /** Whether this is the last chunk */
  final: boolean
}

/** Git pack complete message */
export interface GitPackCompleteMessage extends GitMessage {
  type: 'git/pack-complete'
  /** SHA-256 checksum of complete pack */
  checksum: string
  /** Total bytes transferred */
  totalBytes: number
}

/** Git error message */
export interface GitErrorMessage extends GitMessage {
  type: 'git/error'
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Git list-refs response message */
export interface GitListRefsResponseMessage extends GitMessage {
  type: 'git/list-refs'
  response: ListRefsResponse
}

/** Git upload-pack response message */
export interface GitUploadPackResponseMessage extends GitMessage {
  type: 'git/upload-pack'
  response: UploadPackResponse
}

/** Git receive-pack response message */
export interface GitReceivePackResponseMessage extends GitMessage {
  type: 'git/receive-pack'
  response: ReceivePackResponse
}

/** Union of all git protocol messages (requests and responses) */
export type AnyGitMessage =
  | GitListRefsMessage
  | GitUploadPackMessage
  | GitReceivePackMessage
  | GitListRefsResponseMessage
  | GitUploadPackResponseMessage
  | GitReceivePackResponseMessage
  | GitPackStreamMessage
  | GitPackChunkMessage
  | GitPackCompleteMessage
  | GitErrorMessage

// =============================================================================
// Helper Remote Types
// =============================================================================

/** URL components for mesh:// URLs */
export interface MeshGitUrl {
  /** Protocol (always "mesh") */
  protocol: 'mesh'
  /** Remote peer ID */
  peerId: string
  /** Repository path on remote */
  repoPath: string
}

/** Configuration for the git-remote-mesh helper */
export interface GitRemoteHelperConfig {
  /** URL of the local MeshPeer HTTP server */
  meshPeerUrl: string
  /** Connection timeout in milliseconds */
  connectionTimeoutMs: number
  /** Operation timeout in milliseconds */
  operationTimeoutMs: number
  /** Enable verbose logging */
  verbose: boolean
}

/** Default git remote helper configuration */
export const DEFAULT_GIT_REMOTE_HELPER_CONFIG: GitRemoteHelperConfig = {
  meshPeerUrl: 'http://localhost:3456',
  connectionTimeoutMs: 30000,
  operationTimeoutMs: 300000,
  verbose: false,
}
