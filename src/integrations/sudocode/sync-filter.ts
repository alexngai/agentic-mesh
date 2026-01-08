// SyncFilterEngine - Filter entities for selective sync
// Implements: i-3lda

import picomatch from 'picomatch'
import type {
  IssueStatus,
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
  RelationshipType,
  FeedbackType,
} from './types'

// =============================================================================
// Filter Configuration Types
// =============================================================================

/**
 * Filter config for specs.
 * All conditions are AND'd together.
 */
export interface SpecFilterConfig {
  /** ID glob patterns (e.g., 's-abc*', 's-???') - OR'd together */
  ids?: string[]
  /** Only sync specs with these priorities - OR'd together */
  priority?: number[]
  /** Only sync archived/non-archived specs */
  archived?: boolean
  /** Only sync specs with any of these tags - OR'd together */
  tags?: string[]
}

/**
 * Filter config for issues.
 * All conditions are AND'd together.
 */
export interface IssueFilterConfig {
  /** ID glob patterns (e.g., 'i-abc*') - OR'd together */
  ids?: string[]
  /** Only sync issues with these statuses - OR'd together */
  status?: IssueStatus[]
  /** Only sync issues with these priorities - OR'd together */
  priority?: number[]
  /** Only sync archived/non-archived issues */
  archived?: boolean
  /** Only sync issues with any of these tags - OR'd together */
  tags?: string[]
  /** Only sync issues assigned to these users - OR'd together */
  assignee?: string[]
}

/**
 * Filter config for relationships.
 * All conditions are AND'd together.
 */
export interface RelationshipFilterConfig {
  /** Only sync relationships of these types - OR'd together */
  types?: RelationshipType[]
  /** Only sync relationships from entities matching these patterns - OR'd together */
  fromIds?: string[]
  /** Only sync relationships to entities matching these patterns - OR'd together */
  toIds?: string[]
}

/**
 * Filter config for feedback.
 * All conditions are AND'd together.
 */
export interface FeedbackFilterConfig {
  /** ID glob patterns - OR'd together */
  ids?: string[]
  /** Only sync feedback of these types - OR'd together */
  types?: FeedbackType[]
  /** Only sync feedback to entities matching these patterns - OR'd together */
  toIds?: string[]
  /** Only sync dismissed/non-dismissed feedback */
  dismissed?: boolean
}

/**
 * Filter shorthand types:
 * - 'all': sync all entities of this type
 * - 'none': sync no entities of this type
 * - string[]: sync entities matching these ID patterns (shorthand for { ids: [...] })
 */
export type FilterShorthand = 'all' | 'none' | string[]

/**
 * Complete sync filter configuration.
 */
export interface SyncFilter {
  specs?: FilterShorthand | SpecFilterConfig
  issues?: FilterShorthand | IssueFilterConfig
  relationships?: FilterShorthand | RelationshipFilterConfig
  feedback?: FilterShorthand | FeedbackFilterConfig
}

// =============================================================================
// Predicate Types
// =============================================================================

export type SpecPredicate = (spec: SpecCRDT) => boolean
export type IssuePredicate = (issue: IssueCRDT) => boolean
export type RelationshipPredicate = (rel: RelationshipCRDT) => boolean
export type FeedbackPredicate = (fb: FeedbackCRDT) => boolean

// =============================================================================
// SyncFilterEngine
// =============================================================================

/**
 * Engine for compiling and evaluating sync filters.
 * Compiles filter configs into efficient predicates.
 */
export class SyncFilterEngine {
  private specPredicate: SpecPredicate = () => true
  private issuePredicate: IssuePredicate = () => true
  private relationshipPredicate: RelationshipPredicate = () => true
  private feedbackPredicate: FeedbackPredicate = () => true

  private currentFilter: SyncFilter = {}

  constructor(filter?: SyncFilter) {
    if (filter) {
      this.setFilter(filter)
    }
  }

  // ===========================================================================
  // Filter Management
  // ===========================================================================

  /**
   * Set or update the sync filter.
   * Recompiles all predicates.
   */
  setFilter(filter: SyncFilter): void {
    this.currentFilter = filter
    this.compilePredicates()
  }

  /**
   * Get the current filter configuration.
   */
  getFilter(): SyncFilter {
    return { ...this.currentFilter }
  }

  /**
   * Update a specific entity type's filter.
   */
  updateSpecFilter(filter: FilterShorthand | SpecFilterConfig | undefined): void {
    this.currentFilter.specs = filter
    this.specPredicate = this.compileSpecPredicate(filter)
  }

