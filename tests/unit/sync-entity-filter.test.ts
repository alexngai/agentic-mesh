import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

// Mock NebulaMesh to avoid creating real network connections
vi.mock('../../src/mesh/nebula-mesh', () => {
  const { EventEmitter } = require('events')

  class MockNebulaMesh extends EventEmitter {
    config: unknown
    _connected = false
    private channels = new Map<string, MockChannel>()
    private namespaces = new Set<string>()

    constructor(config: unknown) {
      super()
      this.config = config
    }

    async connect() {
      this._connected = true
    }

    async disconnect() {
      this._connected = false
    }

    get connected() {
      return this._connected
    }

    getPeers() {
      return []
    }

    async registerNamespace(namespace: string) {
      this.namespaces.add(namespace)
    }

    async unregisterNamespace(namespace: string) {
      this.namespaces.delete(namespace)
    }

    getActiveNamespaces() {
      return new Map(Array.from(this.namespaces).map((ns) => [ns, { namespace: ns }]))
    }

    createChannel(namespace: string) {
      if (!this.channels.has(namespace)) {
        this.channels.set(namespace, new MockChannel())
      }
      return this.channels.get(namespace)
    }
  }

  class MockChannel extends EventEmitter {
    private _opened = false

    async open() {
      this._opened = true
    }

    async close() {
      this._opened = false
    }

    get opened() {
      return this._opened
    }

    send() {
      return true
    }

    broadcast() {}
  }

  return {
    NebulaMesh: MockNebulaMesh,
  }
})

import { SudocodeMeshService } from '../../src/integrations/sudocode/service'
import {
  ALL_SYNCABLE_ENTITIES,
  type SpecCRDT,
  type IssueCRDT,
  type RelationshipCRDT,
  type FeedbackCRDT,
} from '../../src/integrations/sudocode/types'

