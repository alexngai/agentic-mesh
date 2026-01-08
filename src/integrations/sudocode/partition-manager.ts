// PartitionManager - Partition project into sub-namespaces for selective sync
// Implements: i-409n

import { EventEmitter } from 'events'
import picomatch from 'picomatch'
import type {
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
  SudocodeEntityType,
} from './types'

// =============================================================================
// Partition Configuration Types
// =============================================================================

/**
 * Entity types that can be partitioned.
 */
export type PartitionableEntityType = 'specs' | 'issues'

/**
 * Rule for matching entities to partitions.
 */
export interface PartitionRule {
  /** Name of the partition this rule routes to */
  partition: string
  /** Match criteria - all specified conditions must match (AND logic) */
  match: {
    /** Only match these entity types */
    entityType?: PartitionableEntityType[]
    /** ID glob pattern */
    idPattern?: string
    /** Match entities with any of these tags (OR logic) */
    tags?: string[]
    /** Match by attribute path and value */
    attribute?: {
      path: string
      value: unknown
    }
  }
  /** Priority for rule ordering (higher = checked first, default: 0) */
  priority?: number
}

/**
 * Configuration for namespace partitioning.
 */
export interface PartitionConfig {
  /** Enable partitioning (default: false) */
  enabled: boolean
  /** Rules for routing entities to partitions */
  rules: PartitionRule[]
  /** Default partition for entities that don't match any rule */
  defaultPartition?: string
  /** Which partitions this peer subscribes to (syncs with) */
  subscriptions?: string[]
}

/**
 * Result of partition resolution for an entity.
 */
export interface PartitionResult {
  /** Primary partition for the entity */
  partition: string
  /** Whether this partition is subscribed to */
  subscribed: boolean
  /** Rule that matched (null if default partition used) */
  matchedRule: PartitionRule | null
}

/**
 * Information about a partition.
 */
export interface PartitionInfo {
  /** Partition name */
  name: string
  /** Full namespace including project ID */
  namespace: string
  /** Whether this partition is subscribed to */
  subscribed: boolean
  /** Entity count (if tracking enabled) */
  entityCount?: number
}

// =============================================================================
// PartitionManager
// =============================================================================

const DEFAULT_PARTITION = 'default'

/**
 * Manages namespace partitioning for selective sync.
 * Routes entities to partitions based on configurable rules.
 */
export class PartitionManager extends EventEmitter {
  private config: PartitionConfig
  private projectId: string
  private sortedRules: PartitionRule[] = []
  private compiledMatchers: Map<string, (id: string) => boolean> = new Map()
  private subscriptions: Set<string>
  private knownPartitions: Set<string> = new Set()

  constructor(projectId: string, config?: PartitionConfig) {
    super()
    this.projectId = projectId
    this.config = config ?? { enabled: false, rules: [] }
    this.subscriptions = new Set(config?.subscriptions ?? [])

    if (this.config.enabled) {
      this.compileRules()
    }

    // Always include default partition
    const defaultPartition = this.config.defaultPartition ?? DEFAULT_PARTITION
    this.knownPartitions.add(defaultPartition)
    if (this.subscriptions.size === 0) {
      // If no subscriptions specified, subscribe to default
      this.subscriptions.add(defaultPartition)
    }
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Check if partitioning is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled
  }

  /**
   * Get the default partition name.
   */
  get defaultPartition(): string {
    return this.config.defaultPartition ?? DEFAULT_PARTITION
  }

  /**
   * Get list of subscribed partitions.
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions)
  }

  /**
   * Check if a partition is subscribed.
   */
  isSubscribed(partition: string): boolean {
    return this.subscriptions.has(partition)
  }

  /**
   * Subscribe to a partition.
   */
  subscribe(partition: string): void {
    if (!this.subscriptions.has(partition)) {
      this.subscriptions.add(partition)
      this.knownPartitions.add(partition)
      this.emit('partition:subscribed', { partition })
    }
  }