  updateIssueFilter(filter: FilterShorthand | IssueFilterConfig | undefined): void {
    this.currentFilter.issues = filter
    this.issuePredicate = this.compileIssuePredicate(filter)
  }

  updateRelationshipFilter(
    filter: FilterShorthand | RelationshipFilterConfig | undefined
  ): void {
    this.currentFilter.relationships = filter
    this.relationshipPredicate = this.compileRelationshipPredicate(filter)
  }

  updateFeedbackFilter(filter: FilterShorthand | FeedbackFilterConfig | undefined): void {
    this.currentFilter.feedback = filter
    this.feedbackPredicate = this.compileFeedbackPredicate(filter)
  }

  /**
   * Clear all filters (sync everything).
   */
  clearFilter(): void {
    this.currentFilter = {}
    this.compilePredicates()
  }

  // ===========================================================================
  // Predicate Evaluation
  // ===========================================================================

  /**
   * Check if a spec should be synced.
   */
  shouldSyncSpec(spec: SpecCRDT): boolean {
    return this.specPredicate(spec)
  }

  /**
   * Check if an issue should be synced.
   */
  shouldSyncIssue(issue: IssueCRDT): boolean {
    return this.issuePredicate(issue)
  }

  /**
   * Check if a relationship should be synced.
   */
  shouldSyncRelationship(rel: RelationshipCRDT): boolean {
    return this.relationshipPredicate(rel)
  }

  /**
   * Check if feedback should be synced.
   */
  shouldSyncFeedback(fb: FeedbackCRDT): boolean {
    return this.feedbackPredicate(fb)
  }

  // ===========================================================================
  // Predicate Compilation
  // ===========================================================================

  private compilePredicates(): void {
    this.specPredicate = this.compileSpecPredicate(this.currentFilter.specs)
    this.issuePredicate = this.compileIssuePredicate(this.currentFilter.issues)
    this.relationshipPredicate = this.compileRelationshipPredicate(
      this.currentFilter.relationships
    )
    this.feedbackPredicate = this.compileFeedbackPredicate(this.currentFilter.feedback)
  }

  private compileSpecPredicate(
    filter: FilterShorthand | SpecFilterConfig | undefined
  ): SpecPredicate {
    // No filter = sync all
    if (filter === undefined || filter === 'all') {
      return () => true
    }

    // 'none' = sync nothing
    if (filter === 'none') {
      return () => false
    }

    // String array = ID patterns shorthand
    if (Array.isArray(filter)) {
      const matcher = this.compileIdMatcher(filter)
      return (spec) => matcher(spec.id)
    }

    // Full config object
    const config = filter as SpecFilterConfig
    const conditions: SpecPredicate[] = []

    if (config.ids && config.ids.length > 0) {
      const matcher = this.compileIdMatcher(config.ids)
      conditions.push((spec) => matcher(spec.id))
    }

    if (config.priority && config.priority.length > 0) {
      const priorities = new Set(config.priority)
      conditions.push((spec) => priorities.has(spec.priority))
    }

    if (config.archived !== undefined) {
      conditions.push((spec) => spec.archived === config.archived)
    }

    if (config.tags && config.tags.length > 0) {
      // Note: SpecCRDT doesn't have tags field directly,
      // but we support it for future compatibility
      conditions.push(() => true) // Placeholder - specs don't have tags in CRDT
    }

    // AND all conditions together
    if (conditions.length === 0) {
      return () => true
    }

    return (spec) => conditions.every((cond) => cond(spec))
  }

  private compileIssuePredicate(
    filter: FilterShorthand | IssueFilterConfig | undefined
  ): IssuePredicate {
    if (filter === undefined || filter === 'all') {
      return () => true
    }

    if (filter === 'none') {
      return () => false
    }

    if (Array.isArray(filter)) {
      const matcher = this.compileIdMatcher(filter)
      return (issue) => matcher(issue.id)
    }

    const config = filter as IssueFilterConfig
    const conditions: IssuePredicate[] = []

    if (config.ids && config.ids.length > 0) {
      const matcher = this.compileIdMatcher(config.ids)
      conditions.push((issue) => matcher(issue.id))
    }

    if (config.status && config.status.length > 0) {
      const statuses = new Set(config.status)
      conditions.push((issue) => statuses.has(issue.status))
    }

    if (config.priority && config.priority.length > 0) {
      const priorities = new Set(config.priority)
      conditions.push((issue) => priorities.has(issue.priority))
    }

    if (config.archived !== undefined) {
      conditions.push((issue) => issue.archived === config.archived)
    }

    if (config.assignee && config.assignee.length > 0) {
      const assignees = new Set(config.assignee)
      conditions.push((issue) => issue.assignee !== undefined && assignees.has(issue.assignee))
    }

    if (conditions.length === 0) {
      return () => true
    }

    return (issue) => conditions.every((cond) => cond(issue))
  }

