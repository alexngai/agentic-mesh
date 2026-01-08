// Sudocode integration types for agentic-mesh
// Maps sudocode entities to CRDT-friendly structures

import type { NebulaMeshConfig } from '../../types'

// =============================================================================
// Service Configuration
// =============================================================================

/** Entity types that can be selectively synced */
export type SyncableEntityType = 'specs' | 'issues' | 'relationships' | 'feedback'

/** All syncable entity types (for default behavior) */
export const ALL_SYNCABLE_ENTITIES: SyncableEntityType[] = [
  'specs',
  'issues',
  'relationships',
  'feedback',
]

// Import sync filter types (forward declaration to avoid circular deps)
import type { SyncFilter } from './sync-filter'
import type { PartitionConfig } from './partition-manager'

export interface SudocodeMeshConfig {
  /** Unique project identifier */
  projectId: string
  /** Path to .sudocode/ directory */
  projectPath: string
  /** Mesh connection config */
  meshConfig: NebulaMeshConfig
  /** Debounce delay for JSONL saves (ms) */
  saveDebounceMs?: number // Default: 500
  /** Entity types to sync over mesh (default: all types) */
  syncEntities?: SyncableEntityType[]
  /** Fine-grained sync filter for ID patterns and attributes */
  syncFilter?: SyncFilter
  /** Namespace partitioning configuration for selective sync */
  partitionConfig?: PartitionConfig
  /** Permission configuration for group-based access control (Phase 9.5) */
  permissionConfig?: SudocodePermissionConfig
}

// =============================================================================
// Entity Types (mirrored from sudocode/types)
// =============================================================================

export type IssueStatus = 'open' | 'in_progress' | 'blocked' | 'needs_review' | 'closed'

export type EntityType = 'spec' | 'issue'

export type RelationshipType =
  | 'blocks'
  | 'related'
  | 'discovered-from'
  | 'implements'
  | 'references'
  | 'depends-on'

export type FeedbackType = 'comment' | 'suggestion' | 'request'

// =============================================================================
// CRDT Data Types (optimized for Yjs sync)
// =============================================================================

/**
 * Spec data stored in CRDT Y.Map
 * Simplified from sudocode Spec type for efficient sync
 */
export interface SpecCRDT {
  id: string
  uuid: string
  title: string
  content: string
  priority: number
  archived: boolean
  created_at: string // ISO timestamp
  updated_at: string
  parent_id?: string
  parent_uuid?: string
  // file_path computed locally, not synced
  // external_links handled separately
}

/**
 * Issue data stored in CRDT Y.Map
 */
export interface IssueCRDT {
  id: string
  uuid: string
  title: string
  status: IssueStatus
  content: string
  priority: number
  assignee?: string
  archived: boolean
  created_at: string
  updated_at: string
  closed_at?: string
  parent_id?: string
  parent_uuid?: string
}

/**
 * Relationship data stored in CRDT Y.Map
 * Key format: `${from_id}:${to_id}:${type}`
 */
export interface RelationshipCRDT {
  from_id: string
  from_uuid: string
  from_type: EntityType
  to_id: string
  to_uuid: string
  to_type: EntityType
  relationship_type: RelationshipType
  created_at: string
  metadata?: string
}

/**
 * Feedback anchor for tracking position in markdown
 */
export interface FeedbackAnchorCRDT {
  section_heading?: string
  section_level?: number
  line_number?: number
  line_offset?: number
  text_snippet?: string
  context_before?: string
  context_after?: string
  content_hash?: string
  anchor_status: 'valid' | 'relocated' | 'stale'
  last_verified_at?: string
  original_location?: {
    line_number: number
    section_heading?: string
  }
}

/**
 * Feedback data stored in CRDT Y.Map
 */
export interface FeedbackCRDT {
  id: string
  from_id?: string // Issue that provided feedback (optional)
  from_uuid?: string
  to_id: string // Target spec or issue
  to_uuid: string
  feedback_type: FeedbackType
  content: string
  agent?: string
  anchor?: FeedbackAnchorCRDT
  dismissed: boolean
  created_at: string
  updated_at: string
}

// =============================================================================
// Composite Key Helpers
// =============================================================================