  /**
   * Unsubscribe from a partition.
   */
  unsubscribe(partition: string): void {
    if (this.subscriptions.has(partition)) {
      this.subscriptions.delete(partition)
      this.emit('partition:unsubscribed', { partition })
    }
  }

  /**
   * Get all known partitions.
   */
  getKnownPartitions(): PartitionInfo[] {
    return Array.from(this.knownPartitions).map((name) => ({
      name,
      namespace: this.getNamespace(name),
      subscribed: this.subscriptions.has(name),
    }))
  }

  /**
   * Update partition configuration at runtime.
   */
  setConfig(config: PartitionConfig): void {
    this.config = config
    this.subscriptions = new Set(config.subscriptions ?? [])

    if (config.enabled) {
      this.compileRules()
    } else {
      this.sortedRules = []
      this.compiledMatchers.clear()
    }

    // Ensure default partition is known and subscribed if no others
    const defaultPartition = config.defaultPartition ?? DEFAULT_PARTITION
    this.knownPartitions.add(defaultPartition)
    if (this.subscriptions.size === 0) {
      this.subscriptions.add(defaultPartition)
    }

    this.emit('config:changed', config)
  }

  // ===========================================================================
  // Namespace Generation
  // ===========================================================================

  /**
   * Get the full namespace for a partition.
   * Format: sudocode:{projectId}:{partition}
   */
  getNamespace(partition: string): string {
    return `sudocode:${this.projectId}:${partition}`
  }

  /**
   * Extract partition name from a namespace.
   */
  parseNamespace(namespace: string): string | null {
    const prefix = `sudocode:${this.projectId}:`
    if (namespace.startsWith(prefix)) {
      return namespace.slice(prefix.length)
    }
    return null
  }

  // ===========================================================================
  // Entity Routing
  // ===========================================================================

  /**
   * Resolve which partition an entity belongs to.
   */
  resolvePartition(
    entityType: SudocodeEntityType,
    entity: SpecCRDT | IssueCRDT | RelationshipCRDT | FeedbackCRDT
  ): PartitionResult {
    // If partitioning is disabled, use default
    if (!this.config.enabled) {
      return {
        partition: this.defaultPartition,
        subscribed: this.isSubscribed(this.defaultPartition),
        matchedRule: null,
      }
    }

    // Relationships and feedback follow their target entities
    if (entityType === 'relationship' || entityType === 'feedback') {
      return {
        partition: this.defaultPartition,
        subscribed: this.isSubscribed(this.defaultPartition),
        matchedRule: null,
      }
    }

    // Try to match against rules
    for (const rule of this.sortedRules) {
      if (this.matchRule(rule, entityType, entity as SpecCRDT | IssueCRDT)) {
        this.knownPartitions.add(rule.partition)
        return {
          partition: rule.partition,
          subscribed: this.isSubscribed(rule.partition),
          matchedRule: rule,
        }
      }
    }

    // No rule matched, use default
    return {
      partition: this.defaultPartition,
      subscribed: this.isSubscribed(this.defaultPartition),
      matchedRule: null,
    }
  }

  /**
   * Resolve partition for a spec.
   */
  resolveSpecPartition(spec: SpecCRDT): PartitionResult {
    return this.resolvePartition('spec', spec)
  }

  /**
   * Resolve partition for an issue.
   */
  resolveIssuePartition(issue: IssueCRDT): PartitionResult {
    return this.resolvePartition('issue', issue)
  }

  /**
   * Resolve partitions for a relationship.
   * May return multiple partitions if entities are in different partitions.
   */
  resolveRelationshipPartitions(
    relationship: RelationshipCRDT,
    fromEntity?: SpecCRDT | IssueCRDT,
    toEntity?: SpecCRDT | IssueCRDT
  ): string[] {
    if (!this.config.enabled) {
      return [this.defaultPartition]
    }

    const partitions = new Set<string>()

    // If we have the source entity, use its partition
    if (fromEntity) {
      const fromType = relationship.from_type === 'spec' ? 'spec' : 'issue'
      const result = this.resolvePartition(fromType, fromEntity)
      partitions.add(result.partition)
    }

    // If we have the target entity, use its partition
    if (toEntity) {
      const toType = relationship.to_type === 'spec' ? 'spec' : 'issue'
      const result = this.resolvePartition(toType, toEntity)
      partitions.add(result.partition)
    }

    // If no entities provided, use default
    if (partitions.size === 0) {
      partitions.add(this.defaultPartition)
    }

    return Array.from(partitions)
  }

