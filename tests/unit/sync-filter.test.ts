import { describe, it, expect } from 'vitest'
import {
  SyncFilterEngine,
  createActiveIssuesFilter,
  createHighPriorityFilter,
  createNonArchivedFilter,
  type SyncFilter,
  type SpecFilterConfig,
  type IssueFilterConfig,
} from '../../src/integrations/sudocode/sync-filter'
import type {
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
} from '../../src/integrations/sudocode/types'

// Test fixtures
const makeSpec = (overrides: Partial<SpecCRDT> = {}): SpecCRDT => ({
  id: 's-test',
  uuid: 'uuid-spec',
  title: 'Test Spec',
  content: 'Test content',
  priority: 2,
  archived: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

const makeIssue = (overrides: Partial<IssueCRDT> = {}): IssueCRDT => ({
  id: 'i-test',
  uuid: 'uuid-issue',
  title: 'Test Issue',
  status: 'open',
  content: 'Test content',
  priority: 2,
  archived: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

const makeRelationship = (
  overrides: Partial<RelationshipCRDT> = {}
): RelationshipCRDT => ({
  from_id: 'i-test',
  from_uuid: 'uuid-1',
  from_type: 'issue',
  to_id: 's-test',
  to_uuid: 'uuid-2',
  to_type: 'spec',
  relationship_type: 'implements',
  created_at: new Date().toISOString(),
  ...overrides,
})

const makeFeedback = (overrides: Partial<FeedbackCRDT> = {}): FeedbackCRDT => ({
  id: 'fb-test',
  to_id: 's-test',
  to_uuid: 'uuid-spec',
  feedback_type: 'comment',
  content: 'Test feedback',
  dismissed: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

describe('SyncFilterEngine', () => {
  describe('default behavior', () => {
    it('should allow all entities when no filter is set', () => {
      const engine = new SyncFilterEngine()

      expect(engine.shouldSyncSpec(makeSpec())).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue())).toBe(true)
      expect(engine.shouldSyncRelationship(makeRelationship())).toBe(true)
      expect(engine.shouldSyncFeedback(makeFeedback())).toBe(true)
    })

    it('should allow all entities when filter is "all"', () => {
      const engine = new SyncFilterEngine({
        specs: 'all',
        issues: 'all',
        relationships: 'all',
        feedback: 'all',
      })

      expect(engine.shouldSyncSpec(makeSpec())).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue())).toBe(true)
    })
  })

  describe('"none" shorthand', () => {
    it('should block all entities of type when set to "none"', () => {
      const engine = new SyncFilterEngine({
        specs: 'none',
        issues: 'none',
        relationships: 'none',
        feedback: 'none',
      })

      expect(engine.shouldSyncSpec(makeSpec())).toBe(false)
      expect(engine.shouldSyncIssue(makeIssue())).toBe(false)
      expect(engine.shouldSyncRelationship(makeRelationship())).toBe(false)
      expect(engine.shouldSyncFeedback(makeFeedback())).toBe(false)
    })
  })

  describe('ID pattern filtering', () => {
    it('should match exact IDs', () => {
      const engine = new SyncFilterEngine({
        specs: ['s-abc', 's-def'],
        issues: ['i-xyz'],
      })

      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abc' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-def' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-other' }))).toBe(false)

      expect(engine.shouldSyncIssue(makeIssue({ id: 'i-xyz' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ id: 'i-other' }))).toBe(false)
    })

    it('should match glob patterns with wildcard', () => {
      const engine = new SyncFilterEngine({
        specs: ['s-abc*'],
        issues: ['i-*-urgent'],
      })

      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abc' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abc123' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abcdef' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-xyz' }))).toBe(false)

      expect(engine.shouldSyncIssue(makeIssue({ id: 'i-task-urgent' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ id: 'i-bug-urgent' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ id: 'i-urgent' }))).toBe(false)
    })

    it('should match glob patterns with question mark', () => {
      const engine = new SyncFilterEngine({
        specs: ['s-???'],
      })

      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abc' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-xyz' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-ab' }))).toBe(false)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abcd' }))).toBe(false)
    })

    it('should match multiple patterns (OR logic)', () => {
      const engine = new SyncFilterEngine({
        specs: ['s-a*', 's-b*', 's-c*'],
      })

      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abc' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-bcd' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-cde' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-def' }))).toBe(false)
    })
  })

  describe('spec attribute filtering', () => {
    it('should filter by priority', () => {
      const engine = new SyncFilterEngine({
        specs: { priority: [0, 1] },
      })

      expect(engine.shouldSyncSpec(makeSpec({ priority: 0 }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 1 }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 2 }))).toBe(false)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 3 }))).toBe(false)
    })

    it('should filter by archived status', () => {
      const engine = new SyncFilterEngine({
        specs: { archived: false },
      })

      expect(engine.shouldSyncSpec(makeSpec({ archived: false }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ archived: true }))).toBe(false)
    })

    it('should combine ID patterns and attributes (AND logic)', () => {
      const engine = new SyncFilterEngine({
        specs: {
          ids: ['s-feature*'],
          priority: [0, 1],
          archived: false,
        },
      })

      // Matches all conditions
      expect(
        engine.shouldSyncSpec(makeSpec({ id: 's-feature-1', priority: 0, archived: false }))
      ).toBe(true)

      // Fails ID pattern
      expect(
        engine.shouldSyncSpec(makeSpec({ id: 's-bug-1', priority: 0, archived: false }))
      ).toBe(false)

      // Fails priority
      expect(
        engine.shouldSyncSpec(makeSpec({ id: 's-feature-1', priority: 3, archived: false }))
      ).toBe(false)

      // Fails archived
      expect(
        engine.shouldSyncSpec(makeSpec({ id: 's-feature-1', priority: 0, archived: true }))
      ).toBe(false)
    })
  })

  describe('issue attribute filtering', () => {
    it('should filter by status', () => {
      const engine = new SyncFilterEngine({
        issues: { status: ['open', 'in_progress'] },
      })

      expect(engine.shouldSyncIssue(makeIssue({ status: 'open' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ status: 'in_progress' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ status: 'blocked' }))).toBe(false)
      expect(engine.shouldSyncIssue(makeIssue({ status: 'closed' }))).toBe(false)
    })

    it('should filter by priority', () => {
      const engine = new SyncFilterEngine({
        issues: { priority: [0] },
      })

      expect(engine.shouldSyncIssue(makeIssue({ priority: 0 }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ priority: 1 }))).toBe(false)
    })

    it('should filter by archived', () => {
      const engine = new SyncFilterEngine({
        issues: { archived: false },
      })

      expect(engine.shouldSyncIssue(makeIssue({ archived: false }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ archived: true }))).toBe(false)
    })

    it('should filter by assignee', () => {
      const engine = new SyncFilterEngine({
        issues: { assignee: ['alice', 'bob'] },
      })

      expect(engine.shouldSyncIssue(makeIssue({ assignee: 'alice' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ assignee: 'bob' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ assignee: 'charlie' }))).toBe(false)
      expect(engine.shouldSyncIssue(makeIssue({ assignee: undefined }))).toBe(false)
    })

    it('should combine multiple issue attributes', () => {
      const engine = new SyncFilterEngine({
        issues: {
          status: ['open', 'in_progress'],
          priority: [0, 1],
          archived: false,
        },
      })

      expect(
        engine.shouldSyncIssue(
          makeIssue({ status: 'open', priority: 0, archived: false })
        )
      ).toBe(true)

      expect(
        engine.shouldSyncIssue(
          makeIssue({ status: 'closed', priority: 0, archived: false })
        )
      ).toBe(false)

      expect(
        engine.shouldSyncIssue(
          makeIssue({ status: 'open', priority: 3, archived: false })
        )
      ).toBe(false)
    })
  })

  describe('relationship filtering', () => {
    it('should filter by relationship type', () => {
      const engine = new SyncFilterEngine({
        relationships: { types: ['implements', 'blocks'] },
      })

      expect(
        engine.shouldSyncRelationship(
          makeRelationship({ relationship_type: 'implements' })
        )
      ).toBe(true)
      expect(
        engine.shouldSyncRelationship(makeRelationship({ relationship_type: 'blocks' }))
      ).toBe(true)
      expect(
        engine.shouldSyncRelationship(
          makeRelationship({ relationship_type: 'references' })
        )
      ).toBe(false)
    })

    it('should filter by fromIds patterns', () => {
      const engine = new SyncFilterEngine({
        relationships: { fromIds: ['i-*'] },
      })

      expect(
        engine.shouldSyncRelationship(makeRelationship({ from_id: 'i-test' }))
      ).toBe(true)
      expect(
        engine.shouldSyncRelationship(makeRelationship({ from_id: 's-test' }))
      ).toBe(false)
    })

    it('should filter by toIds patterns', () => {
      const engine = new SyncFilterEngine({
        relationships: { toIds: ['s-feature*'] },
      })

      expect(
        engine.shouldSyncRelationship(makeRelationship({ to_id: 's-feature-1' }))
      ).toBe(true)
      expect(
        engine.shouldSyncRelationship(makeRelationship({ to_id: 's-bug-1' }))
      ).toBe(false)
    })

    it('should use string array as types shorthand', () => {
      const engine = new SyncFilterEngine({
        relationships: ['implements', 'depends-on'],
      })

      expect(
        engine.shouldSyncRelationship(
          makeRelationship({ relationship_type: 'implements' })
        )
      ).toBe(true)
      expect(
        engine.shouldSyncRelationship(
          makeRelationship({ relationship_type: 'depends-on' })
        )
      ).toBe(true)
      expect(
        engine.shouldSyncRelationship(makeRelationship({ relationship_type: 'related' }))
      ).toBe(false)
    })
  })

  describe('feedback filtering', () => {
    it('should filter by feedback type', () => {
      const engine = new SyncFilterEngine({
        feedback: { types: ['comment', 'suggestion'] },
      })

      expect(
        engine.shouldSyncFeedback(makeFeedback({ feedback_type: 'comment' }))
      ).toBe(true)
      expect(
        engine.shouldSyncFeedback(makeFeedback({ feedback_type: 'suggestion' }))
      ).toBe(true)
      expect(
        engine.shouldSyncFeedback(makeFeedback({ feedback_type: 'request' }))
      ).toBe(false)
    })

    it('should filter by dismissed status', () => {
      const engine = new SyncFilterEngine({
        feedback: { dismissed: false },
      })

      expect(engine.shouldSyncFeedback(makeFeedback({ dismissed: false }))).toBe(true)
      expect(engine.shouldSyncFeedback(makeFeedback({ dismissed: true }))).toBe(false)
    })

    it('should filter by toIds patterns', () => {
      const engine = new SyncFilterEngine({
        feedback: { toIds: ['s-*'] },
      })

      expect(engine.shouldSyncFeedback(makeFeedback({ to_id: 's-test' }))).toBe(true)
      expect(engine.shouldSyncFeedback(makeFeedback({ to_id: 'i-test' }))).toBe(false)
    })
  })

  describe('runtime filter updates', () => {
    it('should update filter at runtime', () => {
      const engine = new SyncFilterEngine()

      // Initially allows all
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-test' }))).toBe(true)

      // Update filter
      engine.setFilter({ specs: ['s-abc*'] })

      // Now filters
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-abc1' }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ id: 's-test' }))).toBe(false)
    })

    it('should update individual entity type filters', () => {
      const engine = new SyncFilterEngine()

      engine.updateSpecFilter({ priority: [0] })
      expect(engine.shouldSyncSpec(makeSpec({ priority: 0 }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 1 }))).toBe(false)

      engine.updateIssueFilter({ status: ['open'] })
      expect(engine.shouldSyncIssue(makeIssue({ status: 'open' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ status: 'closed' }))).toBe(false)
    })

    it('should clear filter to allow all', () => {
      const engine = new SyncFilterEngine({ specs: 'none' })

      expect(engine.shouldSyncSpec(makeSpec())).toBe(false)

      engine.clearFilter()

      expect(engine.shouldSyncSpec(makeSpec())).toBe(true)
    })

    it('should return current filter configuration', () => {
      const filter: SyncFilter = {
        specs: { priority: [0, 1] },
        issues: { status: ['open'] },
      }
      const engine = new SyncFilterEngine(filter)

      const current = engine.getFilter()
      expect(current.specs).toEqual({ priority: [0, 1] })
      expect(current.issues).toEqual({ status: ['open'] })
    })
  })

  describe('factory helpers', () => {
    it('should create active issues filter', () => {
      const filter = createActiveIssuesFilter()
      const engine = new SyncFilterEngine(filter)

      expect(engine.shouldSyncIssue(makeIssue({ status: 'open' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ status: 'in_progress' }))).toBe(true)
      expect(engine.shouldSyncIssue(makeIssue({ status: 'closed' }))).toBe(false)
      expect(engine.shouldSyncIssue(makeIssue({ archived: true, status: 'open' }))).toBe(
        false
      )
    })

    it('should create high priority filter', () => {
      const filter = createHighPriorityFilter()
      const engine = new SyncFilterEngine(filter)

      expect(engine.shouldSyncSpec(makeSpec({ priority: 0 }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 1 }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 2 }))).toBe(false)
      expect(engine.shouldSyncSpec(makeSpec({ priority: 0, archived: true }))).toBe(false)
    })

    it('should create non-archived filter', () => {
      const filter = createNonArchivedFilter()
      const engine = new SyncFilterEngine(filter)

      expect(engine.shouldSyncSpec(makeSpec({ archived: false }))).toBe(true)
      expect(engine.shouldSyncSpec(makeSpec({ archived: true }))).toBe(false)
      expect(engine.shouldSyncFeedback(makeFeedback({ dismissed: false }))).toBe(true)
      expect(engine.shouldSyncFeedback(makeFeedback({ dismissed: true }))).toBe(false)
    })
  })
})
