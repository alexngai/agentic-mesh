import { describe, it, expect } from 'vitest'
import { EntityMapper } from '../../src/integrations/sudocode/mapper'
import type {
  SpecJSONL,
  SpecCRDT,
  IssueJSONL,
  IssueCRDT,
  RelationshipJSONL,
  RelationshipCRDT,
  FeedbackJSONL,
  FeedbackCRDT,
} from '../../src/integrations/sudocode/types'

describe('EntityMapper', () => {
  const mapper = new EntityMapper()

  describe('Spec Mapping', () => {
    const specJSONL: SpecJSONL = {
      id: 's-test1',
      uuid: 'uuid-spec-1',
      title: 'Test Spec',
      file_path: 'specs/s-test1_test_spec.md',
      content: '# Test Spec\n\nThis is a test.',
      priority: 1,
      archived: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      parent_id: 's-parent',
      parent_uuid: 'uuid-parent',
      relationships: [],
      tags: ['test'],
    }

    it('should convert JSONL spec to CRDT', () => {
      const crdt = mapper.specToCRDT(specJSONL)

      expect(crdt.id).toBe('s-test1')
      expect(crdt.uuid).toBe('uuid-spec-1')
      expect(crdt.title).toBe('Test Spec')
      expect(crdt.content).toBe('# Test Spec\n\nThis is a test.')
      expect(crdt.priority).toBe(1)
      expect(crdt.archived).toBe(false)
      expect(crdt.parent_id).toBe('s-parent')
      expect(crdt.parent_uuid).toBe('uuid-parent')
    })

    it('should convert CRDT spec to JSONL', () => {
      const crdt: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-spec-1',
        title: 'Test Spec',
        content: '# Test Spec',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }

      const relationships: RelationshipJSONL[] = [
        { from: 's-test1', from_type: 'spec', to: 'i-issue1', to_type: 'issue', type: 'blocks' },
      ]
      const tags = ['test', 'important']

      const jsonl = mapper.specToJSONL(crdt, relationships, tags)

      expect(jsonl.id).toBe('s-test1')
      expect(jsonl.file_path).toBe('specs/s-test1_test_spec.md')
      expect(jsonl.relationships).toEqual(relationships)
      expect(jsonl.tags).toEqual(tags)
    })

    it('should handle archived=undefined as false', () => {
      const specWithoutArchived: SpecJSONL = {
        ...specJSONL,
        archived: undefined,
      }

      const crdt = mapper.specToCRDT(specWithoutArchived)
      expect(crdt.archived).toBe(false)
    })

    it('should generate valid file paths from titles', () => {
      const crdt: SpecCRDT = {
        id: 's-abc',
        uuid: 'uuid-1',
        title: 'OAuth 2.0 Authentication System!',
        content: '',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      const jsonl = mapper.specToJSONL(crdt, [], [])
      expect(jsonl.file_path).toBe('specs/s-abc_oauth_2_0_authentication_system.md')
    })
  })

  describe('Issue Mapping', () => {
    const issueJSONL: IssueJSONL = {
      id: 'i-test1',
      uuid: 'uuid-issue-1',
      title: 'Test Issue',
      status: 'open',
      content: 'Fix the bug',
      priority: 2,
      assignee: 'user@example.com',
      archived: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      closed_at: undefined,
      parent_id: 'i-parent',
      parent_uuid: 'uuid-parent',
      relationships: [],
      tags: ['bug'],
    }

    it('should convert JSONL issue to CRDT', () => {
      const crdt = mapper.issueToCRDT(issueJSONL)

      expect(crdt.id).toBe('i-test1')
      expect(crdt.uuid).toBe('uuid-issue-1')
      expect(crdt.title).toBe('Test Issue')
      expect(crdt.status).toBe('open')
      expect(crdt.content).toBe('Fix the bug')
      expect(crdt.priority).toBe(2)
      expect(crdt.assignee).toBe('user@example.com')
    })

    it('should convert CRDT issue to JSONL', () => {
      const crdt: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-issue-1',
        title: 'Test Issue',
        status: 'in_progress',
        content: 'Working on it',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }

      const jsonl = mapper.issueToJSONL(crdt, [], ['in-progress'])

      expect(jsonl.id).toBe('i-test1')
      expect(jsonl.status).toBe('in_progress')
      expect(jsonl.tags).toEqual(['in-progress'])
    })

    it('should include feedback when provided', () => {
      const crdt: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-1',
        title: 'Test',
        status: 'open',
        content: '',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      const feedback: FeedbackJSONL[] = [
        {
          id: 'fb-1',
          to_id: 'i-test1',
          feedback_type: 'comment',
          content: 'Looks good',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]

      const jsonl = mapper.issueToJSONL(crdt, [], [], feedback)
      expect(jsonl.feedback).toEqual(feedback)
    })
  })

  describe('Relationship Mapping', () => {
    it('should convert JSONL relationship to CRDT', () => {
      const rel: RelationshipJSONL = {
        from: 'i-test1',
        from_type: 'issue',
        to: 's-spec1',
        to_type: 'spec',
        type: 'implements',
      }

      const crdt = mapper.relationshipToCRDT(rel, 'uuid-issue', 'uuid-spec', '2024-01-01T00:00:00Z')

      expect(crdt.from_id).toBe('i-test1')
      expect(crdt.from_uuid).toBe('uuid-issue')
      expect(crdt.from_type).toBe('issue')
      expect(crdt.to_id).toBe('s-spec1')
      expect(crdt.to_uuid).toBe('uuid-spec')
      expect(crdt.to_type).toBe('spec')
      expect(crdt.relationship_type).toBe('implements')
    })

    it('should convert CRDT relationship to JSONL', () => {
      const crdt: RelationshipCRDT = {
        from_id: 'i-test1',
        from_uuid: 'uuid-issue',
        from_type: 'issue',
        to_id: 's-spec1',
        to_uuid: 'uuid-spec',
        to_type: 'spec',
        relationship_type: 'blocks',
        created_at: '2024-01-01T00:00:00Z',
      }

      const jsonl = mapper.relationshipToJSONL(crdt)

      expect(jsonl.from).toBe('i-test1')
      expect(jsonl.to).toBe('s-spec1')
      expect(jsonl.type).toBe('blocks')
    })
  })

  describe('Feedback Mapping', () => {
    it('should convert JSONL feedback to CRDT', () => {
      const fb: FeedbackJSONL = {
        id: 'fb-test1',
        from_id: 'i-issue1',
        to_id: 's-spec1',
        feedback_type: 'suggestion',
        content: 'Consider adding validation',
        agent: 'claude',
        anchor: { line: 10, text: 'function validate' },
        dismissed: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }

      const crdt = mapper.feedbackToCRDT(fb, 'uuid-spec', 'uuid-issue')

      expect(crdt.id).toBe('fb-test1')
      expect(crdt.from_id).toBe('i-issue1')
      expect(crdt.from_uuid).toBe('uuid-issue')
      expect(crdt.to_id).toBe('s-spec1')
      expect(crdt.to_uuid).toBe('uuid-spec')
      expect(crdt.feedback_type).toBe('suggestion')
      expect(crdt.agent).toBe('claude')
      expect(crdt.anchor).toEqual({ line: 10, text: 'function validate' })
    })

    it('should convert CRDT feedback to JSONL', () => {
      const crdt: FeedbackCRDT = {
        id: 'fb-test1',
        from_id: 'i-issue1',
        from_uuid: 'uuid-issue',
        to_id: 's-spec1',
        to_uuid: 'uuid-spec',
        feedback_type: 'comment',
        content: 'Implementation complete',
        dismissed: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }

      const jsonl = mapper.feedbackToJSONL(crdt)

      expect(jsonl.id).toBe('fb-test1')
      expect(jsonl.from_id).toBe('i-issue1')
      expect(jsonl.to_id).toBe('s-spec1')
      expect(jsonl.dismissed).toBeUndefined() // false should become undefined
    })

    it('should handle dismissed=true', () => {
      const crdt: FeedbackCRDT = {
        id: 'fb-test1',
        to_id: 's-spec1',
        to_uuid: 'uuid-spec',
        feedback_type: 'comment',
        content: 'Dismissed feedback',
        dismissed: true,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }

      const jsonl = mapper.feedbackToJSONL(crdt)
      expect(jsonl.dismissed).toBe(true)
    })

    it('should handle feedback without from_id', () => {
      const fb: FeedbackJSONL = {
        id: 'fb-anon',
        to_id: 's-spec1',
        feedback_type: 'request',
        content: 'Please clarify this section',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      const crdt = mapper.feedbackToCRDT(fb, 'uuid-spec', undefined)

      expect(crdt.from_id).toBeUndefined()
      expect(crdt.from_uuid).toBeUndefined()
    })

    it('should handle feedback without anchor', () => {
      const fb: FeedbackJSONL = {
        id: 'fb-no-anchor',
        to_id: 's-spec1',
        feedback_type: 'comment',
        content: 'General comment',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      const crdt = mapper.feedbackToCRDT(fb, 'uuid-spec', undefined)

      expect(crdt.anchor).toBeUndefined()
    })
  })

  describe('Edge Cases', () => {
    describe('Special Characters in Titles', () => {
      it('should handle emojis in spec titles', () => {
        const crdt: SpecCRDT = {
          id: 's-emoji',
          uuid: 'uuid-1',
          title: '🚀 Launch Feature',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const jsonl = mapper.specToJSONL(crdt, [], [])
        // Emojis should be stripped from file path
        expect(jsonl.file_path).toBe('specs/s-emoji_launch_feature.md')
      })

      it('should handle unicode characters in titles', () => {
        const crdt: SpecCRDT = {
          id: 's-unicode',
          uuid: 'uuid-1',
          title: 'Üñíçödé Spëç',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const jsonl = mapper.specToJSONL(crdt, [], [])
        // Non-ASCII should be stripped - check it produces a valid path
        expect(jsonl.file_path).toMatch(/^specs\/s-unicode_.+\.md$/)
        expect(jsonl.file_path.length).toBeLessThan(100)
      })

      it('should handle very long titles', () => {
        const longTitle = 'A'.repeat(100)
        const crdt: SpecCRDT = {
          id: 's-long',
          uuid: 'uuid-1',
          title: longTitle,
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const jsonl = mapper.specToJSONL(crdt, [], [])
        // Should truncate to 50 chars
        expect(jsonl.file_path.length).toBeLessThan(100)
      })

      it('should handle titles with only special characters', () => {
        const crdt: SpecCRDT = {
          id: 's-special',
          uuid: 'uuid-1',
          title: '!@#$%^&*()',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const jsonl = mapper.specToJSONL(crdt, [], [])
        // Should still produce a valid path
        expect(jsonl.file_path).toBe('specs/s-special_.md')
      })

      it('should handle empty title', () => {
        const crdt: SpecCRDT = {
          id: 's-empty',
          uuid: 'uuid-1',
          title: '',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        const jsonl = mapper.specToJSONL(crdt, [], [])
        expect(jsonl.file_path).toBe('specs/s-empty_.md')
      })
    })

    describe('Empty and Null Values', () => {
      it('should handle empty content', () => {
        const specJSONL: SpecJSONL = {
          id: 's-empty',
          uuid: 'uuid-1',
          title: 'Empty Spec',
          file_path: 'specs/s-empty.md',
          content: '',
          priority: 1,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          relationships: [],
          tags: [],
        }

        const crdt = mapper.specToCRDT(specJSONL)
        expect(crdt.content).toBe('')
      })

      it('should handle undefined optional fields', () => {
        const issueJSONL: IssueJSONL = {
          id: 'i-minimal',
          uuid: 'uuid-1',
          title: 'Minimal Issue',
          status: 'open',
          content: '',
          priority: 1,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          relationships: [],
          tags: [],
          // assignee, parent_id, parent_uuid, etc. are undefined
        }

        const crdt = mapper.issueToCRDT(issueJSONL)
        expect(crdt.assignee).toBeUndefined()
        expect(crdt.parent_id).toBeUndefined()
        expect(crdt.closed_at).toBeUndefined()
      })
    })

    describe('Priority Values', () => {
      it('should handle priority 0 (highest)', () => {
        const specJSONL: SpecJSONL = {
          id: 's-urgent',
          uuid: 'uuid-1',
          title: 'Urgent Spec',
          file_path: 'specs/s-urgent.md',
          content: '',
          priority: 0,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          relationships: [],
          tags: [],
        }

        const crdt = mapper.specToCRDT(specJSONL)
        expect(crdt.priority).toBe(0)
      })

      it('should handle priority 4 (lowest)', () => {
        const specJSONL: SpecJSONL = {
          id: 's-low',
          uuid: 'uuid-1',
          title: 'Low Priority Spec',
          file_path: 'specs/s-low.md',
          content: '',
          priority: 4,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          relationships: [],
          tags: [],
        }

        const crdt = mapper.specToCRDT(specJSONL)
        expect(crdt.priority).toBe(4)
      })
    })

    describe('Relationship Types', () => {
      const allRelationshipTypes = [
        'blocks',
        'implements',
        'references',
        'depends-on',
        'discovered-from',
        'related',
      ]

      allRelationshipTypes.forEach((type) => {
        it(`should handle relationship type: ${type}`, () => {
          const rel: RelationshipJSONL = {
            from: 'i-test1',
            from_type: 'issue',
            to: 's-spec1',
            to_type: 'spec',
            type: type as RelationshipJSONL['type'],
          }

          const crdt = mapper.relationshipToCRDT(
            rel,
            'uuid-issue',
            'uuid-spec',
            '2024-01-01T00:00:00Z'
          )

          expect(crdt.relationship_type).toBe(type)

          const backToJsonl = mapper.relationshipToJSONL(crdt)
          expect(backToJsonl.type).toBe(type)
        })
      })
    })

    describe('Issue Status Transitions', () => {
      const allStatuses = ['open', 'in_progress', 'blocked', 'closed'] as const

      allStatuses.forEach((status) => {
        it(`should handle status: ${status}`, () => {
          const issueJSONL: IssueJSONL = {
            id: 'i-status',
            uuid: 'uuid-1',
            title: 'Status Test',
            status,
            content: '',
            priority: 1,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            relationships: [],
            tags: [],
          }

          const crdt = mapper.issueToCRDT(issueJSONL)
          expect(crdt.status).toBe(status)
        })
      })
    })

    describe('Feedback Types', () => {
      const allFeedbackTypes = ['comment', 'suggestion', 'request'] as const

      allFeedbackTypes.forEach((type) => {
        it(`should handle feedback type: ${type}`, () => {
          const fb: FeedbackJSONL = {
            id: 'fb-type',
            to_id: 's-spec1',
            feedback_type: type,
            content: 'Test feedback',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          }

          const crdt = mapper.feedbackToCRDT(fb, 'uuid-spec', undefined)
          expect(crdt.feedback_type).toBe(type)

          const backToJsonl = mapper.feedbackToJSONL(crdt)
          expect(backToJsonl.feedback_type).toBe(type)
        })
      })
    })
  })
})
