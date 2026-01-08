// Tests for PartitionManager - Namespace partitioning for selective sync
// Tests: i-409n

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PartitionManager,
  createPrefixPartitionConfig,
  createEntityTypePartitionConfig,
  createPriorityPartitionConfig,
  type PartitionConfig,
  type PartitionRule,
} from '../../src/integrations/sudocode/partition-manager'
import type { SpecCRDT, IssueCRDT, RelationshipCRDT, FeedbackCRDT } from '../../src/integrations/sudocode/types'

describe('PartitionManager', () => {
  const projectId = 'test-project'

  // Test fixtures
  const createSpec = (id: string, priority = 2): SpecCRDT => ({
    id,
    uuid: `uuid-${id}`,
    title: `Test Spec ${id}`,
    content: 'Test content',
    priority,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  const createIssue = (id: string, status = 'open' as const, priority = 2): IssueCRDT => ({
    id,
    uuid: `uuid-${id}`,
    title: `Test Issue ${id}`,
    status,
    content: 'Test content',
    priority,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  const createRelationship = (fromId: string, toId: string): RelationshipCRDT => ({
    from_id: fromId,
    from_uuid: `uuid-${fromId}`,
    from_type: 'spec',
    to_id: toId,
    to_uuid: `uuid-${toId}`,
    to_type: 'issue',
    relationship_type: 'implements',
    created_at: new Date().toISOString(),
  })

  const createFeedback = (id: string, toId: string): FeedbackCRDT => ({
    id,
    to_id: toId,
    to_uuid: `uuid-${toId}`,
    feedback_type: 'comment',
    content: 'Test feedback',
    dismissed: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  describe('Basic Configuration', () => {
    it('should default to disabled partitioning', () => {
      const manager = new PartitionManager(projectId)

      expect(manager.enabled).toBe(false)
      expect(manager.defaultPartition).toBe('default')
    })

    it('should respect enabled flag in config', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [],
      })

      expect(manager.enabled).toBe(true)
    })

    it('should use custom default partition', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [],
        defaultPartition: 'shared',
      })

      expect(manager.defaultPartition).toBe('shared')
    })

    it('should subscribe to default partition if no subscriptions specified', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [],
        defaultPartition: 'shared',
      })

      expect(manager.getSubscriptions()).toContain('shared')
    })

    it('should use specified subscriptions', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [],
        subscriptions: ['team-a', 'team-b'],
      })

      expect(manager.getSubscriptions()).toEqual(['team-a', 'team-b'])
    })
  })

  describe('Namespace Generation', () => {
    it('should generate correct namespace format', () => {
      const manager = new PartitionManager(projectId)

      expect(manager.getNamespace('default')).toBe('sudocode:test-project:default')
      expect(manager.getNamespace('team-a')).toBe('sudocode:test-project:team-a')
    })

    it('should parse namespace correctly', () => {
      const manager = new PartitionManager(projectId)

      expect(manager.parseNamespace('sudocode:test-project:team-a')).toBe('team-a')
      expect(manager.parseNamespace('sudocode:test-project:default')).toBe('default')
    })

    it('should return null for invalid namespace', () => {
      const manager = new PartitionManager(projectId)

      expect(manager.parseNamespace('invalid:namespace')).toBe(null)
      expect(manager.parseNamespace('sudocode:other-project:team-a')).toBe(null)
    })
  })

  describe('Subscription Management', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [],
        subscriptions: ['default'],
      })
    })

    it('should subscribe to a partition', () => {
      manager.subscribe('team-a')

      expect(manager.isSubscribed('team-a')).toBe(true)
      expect(manager.getSubscriptions()).toContain('team-a')
    })

    it('should unsubscribe from a partition', () => {
      manager.subscribe('team-a')
      manager.unsubscribe('team-a')

      expect(manager.isSubscribed('team-a')).toBe(false)
      expect(manager.getSubscriptions()).not.toContain('team-a')
    })

    it('should emit event on subscribe', () => {
      const handler = vi.fn()
      manager.on('partition:subscribed', handler)

      manager.subscribe('team-a')

      expect(handler).toHaveBeenCalledWith({ partition: 'team-a' })
    })

    it('should emit event on unsubscribe', () => {
      manager.subscribe('team-a')

      const handler = vi.fn()
      manager.on('partition:unsubscribed', handler)

      manager.unsubscribe('team-a')

      expect(handler).toHaveBeenCalledWith({ partition: 'team-a' })
    })

    it('should not emit duplicate subscribe event', () => {
      manager.subscribe('team-a')

      const handler = vi.fn()
      manager.on('partition:subscribed', handler)

      manager.subscribe('team-a') // Already subscribed

      expect(handler).not.toHaveBeenCalled()
    })

    it('should track known partitions', () => {
      manager.subscribe('team-a')
      manager.subscribe('team-b')

      const known = manager.getKnownPartitions()
      const names = known.map((p) => p.name)

      expect(names).toContain('default')
      expect(names).toContain('team-a')
      expect(names).toContain('team-b')
    })
  })

  describe('Entity Routing - Disabled Partitioning', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId) // Partitioning disabled
    })

    it('should route all specs to default partition', () => {
      const spec = createSpec('s-abc')
      const result = manager.resolveSpecPartition(spec)

      expect(result.partition).toBe('default')
      expect(result.subscribed).toBe(true)
      expect(result.matchedRule).toBe(null)
    })

    it('should route all issues to default partition', () => {
      const issue = createIssue('i-xyz')
      const result = manager.resolveIssuePartition(issue)

      expect(result.partition).toBe('default')
      expect(result.subscribed).toBe(true)
    })

    it('should sync all entities when disabled', () => {
      const spec = createSpec('s-abc')
      const issue = createIssue('i-xyz')

      expect(manager.shouldSync('spec', spec)).toBe(true)
      expect(manager.shouldSync('issue', issue)).toBe(true)
    })
  })

  describe('Entity Routing - ID Pattern Rules', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [
          { partition: 'team-a', match: { idPattern: 's-a*' } },
          { partition: 'team-b', match: { idPattern: 's-b*' } },
          { partition: 'team-a', match: { idPattern: 'i-a*' } },
        ],
        defaultPartition: 'shared',
        subscriptions: ['team-a', 'shared'],
      })
    })

    it('should route spec by ID pattern', () => {
      const specA = createSpec('s-a123')
      const specB = createSpec('s-b456')
      const specOther = createSpec('s-xyz')

      expect(manager.resolveSpecPartition(specA).partition).toBe('team-a')
      expect(manager.resolveSpecPartition(specB).partition).toBe('team-b')
      expect(manager.resolveSpecPartition(specOther).partition).toBe('shared')
    })

    it('should route issue by ID pattern', () => {
      const issueA = createIssue('i-a123')
      const issueOther = createIssue('i-xyz')

      expect(manager.resolveIssuePartition(issueA).partition).toBe('team-a')
      expect(manager.resolveIssuePartition(issueOther).partition).toBe('shared')
    })

    it('should indicate subscription status in result', () => {
      const specA = createSpec('s-a123')
      const specB = createSpec('s-b456')

      const resultA = manager.resolveSpecPartition(specA)
      const resultB = manager.resolveSpecPartition(specB)

      expect(resultA.subscribed).toBe(true) // team-a is subscribed
      expect(resultB.subscribed).toBe(false) // team-b is not subscribed
    })

    it('should include matched rule in result', () => {
      const spec = createSpec('s-a123')
      const result = manager.resolveSpecPartition(spec)

      expect(result.matchedRule).not.toBe(null)
      expect(result.matchedRule?.partition).toBe('team-a')
      expect(result.matchedRule?.match.idPattern).toBe('s-a*')
    })
  })

  describe('Entity Routing - Entity Type Rules', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [
          { partition: 'specs-partition', match: { entityType: ['specs'] } },
          { partition: 'issues-partition', match: { entityType: ['issues'] } },
        ],
        defaultPartition: 'shared',
        subscriptions: ['specs-partition'],
      })
    })

    it('should route by entity type', () => {
      const spec = createSpec('s-abc')
      const issue = createIssue('i-xyz')

      expect(manager.resolveSpecPartition(spec).partition).toBe('specs-partition')
      expect(manager.resolveIssuePartition(issue).partition).toBe('issues-partition')
    })
  })

  describe('Entity Routing - Attribute Rules', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [
          { partition: 'critical', match: { attribute: { path: 'priority', value: 0 } } },
          { partition: 'high', match: { attribute: { path: 'priority', value: 1 } } },
        ],
        defaultPartition: 'normal',
        subscriptions: ['critical', 'high', 'normal'],
      })
    })

    it('should route by attribute value', () => {
      const critical = createSpec('s-crit', 0)
      const high = createSpec('s-high', 1)
      const normal = createSpec('s-norm', 2)

      expect(manager.resolveSpecPartition(critical).partition).toBe('critical')
      expect(manager.resolveSpecPartition(high).partition).toBe('high')
      expect(manager.resolveSpecPartition(normal).partition).toBe('normal')
    })

    it('should route issue by attribute value', () => {
      const critical = createIssue('i-crit', 'open', 0)
      const normal = createIssue('i-norm', 'open', 3)

      expect(manager.resolveIssuePartition(critical).partition).toBe('critical')
      expect(manager.resolveIssuePartition(normal).partition).toBe('normal')
    })
  })

  describe('Entity Routing - Rule Priority', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [
          // Lower priority - broader pattern
          { partition: 'general', match: { idPattern: 's-*' }, priority: 0 },
          // Higher priority - specific pattern
          { partition: 'special', match: { idPattern: 's-special-*' }, priority: 10 },
        ],
        defaultPartition: 'default',
        subscriptions: ['general', 'special'],
      })
    })

    it('should respect rule priority', () => {
      const general = createSpec('s-abc')
      const special = createSpec('s-special-123')

      // Both match 's-*', but 's-special-*' has higher priority
      expect(manager.resolveSpecPartition(general).partition).toBe('general')
      expect(manager.resolveSpecPartition(special).partition).toBe('special')
    })
  })

  describe('Entity Routing - Relationships and Feedback', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [{ partition: 'team-a', match: { idPattern: 's-a*' } }],
        defaultPartition: 'shared',
        subscriptions: ['team-a', 'shared'],
      })
    })

    it('should route relationships to default partition', () => {
      const rel = createRelationship('s-a123', 'i-xyz')
      const result = manager.resolvePartition('relationship', rel)

      expect(result.partition).toBe('shared')
    })

    it('should route feedback to default partition', () => {
      const fb = createFeedback('fb-1', 's-a123')
      const result = manager.resolvePartition('feedback', fb)

      expect(result.partition).toBe('shared')
    })

    it('should resolve relationship partitions with entity context', () => {
      const rel = createRelationship('s-a123', 'i-xyz')
      const fromSpec = createSpec('s-a123')
      const toIssue = createIssue('i-xyz')

      const partitions = manager.resolveRelationshipPartitions(rel, fromSpec, toIssue)

      // Should include both team-a (from spec) and shared (from issue default)
      expect(partitions).toContain('team-a')
      expect(partitions).toContain('shared')
    })
  })

  describe('shouldSync', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [
          { partition: 'team-a', match: { idPattern: 's-a*' } },
          { partition: 'team-b', match: { idPattern: 's-b*' } },
        ],
        defaultPartition: 'shared',
        subscriptions: ['team-a'], // Only subscribed to team-a
      })
    })

    it('should sync entities in subscribed partitions', () => {
      const specA = createSpec('s-a123')

      expect(manager.shouldSync('spec', specA)).toBe(true)
    })

    it('should not sync entities in unsubscribed partitions', () => {
      const specB = createSpec('s-b456')

      expect(manager.shouldSync('spec', specB)).toBe(false)
    })

    it('should not sync entities in default if not subscribed', () => {
      const specOther = createSpec('s-xyz')

      expect(manager.shouldSync('spec', specOther)).toBe(false)
    })
  })

  describe('Runtime Configuration', () => {
    let manager: PartitionManager

    beforeEach(() => {
      manager = new PartitionManager(projectId)
    })

    it('should update config at runtime', () => {
      const newConfig: PartitionConfig = {
        enabled: true,
        rules: [{ partition: 'team-a', match: { idPattern: 's-a*' } }],
        subscriptions: ['team-a'],
      }

      manager.setConfig(newConfig)

      expect(manager.enabled).toBe(true)
      expect(manager.getSubscriptions()).toEqual(['team-a'])
    })

    it('should emit event on config change', () => {
      const handler = vi.fn()
      manager.on('config:changed', handler)

      const newConfig: PartitionConfig = {
        enabled: true,
        rules: [],
      }

      manager.setConfig(newConfig)

      expect(handler).toHaveBeenCalledWith(newConfig)
    })

    it('should recompile rules on config change', () => {
      // Initially disabled
      const spec = createSpec('s-a123')
      expect(manager.resolveSpecPartition(spec).partition).toBe('default')

      // Enable with rules
      manager.setConfig({
        enabled: true,
        rules: [{ partition: 'team-a', match: { idPattern: 's-a*' } }],
        subscriptions: ['team-a'],
      })

      expect(manager.resolveSpecPartition(spec).partition).toBe('team-a')
    })
  })

  describe('Factory Helpers', () => {
    describe('createPrefixPartitionConfig', () => {
      it('should create config for prefix-based partitioning', () => {
        const config = createPrefixPartitionConfig({
          'team-a-': 'team-a',
          'team-b-': 'team-b',
        })

        expect(config.enabled).toBe(true)
        expect(config.defaultPartition).toBe('shared')
        expect(config.rules).toHaveLength(2)
      })

      it('should route by prefix', () => {
        const config = createPrefixPartitionConfig({
          'team-a-': 'team-a',
        })

        const manager = new PartitionManager(projectId, {
          ...config,
          subscriptions: ['team-a', 'shared'],
        })

        const specA = createSpec('team-a-123')
        const specOther = createSpec('other-123')

        expect(manager.resolveSpecPartition(specA).partition).toBe('team-a')
        expect(manager.resolveSpecPartition(specOther).partition).toBe('shared')
      })
    })

    describe('createEntityTypePartitionConfig', () => {
      it('should create config for entity type partitioning', () => {
        const config = createEntityTypePartitionConfig('specs-ns', 'issues-ns')

        expect(config.enabled).toBe(true)
        expect(config.rules).toHaveLength(2)
        expect(config.defaultPartition).toBe('specs-ns')
      })

      it('should route by entity type', () => {
        const config = createEntityTypePartitionConfig('specs-ns', 'issues-ns')
        const manager = new PartitionManager(projectId, {
          ...config,
          subscriptions: ['specs-ns', 'issues-ns'],
        })

        const spec = createSpec('s-abc')
        const issue = createIssue('i-xyz')

        expect(manager.resolveSpecPartition(spec).partition).toBe('specs-ns')
        expect(manager.resolveIssuePartition(issue).partition).toBe('issues-ns')
      })
    })

    describe('createPriorityPartitionConfig', () => {
      it('should create config for priority-based partitioning', () => {
        const config = createPriorityPartitionConfig('urgent', 'backlog')

        expect(config.enabled).toBe(true)
        expect(config.rules).toHaveLength(2)
        expect(config.defaultPartition).toBe('backlog')
      })

      it('should route by priority', () => {
        const config = createPriorityPartitionConfig('urgent', 'backlog')
        const manager = new PartitionManager(projectId, {
          ...config,
          subscriptions: ['urgent', 'backlog'],
        })

        const critical = createSpec('s-crit', 0)
        const high = createSpec('s-high', 1)
        const normal = createSpec('s-norm', 2)

        expect(manager.resolveSpecPartition(critical).partition).toBe('urgent')
        expect(manager.resolveSpecPartition(high).partition).toBe('urgent')
        expect(manager.resolveSpecPartition(normal).partition).toBe('backlog')
      })
    })
  })

  describe('Known Partitions Tracking', () => {
    it('should track partitions from rules', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [
          { partition: 'team-a', match: { idPattern: 's-a*' } },
          { partition: 'team-b', match: { idPattern: 's-b*' } },
        ],
        defaultPartition: 'shared',
      })

      const known = manager.getKnownPartitions()
      const names = known.map((p) => p.name)

      expect(names).toContain('team-a')
      expect(names).toContain('team-b')
      expect(names).toContain('shared')
    })

    it('should track partitions discovered during routing', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [{ partition: 'dynamic', match: { idPattern: 's-dyn*' } }],
        subscriptions: ['dynamic'],
      })

      // Route entity - should discover the partition
      const spec = createSpec('s-dyn123')
      manager.resolveSpecPartition(spec)

      const known = manager.getKnownPartitions()
      const names = known.map((p) => p.name)

      expect(names).toContain('dynamic')
    })

    it('should include namespace in partition info', () => {
      const manager = new PartitionManager(projectId, {
        enabled: true,
        rules: [{ partition: 'team-a', match: { idPattern: 's-a*' } }],
        subscriptions: ['team-a'],
      })

      const known = manager.getKnownPartitions()
      const teamA = known.find((p) => p.name === 'team-a')

      expect(teamA?.namespace).toBe('sudocode:test-project:team-a')
      expect(teamA?.subscribed).toBe(true)
    })
  })
})