  /**
   * Check if an entity should be synced based on partition subscriptions.
   */
  shouldSync(
    entityType: SudocodeEntityType,
    entity: SpecCRDT | IssueCRDT | RelationshipCRDT | FeedbackCRDT
  ): boolean {
    const result = this.resolvePartition(entityType, entity)
    return result.subscribed
  }

  // ===========================================================================
  // Rule Matching
  // ===========================================================================

  private compileRules(): void {
    // Sort rules by priority (higher first)
    this.sortedRules = [...this.config.rules].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    )

    // Pre-compile ID pattern matchers
    this.compiledMatchers.clear()
    for (const rule of this.sortedRules) {
      if (rule.match.idPattern) {
        const matcher = picomatch(rule.match.idPattern)
        this.compiledMatchers.set(rule.partition + ':' + rule.match.idPattern, matcher)
      }
      // Track known partitions
      this.knownPartitions.add(rule.partition)
    }
  }

  private matchRule(
    rule: PartitionRule,
    entityType: SudocodeEntityType,
    entity: SpecCRDT | IssueCRDT
  ): boolean {
    const match = rule.match

    // Check entity type
    if (match.entityType && match.entityType.length > 0) {
      const mappedType = entityType === 'spec' ? 'specs' : 'issues'
      if (!match.entityType.includes(mappedType as PartitionableEntityType)) {
        return false
      }
    }

    // Check ID pattern
    if (match.idPattern) {
      const key = rule.partition + ':' + match.idPattern
      const matcher = this.compiledMatchers.get(key)
      if (matcher && !matcher(entity.id)) {
        return false
      }
    }

    // Check tags (entity needs tags field - we'll use a convention)
    // Note: CRDT types don't have tags, but we can check if entity has them
    if (match.tags && match.tags.length > 0) {
      // For now, skip tag matching as CRDT types don't have tags
      // In future, this could be extended
    }

    // Check attribute
    if (match.attribute) {
      const value = this.getNestedValue(entity, match.attribute.path)
      if (value !== match.attribute.value) {
        return false
      }
    }

    return true
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    const parts = path.split('.')
    let current: unknown = obj
    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined
      }
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }
}

// =============================================================================
// Factory Helpers
// =============================================================================

/**
 * Create a partition config that routes by ID prefix.
 */
export function createPrefixPartitionConfig(
  prefixes: Record<string, string>,
  defaultPartition = 'shared'
): PartitionConfig {
  const rules: PartitionRule[] = Object.entries(prefixes).map(([prefix, partition]) => ({
    partition,
    match: { idPattern: `${prefix}*` },
  }))

  return {
    enabled: true,
    rules,
    defaultPartition,
  }
}

/**
 * Create a partition config that routes specs and issues to different partitions.
 */
export function createEntityTypePartitionConfig(
  specPartition: string,
  issuePartition: string
): PartitionConfig {
  return {
    enabled: true,
    rules: [
      { partition: specPartition, match: { entityType: ['specs'] } },
      { partition: issuePartition, match: { entityType: ['issues'] } },
    ],
    defaultPartition: specPartition,
  }
}

/**
 * Create a partition config that routes by priority.
 */
export function createPriorityPartitionConfig(
  highPriorityPartition: string,
  lowPriorityPartition: string,
  threshold = 2
): PartitionConfig {
  return {
    enabled: true,
    rules: [
      {
        partition: highPriorityPartition,
        match: { attribute: { path: 'priority', value: 0 } },
        priority: 10,
      },
      {
        partition: highPriorityPartition,
        match: { attribute: { path: 'priority', value: 1 } },
        priority: 10,
      },
    ],
    defaultPartition: lowPriorityPartition,
  }
}