describe('Selective Sync - Entity Type Filtering', () => {
  let service: SudocodeMeshService
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-filter-test-'))
    const sudocodeDir = path.join(tempDir, '.sudocode')
    await fs.mkdir(sudocodeDir, { recursive: true })

    // Create empty JSONL files
    await fs.writeFile(path.join(sudocodeDir, 'specs.jsonl'), '')
    await fs.writeFile(path.join(sudocodeDir, 'issues.jsonl'), '')
  })

  afterEach(async () => {
    if (service?.connected) {
      await service.disconnect()
    }
    await fs.rm(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  describe('configuration', () => {
    it('should default to syncing all entity types', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
      })

      expect(service.getSyncedEntityTypes()).toEqual(
        expect.arrayContaining(ALL_SYNCABLE_ENTITIES)
      )
      expect(service.getSyncedEntityTypes()).toHaveLength(ALL_SYNCABLE_ENTITIES.length)
    })

    it('should respect custom syncEntities config', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs', 'issues'],
      })

      expect(service.getSyncedEntityTypes()).toEqual(
        expect.arrayContaining(['specs', 'issues'])
      )
      expect(service.getSyncedEntityTypes()).toHaveLength(2)
    })

    it('should correctly report enabled entity types', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs'],
      })

      expect(service.shouldSyncEntityType('specs')).toBe(true)
      expect(service.shouldSyncEntityType('issues')).toBe(false)
      expect(service.shouldSyncEntityType('relationships')).toBe(false)
      expect(service.shouldSyncEntityType('feedback')).toBe(false)
    })

    it('should allow empty syncEntities (sync nothing)', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: [],
      })

      expect(service.getSyncedEntityTypes()).toHaveLength(0)
      expect(service.shouldSyncEntityType('specs')).toBe(false)
      expect(service.shouldSyncEntityType('issues')).toBe(false)
    })
  })

  describe('write filtering', () => {
    it('should sync specs when enabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs'],
      })

      await service.connect()

      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Spec',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Should not throw, should add to CRDT
      service.syncSpec(spec)
      expect(service.getSpec('s-test1')).toBeDefined()
    })

    it('should skip syncing specs when disabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['issues'], // specs not included
      })

      await service.connect()

      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Spec',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Should not throw, but should not add to CRDT
      service.syncSpec(spec)
      expect(service.getSpec('s-test1')).toBeUndefined()
    })

    it('should sync issues when enabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['issues'],
      })

      await service.connect()

      const issue: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-2',
        title: 'Test Issue',
        status: 'open',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      service.syncIssue(issue)
      expect(service.getIssue('i-test1')).toBeDefined()
    })

    it('should skip syncing issues when disabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs'], // issues not included
      })

      await service.connect()

      const issue: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-2',
        title: 'Test Issue',
        status: 'open',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      service.syncIssue(issue)
      expect(service.getIssue('i-test1')).toBeUndefined()
    })

    it('should skip syncing relationships when disabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs', 'issues'], // relationships not included
      })

      await service.connect()

      const relationship: RelationshipCRDT = {
        from_id: 'i-test1',
        from_uuid: 'uuid-1',
        from_type: 'issue',
        to_id: 's-test1',
        to_uuid: 'uuid-2',
        to_type: 'spec',
        relationship_type: 'implements',
        created_at: new Date().toISOString(),
      }

      service.syncRelationship(relationship)
      expect(service.getAllRelationships()).toHaveLength(0)
    })

    it('should skip syncing feedback when disabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs', 'issues'], // feedback not included
      })

      await service.connect()

      const feedback: FeedbackCRDT = {
        id: 'fb-test1',
        to_id: 's-test1',
        to_uuid: 'uuid-1',
        feedback_type: 'comment',
        content: 'Test feedback',
        dismissed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      service.syncFeedback(feedback)
      expect(service.getAllFeedback()).toHaveLength(0)
    })
  })

  describe('delete filtering', () => {
    it('should skip deleting specs when disabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: [], // All sync disabled
      })

      await service.connect()

      // deleteSpec should not throw even when sync is disabled
      expect(() => service.deleteSpec('s-test1')).not.toThrow()
    })

    it('should skip deleting issues when disabled', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: [],
      })

      await service.connect()

      expect(() => service.deleteIssue('i-test1')).not.toThrow()
    })
  })

  describe('mixed entity types', () => {
    it('should sync only configured entity types', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        syncEntities: ['specs', 'issues'], // No relationships/feedback
      })

      await service.connect()

      // Specs should sync
      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Spec',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      service.syncSpec(spec)
      expect(service.getSpec('s-test1')).toBeDefined()

      // Issues should sync
      const issue: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-2',
        title: 'Test Issue',
        status: 'open',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      service.syncIssue(issue)
      expect(service.getIssue('i-test1')).toBeDefined()

      // Relationships should NOT sync
      const relationship: RelationshipCRDT = {
        from_id: 'i-test1',
        from_uuid: 'uuid-2',
        from_type: 'issue',
        to_id: 's-test1',
        to_uuid: 'uuid-1',
        to_type: 'spec',
        relationship_type: 'implements',
        created_at: new Date().toISOString(),
      }
      service.syncRelationship(relationship)
      expect(service.getAllRelationships()).toHaveLength(0)

      // Feedback should NOT sync
      const feedback: FeedbackCRDT = {
        id: 'fb-test1',
        to_id: 's-test1',
        to_uuid: 'uuid-1',
        feedback_type: 'comment',
        content: 'Test feedback',
        dismissed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      service.syncFeedback(feedback)
      expect(service.getAllFeedback()).toHaveLength(0)
    })
  })

  describe('backward compatibility', () => {
    it('should sync all types when no syncEntities provided', async () => {
      service = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: path.join(tempDir, '.sudocode'),
        meshConfig: {
          peerId: 'test-peer',
          nebulaIp: '127.0.0.1',
          port: 25000,
          peers: [],
        },
        // No syncEntities - should default to all
      })

      await service.connect()

      // All entity types should be enabled
      expect(service.shouldSyncEntityType('specs')).toBe(true)
      expect(service.shouldSyncEntityType('issues')).toBe(true)
      expect(service.shouldSyncEntityType('relationships')).toBe(true)
      expect(service.shouldSyncEntityType('feedback')).toBe(true)

      // All sync operations should work
      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Spec',
        content: 'Test content',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      service.syncSpec(spec)
      expect(service.getSpec('s-test1')).toBeDefined()

      const relationship: RelationshipCRDT = {
        from_id: 'i-test1',
        from_uuid: 'uuid-2',
        from_type: 'issue',
        to_id: 's-test1',
        to_uuid: 'uuid-1',
        to_type: 'spec',
        relationship_type: 'implements',
        created_at: new Date().toISOString(),
      }
      service.syncRelationship(relationship)
      expect(service.getAllRelationships()).toHaveLength(1)
    })
  })
})
