// Sudocode integration for agentic-mesh
// Provides mesh sync for sudocode specs, issues, relationships, and feedback

export { SudocodeMeshService } from './service'
export { EntityMapper } from './mapper'
export { JSONLBridge } from './jsonl-bridge'
export type { SudocodeState } from './jsonl-bridge'
export { GitReconciler } from './git-reconciler'
export type { GitReconcilerConfig, FileHashState, ReconcileEvent } from './git-reconciler'

// Re-export types
export type {
  SudocodeMeshConfig,
  IssueStatus,
  EntityType,
  RelationshipType,
  FeedbackType,
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
  FeedbackAnchorCRDT,
  EntityChangeSource,
  SudocodeEntityType,
  EntityChangeEvent,
  SpecJSONL,
  IssueJSONL,
  RelationshipJSONL,
  FeedbackJSONL,
} from './types'

export { makeRelationshipKey, parseRelationshipKey } from './types'
