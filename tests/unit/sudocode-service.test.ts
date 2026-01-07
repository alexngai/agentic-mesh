import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SudocodeMeshService } from '../../src/integrations/sudocode/service'
import type { SpecCRDT, IssueCRDT, RelationshipCRDT, FeedbackCRDT } from '../../src/integrations/sudocode/types'

describe('SudocodeMeshService', () => {
  let tmpDir: string
  let service: SudocodeMeshService

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'sudocode-service-test-' + Date.now())
    await fs.mkdir(path.join(tmpDir, 'mesh'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), '')
    await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), '')
  })

  afterEach(async () => {
    if (service?.connected) {
      await service.disconnect()
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('Lifecycle', () => {
    it('should start disconnected', () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18946,
          peers: [],
        },
      })

      expect(service.connected).toBe(false)
    })

    it('should connect and set connected state', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18947,
          peers: [],
        },
      })

      await service.connect()

      expect(service.connected).toBe(true)
    })

    it('should emit connected event on connect', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18948,
          peers: [],
        },
      })

      const connectedHandler = vi.fn()
      service.on('connected', connectedHandler)

      await service.connect()

      expect(connectedHandler).toHaveBeenCalledTimes(1)
    })

    it('should emit disconnected event on disconnect', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18949,
          peers: [],
        },
      })

      await service.connect()

      const disconnectedHandler = vi.fn()
      service.on('disconnected', disconnectedHandler)

      await service.disconnect()

      expect(disconnectedHandler).toHaveBeenCalledTimes(1)
      expect(service.connected).toBe(false)
    })

    it('should be idempotent for multiple connect calls', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18950,
          peers: [],
        },
      })

      await service.connect()
      await service.connect() // Should not throw

      expect(service.connected).toBe(true)
    })

    it('should be idempotent for multiple disconnect calls', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18951,
          peers: [],
        },
      })

      await service.connect()
      await service.disconnect()
      await service.disconnect() // Should not throw

      expect(service.connected).toBe(false)
    })
  })

  describe('Entity Operations', () => {
    beforeEach(async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 18952 + Math.floor(Math.random() * 100),
          peers: [],
        },
      })
      await service.connect()
    })

    describe('Specs', () => {
      it('should sync a spec', () => {
        const spec: SpecCRDT = {
          id: 's-test1',
          uuid: 'uuid-1',
          title: 'Test Spec',
          content: '# Test',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncSpec(spec)

        expect(service.getSpec('s-test1')).toEqual(spec)
      })

      it('should get all specs', () => {
        const spec1: SpecCRDT = {
          id: 's-test1',
          uuid: 'uuid-1',
          title: 'Spec 1',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }
        const spec2: SpecCRDT = {
          id: 's-test2',
          uuid: 'uuid-2',
          title: 'Spec 2',
          content: '',
          priority: 2,
          archived: false,
          created_at: '2024-01-02T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        }

        service.syncSpec(spec1)
        service.syncSpec(spec2)

        const allSpecs = service.getAllSpecs()
        expect(allSpecs).toHaveLength(2)
        expect(allSpecs.map((s) => s.id).sort()).toEqual(['s-test1', 's-test2'])
      })

      it('should update an existing spec', () => {
        const spec: SpecCRDT = {
          id: 's-test1',
          uuid: 'uuid-1',
          title: 'Original Title',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncSpec(spec)
        service.syncSpec({ ...spec, title: 'Updated Title' })

        expect(service.getSpec('s-test1')?.title).toBe('Updated Title')
      })

      it('should delete a spec', () => {
        const spec: SpecCRDT = {
          id: 's-test1',
          uuid: 'uuid-1',
          title: 'Test',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncSpec(spec)
        expect(service.getSpec('s-test1')).toBeDefined()

        service.deleteSpec('s-test1')
        expect(service.getSpec('s-test1')).toBeUndefined()
      })
    })

    describe('Issues', () => {
      it('should sync an issue', () => {
        const issue: IssueCRDT = {
          id: 'i-test1',
          uuid: 'uuid-1',
          title: 'Test Issue',
          status: 'open',
          content: 'Fix the bug',
          priority: 2,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncIssue(issue)

        expect(service.getIssue('i-test1')).toEqual(issue)
      })

      it('should get all issues', () => {
        const issue1: IssueCRDT = {
          id: 'i-test1',
          uuid: 'uuid-1',
          title: 'Issue 1',
          status: 'open',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }
        const issue2: IssueCRDT = {
          id: 'i-test2',
          uuid: 'uuid-2',
          title: 'Issue 2',
          status: 'in_progress',
          content: '',
          priority: 2,
          archived: false,
          created_at: '2024-01-02T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        }

        service.syncIssue(issue1)
        service.syncIssue(issue2)

        const allIssues = service.getAllIssues()
        expect(allIssues).toHaveLength(2)
      })

      it('should update issue status', () => {
        const issue: IssueCRDT = {
          id: 'i-test1',
          uuid: 'uuid-1',
          title: 'Test Issue',
          status: 'open',
          content: '',
          priority: 1,
          archived: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncIssue(issue)
        service.syncIssue({ ...issue, status: 'closed', closed_at: '2024-01-02T00:00:00Z' })

        const updated = service.getIssue('i-test1')
        expect(updated?.status).toBe('closed')
        expect(updated?.closed_at).toBe('2024-01-02T00:00:00Z')
      })

      it('should delete an issue', () => {
        const issue: IssueCRDT = {
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

        service.syncIssue(issue)
        service.deleteIssue('i-test1')

        expect(service.getIssue('i-test1')).toBeUndefined()
      })
    })

    describe('Relationships', () => {
      it('should sync a relationship', () => {
        const rel: RelationshipCRDT = {
          from_id: 'i-issue1',
          from_uuid: 'uuid-issue',
          from_type: 'issue',
          to_id: 's-spec1',
          to_uuid: 'uuid-spec',
          to_type: 'spec',
          relationship_type: 'implements',
          created_at: '2024-01-01T00:00:00Z',
        }

        service.syncRelationship(rel)

        const allRels = service.getAllRelationships()
        expect(allRels).toHaveLength(1)
        expect(allRels[0].relationship_type).toBe('implements')
      })

      it('should delete a relationship', () => {
        const rel: RelationshipCRDT = {
          from_id: 'i-issue1',
          from_uuid: 'uuid-issue',
          from_type: 'issue',
          to_id: 's-spec1',
          to_uuid: 'uuid-spec',
          to_type: 'spec',
          relationship_type: 'blocks',
          created_at: '2024-01-01T00:00:00Z',
        }

        service.syncRelationship(rel)
        expect(service.getAllRelationships()).toHaveLength(1)

        service.deleteRelationship('i-issue1:s-spec1:blocks')
        expect(service.getAllRelationships()).toHaveLength(0)
      })
    })

    describe('Feedback', () => {
      it('should sync feedback', () => {
        const fb: FeedbackCRDT = {
          id: 'fb-test1',
          from_id: 'i-issue1',
          from_uuid: 'uuid-issue',
          to_id: 's-spec1',
          to_uuid: 'uuid-spec',
          feedback_type: 'comment',
          content: 'Implementation complete',
          dismissed: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncFeedback(fb)

        const allFb = service.getAllFeedback()
        expect(allFb).toHaveLength(1)
        expect(allFb[0].content).toBe('Implementation complete')
      })

      it('should delete feedback', () => {
        const fb: FeedbackCRDT = {
          id: 'fb-test1',
          to_id: 's-spec1',
          to_uuid: 'uuid-spec',
          feedback_type: 'suggestion',
          content: 'Consider this approach',
          dismissed: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        }

        service.syncFeedback(fb)
        service.deleteFeedback('fb-test1')

        expect(service.getAllFeedback()).toHaveLength(0)
      })
    })
  })

  describe('Error Handling', () => {
    it('should throw when syncing before connect', () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 19100,
          peers: [],
        },
      })

      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test',
        content: '',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      expect(() => service.syncSpec(spec)).toThrow('Not connected')
    })

    it('should throw when deleting before connect', () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 19101,
          peers: [],
        },
      })

      expect(() => service.deleteSpec('s-test1')).toThrow('Not connected')
    })
  })

  describe('Initial State Loading', () => {
    it('should load existing specs from JSONL on connect', async () => {
      const specLine = JSON.stringify({
        id: 's-existing',
        uuid: 'uuid-existing',
        title: 'Existing Spec',
        file_path: 'specs/s-existing.md',
        content: '# Existing',
        priority: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })
      await fs.writeFile(path.join(tmpDir, 'specs.jsonl'), specLine + '\n')

      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 19102,
          peers: [],
        },
      })

      await service.connect()

      expect(service.getSpec('s-existing')).toBeDefined()
      expect(service.getSpec('s-existing')?.title).toBe('Existing Spec')
    })

    it('should load existing issues from JSONL on connect', async () => {
      const issueLine = JSON.stringify({
        id: 'i-existing',
        uuid: 'uuid-existing',
        title: 'Existing Issue',
        status: 'in_progress',
        content: 'Working on it',
        priority: 2,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        relationships: [],
        tags: [],
      })
      await fs.writeFile(path.join(tmpDir, 'issues.jsonl'), issueLine + '\n')

      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 19103,
          peers: [],
        },
      })

      await service.connect()

      expect(service.getIssue('i-existing')).toBeDefined()
      expect(service.getIssue('i-existing')?.status).toBe('in_progress')
    })
  })

  describe('Events', () => {
    beforeEach(async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: tmpDir,
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 19104 + Math.floor(Math.random() * 100),
          peers: [],
        },
      })
      await service.connect()
    })

    it('should not emit entity:changed for local changes', () => {
      const handler = vi.fn()
      service.on('entity:changed', handler)

      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test',
        content: '',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      service.syncSpec(spec)

      // Local changes should not trigger entity:changed (that's for remote changes)
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