export function makeRelationshipKey(
  fromId: string,
  toId: string,
  type: RelationshipType
): string {
  return `${fromId}:${toId}:${type}`
}

export function parseRelationshipKey(key: string): {
  fromId: string
  toId: string
  type: RelationshipType
} | null {
  const parts = key.split(':')
  if (parts.length !== 3) return null
  return {
    fromId: parts[0],
    toId: parts[1],
    type: parts[2] as RelationshipType,
  }
}

// =============================================================================
// Event Types
// =============================================================================

export type EntityChangeSource = 'local' | 'remote' | 'reconcile'

export type SudocodeEntityType = 'spec' | 'issue' | 'relationship' | 'feedback'

export interface EntityChangeEvent<T = unknown> {
  entityType: SudocodeEntityType
  entity: T
  source: EntityChangeSource
  action: 'create' | 'update' | 'delete'
}

// =============================================================================
// JSONL Types (for golden file format)
// =============================================================================

export interface SpecJSONL {
  id: string
  uuid: string
  title: string
  file_path: string
  content: string
  priority: number
  archived?: boolean
  archived_at?: string
  created_at: string
  updated_at: string
  parent_id?: string
  parent_uuid?: string
  relationships: RelationshipJSONL[]
  tags: string[]
}

export interface IssueJSONL {
  id: string
  uuid: string
  title: string
  status: IssueStatus
  content: string
  priority: number
  assignee?: string
  archived?: boolean
  archived_at?: string
  created_at: string
  updated_at: string
  closed_at?: string
  parent_id?: string
  parent_uuid?: string
  relationships: RelationshipJSONL[]
  tags: string[]
  feedback?: FeedbackJSONL[]
}

export interface RelationshipJSONL {
  from: string
  from_type: EntityType
  to: string
  to_type: EntityType
  type: RelationshipType
}

export interface FeedbackJSONL {
  id: string
  from_id?: string
  to_id: string
  feedback_type: FeedbackType
  content: string
  agent?: string
  anchor?: FeedbackAnchorCRDT
  dismissed?: boolean
  created_at: string
  updated_at: string
}

// =============================================================================
// Remote Execution Types (Phase 9.3)
// =============================================================================

/**
 * Options for requesting issue execution on a remote peer.
 */
export interface IssueExecutionOptions {
  /** Agent type to use for execution */
  agentType?: 'claude-code' | 'custom'
  /** Worktree sync strategy */
  worktreeSync?: 'none' | 'squash' | 'rebase'
  /** Optional timeout in ms */
  timeout?: number
  /** Whether to stream execution output */
  stream?: boolean
}

/**
 * Result of an issue execution request.
 */
export interface IssueExecutionResult {
  /** Whether execution was successful */
  success: boolean
  /** Issue ID that was executed */
  issueId: string
  /** Peer that executed the issue */
  peerId: string
  /** Exit code (0 for success) */
  exitCode?: number
  /** Execution output */
  output?: string
  /** Error message if failed */
  error?: string
}

/**
 * Event for incoming issue execution request.
 */
export interface IssueExecutionRequestEvent {
  /** Issue ID to execute */
  issueId: string
  /** Execution options */
  options: IssueExecutionOptions
  /** Peer that requested execution */
  from: import('../../types').PeerInfo
  /** Function to accept and respond to the request */
  accept: (handler: (update: string) => void) => Promise<IssueExecutionResult>
  /** Function to reject the request */
  reject: (reason: string) => void
}

// =============================================================================
// Permission Types (Phase 9.5)
// =============================================================================

/**
 * Sudocode mesh actions that can be permission-checked.
 */
export type SudocodeAction = 'read' | 'write' | 'execute' | 'admin'

/**
 * Permission configuration for SudocodeMeshService.
 */
export interface SudocodePermissionConfig {
  /** Groups that have admin access */
  adminGroups?: string[]
  /** Groups that have developer (read/write/execute) access */
  developerGroups?: string[]
  /** Groups that have read-only access */
  readonlyGroups?: string[]
}

/**
 * Result of a permission check.
 */
export interface SudocodePermissionResult {
  allowed: boolean
  action: SudocodeAction
  peerGroups: string[]
  requiredGroups?: string[]
}
