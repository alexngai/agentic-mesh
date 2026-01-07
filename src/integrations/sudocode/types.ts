// Sudocode integration types for agentic-mesh
// Maps sudocode entities to CRDT-friendly structures

import type { NebulaMeshConfig } from '../../types'

// =============================================================================
// Service Configuration
// =============================================================================

export interface SudocodeMeshConfig {
  /** Unique project identifier */
  projectId: string
  /** Path to .sudocode/ directory */
  projectPath: string
  /** Mesh connection config */
  meshConfig: NebulaMeshConfig
  /** Debounce delay for JSONL saves (ms) */
  saveDebounceMs?: number // Default: 500
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
