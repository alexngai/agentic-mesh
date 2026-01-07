import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { JSONLBridge } from '../../src/integrations/sudocode/jsonl-bridge'
import type { SpecCRDT, IssueCRDT, RelationshipCRDT, FeedbackCRDT } from '../../src/integrations/sudocode/types'

describe('JSONLBridge', () => {
  let tmpDir: string
  let bridge: JSONLBridge

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'jsonl-bridge-test-' + Date.now())
    await fs.mkdir(tmpDir, { recursive: true })
    bridge = new JSONLBridge(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('loadFromJSONL', () => {
    it('should return empty state for missing files', async () => {
      const state = await bridge.loadFromJSONL()

      expect(state.specs).toEqual([])
      expect(state.issues).toEqual([])
      expect(state.relationships).toEqual([])
      expect(state.feedback).toEqual([])
    })

    it('should load specs from JSONL', async () => {
      const specLine = JSON.stringify({
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Spec',
        file_path: 'specs/s-test1.md',
        content: '# Test',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), '')

      const state = await bridge.loadFromJSONL()

      expect(state.specs).toHaveLength(1)
      expect(state.specs[0].id).toBe('s-test1')
      expect(state.specs[0].title).toBe('Test Spec')
    })

    it('should load issues from JSONL', async () => {
      const issueLine = JSON.stringify({
        id: 'i-test1',
        uuid: 'uuid-1',
        title: 'Test Issue',
        status: 'open',
        content: 'Fix bug',
        priority: 2,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), '')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), issueLine + '\n')

      const state = await bridge.loadFromJSONL()

      expect(state.issues).toHaveLength(1)
      expect(state.issues[0].id).toBe('i-test1')
      expect(state.issues[0].status).toBe('open')
    })

    it('should extract relationships from entities', async () => {
      const specLine = JSON.stringify({
        id: 's-spec1',
        uuid: 'uuid-spec',
        title: 'Spec',
        file_path: 'specs/s-spec1.md',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })

      const issueLine = JSON.stringify({
        id: 'i-issue1',
        uuid: 'uuid-issue',
        title: 'Issue',
        status: 'open',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [
          { from: 'i-issue1', from_type: 'issue', to: 's-spec1', to_type: 'spec', type: 'implements' },
        ],
        tags: [],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), issueLine + '\n')

      const state = await bridge.loadFromJSONL()

      expect(state.relationships).toHaveLength(1)
      expect(state.relationships[0].from_id).toBe('i-issue1')
      expect(state.relationships[0].to_id).toBe('s-spec1')
      expect(state.relationships[0].relationship_type).toBe('implements')
    })

    it('should extract feedback from issues', async () => {
      const issueLine = JSON.stringify({
        id: 'i-issue1',
        uuid: 'uuid-issue',
        title: 'Issue',
        status: 'open',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
        feedback: [
          {
            id: 'fb-1',
            to_id: 'i-issue1',
            feedback_type: 'comment',
            content: 'Good work',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), '')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), issueLine + '\n')

      const state = await bridge.loadFromJSONL()

      expect(state.feedback).toHaveLength(1)
      expect(state.feedback[0].id).toBe('fb-1')
      expect(state.feedback[0].content).toBe('Good work')
    })

    it('should deduplicate relationships that appear in both entities', async () => {
      const specLine = JSON.stringify({
        id: 's-spec1',
        uuid: 'uuid-spec',
        title: 'Spec',
        file_path: 'specs/s-spec1.md',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [
          { from: 's-spec1', from_type: 'spec', to: 'i-issue1', to_type: 'issue', type: 'blocks' },
        ],
        tags: [],
      })

      const issueLine = JSON.stringify({
        id: 'i-issue1',
        uuid: 'uuid-issue',
        title: 'Issue',
        status: 'open',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [
          { from: 's-spec1', from_type: 'spec', to: 'i-issue1', to_type: 'issue', type: 'blocks' },
        ],
        tags: [],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), issueLine + '\n')

      const state = await bridge.loadFromJSONL()

      // Same relationship should only appear once
      expect(state.relationships).toHaveLength(1)
    })
  })

  describe('saveToJSONL', () => {
    it('should save specs to JSONL', async () => {
      const state = {
        specs: [
          {
            id: 's-test1',
            uuid: 'uuid-1',
            title: 'Test Spec',
            content: '# Test',
            priority: 1,
            archived: false,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        ] as SpecCRDT[],
        issues: [] as IssueCRDT[],
        relationships: [] as RelationshipCRDT[],
        feedback: [] as FeedbackCRDT[],
      }

      await bridge.saveToJSONL(state)

      const content = await fs.readFile(path.join(tmpDir, 'specs.jsonl'), 'utf-8')
      const saved = JSON.parse(content.trim())

      expect(saved.id).toBe('s-test1')
      expect(saved.title).toBe('Test Spec')
    })

    it('should save issues to JSONL', async () => {
      const state = {
        specs: [] as SpecCRDT[],
        issues: [
          {
            id: 'i-test1',
            uuid: 'uuid-1',
            title: 'Test Issue',
            status: 'in_progress',
            content: 'Working on it',
            priority: 2,
            archived: false,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        ] as IssueCRDT[],
        relationships: [] as RelationshipCRDT[],
        feedback: [] as FeedbackCRDT[],
      }

      await bridge.saveToJSONL(state)

      const content = await fs.readFile(path.join(tmpDir, 'issues.jsonl'), 'utf-8')
      const saved = JSON.parse(content.trim())

      expect(saved.id).toBe('i-test1')
      expect(saved.status).toBe('in_progress')
    })

    it('should include relationships in entities', async () => {
      const state = {
        specs: [] as SpecCRDT[],
        issues: [
          {
            id: 'i-issue1',
            uuid: 'uuid-issue',
            title: 'Issue',
            status: 'open',
            content: '',
            priority: 1,
            archived: false,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ] as IssueCRDT[],
        relationships: [
          {
            from_id: 'i-issue1',
            from_uuid: 'uuid-issue',
            from_type: 'issue',
            to_id: 's-spec1',
            to_uuid: 'uuid-spec',
            to_type: 'spec',
            relationship_type: 'implements',
            created_at: '2024-01-01T00:00:00Z',
          },
        ] as RelationshipCRDT[],
        feedback: [] as FeedbackCRDT[],
      }

      await bridge.saveToJSONL(state)

      const content = await fs.readFile(path.join(tmpDir, 'issues.jsonl'), 'utf-8')
      const saved = JSON.parse(content.trim())

      expect(saved.relationships).toHaveLength(1)
      expect(saved.relationships[0].type).toBe('implements')
    })

    it('should include feedback on target issues', async () => {
      const state = {
        specs: [] as SpecCRDT[],
        issues: [
          {
            id: 'i-issue1',
            uuid: 'uuid-issue',
            title: 'Issue',
            status: 'open',
            content: '',
            priority: 1,
            archived: false,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ] as IssueCRDT[],
        relationships: [] as RelationshipCRDT[],
        feedback: [
          {
            id: 'fb-1',
            to_id: 'i-issue1',
            to_uuid: 'uuid-issue',
            feedback_type: 'comment',
            content: 'Great work',
            dismissed: false,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ] as FeedbackCRDT[],
      }

      await bridge.saveToJSONL(state)

      const content = await fs.readFile(path.join(tmpDir, 'issues.jsonl'), 'utf-8')
      const saved = JSON.parse(content.trim())

      expect(saved.feedback).toHaveLength(1)
      expect(saved.feedback[0].content).toBe('Great work')
    })

    it('should sort entities by created_at', async () => {
      const state = {
        specs: [
          {
            id: 's-newer',
            uuid: 'uuid-2',
            title: 'Newer Spec',
            content: '',
            priority: 1,
            archived: false,
            created_at: '2024-02-01T00:00:00Z',
            updated_at: '2024-02-01T00:00:00Z',
          },
          {
            id: 's-older',
            uuid: 'uuid-1',
            title: 'Older Spec',
            content: '',
            priority: 1,
            archived: false,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ] as SpecCRDT[],
        issues: [] as IssueCRDT[],
        relationships: [] as RelationshipCRDT[],
        feedback: [] as FeedbackCRDT[],
      }

      await bridge.saveToJSONL(state)

      const content = await fs.readFile(path.join(tmpDir, 'specs.jsonl'), 'utf-8')
      const lines = content.trim().split('\n')

      expect(JSON.parse(lines[0]).id).toBe('s-older')
      expect(JSON.parse(lines[1]).id).toBe('s-newer')
    })
  })

  describe('hasJSONLChanged', () => {
    it('should return false when files have not changed', async () => {
      const specLine = JSON.stringify({
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test',
        file_path: 'specs/s-test1.md',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), '')

      // Load to establish baseline hashes
      await bridge.loadFromJSONL()

      // Check without changes
      const changed = await bridge.hasJSONLChanged()
      expect(changed).toBe(false)
    })

    it('should return true when files have changed', async () => {
      const specLine = JSON.stringify({
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test',
        file_path: 'specs/s-test1.md',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), '')

      // Load to establish baseline hashes
      await bridge.loadFromJSONL()

      // Modify file
      const modifiedSpec = JSON.stringify({
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Modified',
        file_path: 'specs/s-test1.md',
        content: '',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })
      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), modifiedSpec + '\n')

      const changed = await bridge.hasJSONLChanged()
      expect(changed).toBe(true)
    })
  })

  describe('round-trip', () => {
    it('should preserve data through load-save-load cycle', async () => {
      // Create initial JSONL files
      const specLine = JSON.stringify({
        id: 's-test1',
        uuid: 'uuid-spec',
        title: 'Test Spec',
        file_path: 'specs/s-test1.md',
        content: '# Content',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })

      const issueLine = JSON.stringify({
        id: 'i-test1',
        uuid: 'uuid-issue',
        title: 'Test Issue',
        status: 'open',
        content: 'Do something',
        priority: 2,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [
          { from: 'i-test1', from_type: 'issue', to: 's-test1', to_type: 'spec', type: 'implements' },
        ],
        tags: [],
        feedback: [
          {
            id: 'fb-1',
            to_id: 'i-test1',
            feedback_type: 'comment',
            content: 'Looks good',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      })

      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), issueLine + '\n')

      // Load
      const state1 = await bridge.loadFromJSONL()

      // Save
      await bridge.saveToJSONL(state1)

      // Load again
      const state2 = await bridge.loadFromJSONL()

      // Verify data integrity
      expect(state2.specs).toHaveLength(1)
      expect(state2.specs[0].title).toBe('Test Spec')

      expect(state2.issues).toHaveLength(1)
      expect(state2.issues[0].title).toBe('Test Issue')

      expect(state2.relationships).toHaveLength(1)
      expect(state2.relationships[0].relationship_type).toBe('implements')

      expect(state2.feedback).toHaveLength(1)
      expect(state2.feedback[0].content).toBe('Looks good')
    })
  })
})
