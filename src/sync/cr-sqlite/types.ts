// CrSqliteSyncProvider Types
// Implements: s-iidh

import type { SyncProviderConfig } from '../../types'

// =============================================================================
// Configuration
// =============================================================================

export interface CrSqliteSyncConfig extends SyncProviderConfig {
  /** Path to SQLite database file */
  dbPath: string

  /** Tables to sync (if omitted, sync all CRR tables) */
  tables?: string[]

  /** Optional scope filter - only sync rows matching criteria */
  scope?: Record<string, unknown>

  /** How often to poll for local changes (ms, default: 100) */
  pollInterval?: number

  /** Batch size for changeset transmission (default: 1000) */
  batchSize?: number

  /** Path to cr-sqlite extension (auto-detected if not provided) */
  extensionPath?: string
}

// =============================================================================
// Message Protocol
// =============================================================================

export interface DbSyncMessages {
  /** Initial sync request */
  'db:sync-request': DbSyncRequest

  /** Sync response with changesets */
  'db:sync-response': DbSyncResponse

  /** Incremental update broadcast */
  'db:changes': DbChangesMessage

  /** Version announcement */
  'db:version': DbVersionMessage
}

export interface DbSyncRequest {
  /** Tables to sync */
  tables: string[]
  /** Request changes since this version (0 for full sync) */
  sinceVersion: number
}

export interface DbSyncResponse {
  /** Changesets to apply */
  changesets: CrSqliteChangeset[]
  /** Starting version of these changes */
  fromVersion: number
  /** Ending version after these changes */
  toVersion: number
  /** Whether more changesets are available (pagination) */
  hasMore: boolean
}

export interface DbChangesMessage {
  /** Changesets to apply */
  changesets: CrSqliteChangeset[]
  /** Version after these changes */
  version: number
}

export interface DbVersionMessage {
  /** Site ID of the peer */
  siteId: string
  /** Current version at this peer */
  version: number
}

// =============================================================================
// Changeset Types
// =============================================================================

export interface CrSqliteChangeset {
  /** Table name */
  table: string
  /** Primary key value(s) - serialized as JSON string by cr-sqlite */
  pk: string
  /** Column ID (column name) */
  cid: string
  /** Column value */
  val: unknown
  /** Column version (for conflict resolution) */
  col_version: number
  /** Database version when this change was made */
  db_version: number
  /** Site ID of the peer that made this change */
  site_id: Uint8Array | string
}

// =============================================================================
// Conflict Info
// =============================================================================

export interface ConflictInfo {
  /** Table where conflict occurred */
  table: string
  /** Primary key of conflicting row */
  pk: unknown
  /** Column that conflicted */
  column: string
  /** Which value won */
  winner: 'local' | 'remote'
  /** Local value before resolution */
  localValue: unknown
  /** Remote value that was merged */
  remoteValue: unknown
}

// =============================================================================
// Error Types
// =============================================================================

export type DbSyncErrorCode =
  | 'EXTENSION_NOT_FOUND'
  | 'DB_OPEN_FAILED'
  | 'TABLE_NOT_CRR'
  | 'CHANGESET_INVALID'
  | 'APPLY_FAILED'
  | 'SCHEMA_MISMATCH'
  | 'SYNC_TIMEOUT'

export class DbSyncError extends Error {
  readonly code: DbSyncErrorCode
  readonly recoverable: boolean

  constructor(message: string, code: DbSyncErrorCode, recoverable: boolean = true) {
    super(message)
    this.name = 'DbSyncError'
    this.code = code
    this.recoverable = recoverable
  }
}

// =============================================================================
// Provider Events
// =============================================================================

export interface CrSqliteSyncEvents {
  /** Emitted when a remote change is applied locally */
  'change:applied': (table: string, pk: unknown) => void
  /** Emitted when local changes are sent to peers */
  'change:sent': (table: string, count: number) => void
  /** Emitted when a conflict is detected and resolved */
  conflict: (info: ConflictInfo) => void
  /** Emitted when hub saves a snapshot */
  'snapshot:saved': (path: string) => void
}

// =============================================================================
// Internal Types
// =============================================================================

export interface VersionVector {
  /** Map of siteId to last seen version */
  [siteId: string]: number
}

export interface CrrTableInfo {
  /** Table name */
  name: string
  /** Primary key columns */
  primaryKeys: string[]
  /** All columns */
  columns: string[]
}