  private compileRelationshipPredicate(
    filter: FilterShorthand | RelationshipFilterConfig | undefined
  ): RelationshipPredicate {
    if (filter === undefined || filter === 'all') {
      return () => true
    }

    if (filter === 'none') {
      return () => false
    }

    if (Array.isArray(filter)) {
      // For relationships, string array matches relationship types
      const types = new Set(filter as string[])
      return (rel) => types.has(rel.relationship_type)
    }

    const config = filter as RelationshipFilterConfig
    const conditions: RelationshipPredicate[] = []

    if (config.types && config.types.length > 0) {
      const types = new Set(config.types)
      conditions.push((rel) => types.has(rel.relationship_type))
    }

    if (config.fromIds && config.fromIds.length > 0) {
      const matcher = this.compileIdMatcher(config.fromIds)
      conditions.push((rel) => matcher(rel.from_id))
    }

    if (config.toIds && config.toIds.length > 0) {
      const matcher = this.compileIdMatcher(config.toIds)
      conditions.push((rel) => matcher(rel.to_id))
    }

    if (conditions.length === 0) {
      return () => true
    }

    return (rel) => conditions.every((cond) => cond(rel))
  }

  private compileFeedbackPredicate(
    filter: FilterShorthand | FeedbackFilterConfig | undefined
  ): FeedbackPredicate {
    if (filter === undefined || filter === 'all') {
      return () => true
    }

    if (filter === 'none') {
      return () => false
    }

    if (Array.isArray(filter)) {
      const matcher = this.compileIdMatcher(filter)
      return (fb) => matcher(fb.id)
    }

    const config = filter as FeedbackFilterConfig
    const conditions: FeedbackPredicate[] = []

    if (config.ids && config.ids.length > 0) {
      const matcher = this.compileIdMatcher(config.ids)
      conditions.push((fb) => matcher(fb.id))
    }

    if (config.types && config.types.length > 0) {
      const types = new Set(config.types)
      conditions.push((fb) => types.has(fb.feedback_type))
    }

    if (config.toIds && config.toIds.length > 0) {
      const matcher = this.compileIdMatcher(config.toIds)
      conditions.push((fb) => matcher(fb.to_id))
    }

    if (config.dismissed !== undefined) {
      conditions.push((fb) => fb.dismissed === config.dismissed)
    }

    if (conditions.length === 0) {
      return () => true
    }

    return (fb) => conditions.every((cond) => cond(fb))
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Compile an array of glob patterns into a single matcher function.
   * Patterns are OR'd together (any match = true).
   */
  private compileIdMatcher(patterns: string[]): (id: string) => boolean {
    if (patterns.length === 0) {
      return () => true
    }

    // Check if any patterns have glob characters
    const hasGlob = patterns.some((p) => /[*?[\]{}]/.test(p))

    if (!hasGlob) {
      // No glob patterns - use simple Set lookup for efficiency
      const patternSet = new Set(patterns)
      return (id) => patternSet.has(id)
    }

    // Compile glob patterns with picomatch
    const matchers = patterns.map((pattern) => picomatch(pattern))
    return (id) => matchers.some((match) => match(id))
  }
}

// =============================================================================
// Factory Helpers
// =============================================================================

/**
 * Create a filter that syncs only open/in-progress issues.
 */
export function createActiveIssuesFilter(): SyncFilter {
  return {
    specs: 'all',
    issues: { status: ['open', 'in_progress'], archived: false },
    relationships: 'all',
    feedback: 'all',
  }
}

/**
 * Create a filter that syncs only high-priority items.
 */
export function createHighPriorityFilter(): SyncFilter {
  return {
    specs: { priority: [0, 1], archived: false },
    issues: { priority: [0, 1], archived: false },
    relationships: 'all',
    feedback: 'all',
  }
}

/**
 * Create a filter that syncs only non-archived items.
 */
export function createNonArchivedFilter(): SyncFilter {
  return {
    specs: { archived: false },
    issues: { archived: false },
    relationships: 'all',
    feedback: { dismissed: false },
  }
}
