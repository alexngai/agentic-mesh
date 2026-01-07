import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SudocodeMeshService } from '../../src/integrations/sudocode/service'
import type {
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
} from '../../src/integrations/sudocode/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Multi-Peer Sync Integration', () => {
  let tmpDir: string
  let projectA: string
  let projectB: string
  let projectC: string
  let serviceA: SudocodeMeshService
  let serviceB: SudocodeMeshService
  let serviceC: SudocodeMeshService
  let basePort: number

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'sync-integration-test-' + Date.now())
    projectA = path.join(tmpDir, 'project-a')
    projectB = path.join(tmpDir, 'project-b')
    projectC = path.join(tmpDir, 'project-c')

    // Create project directories
    for (const dir of [projectA, projectB, projectC]) {
      await fs.mkdir(path.join(dir, 'mesh'), { recursive: true })
      await fs.writeFile(path.join(dir, 'specs.jsonl'), '')
      await fs.writeFile(path.join(dir, 'issues.jsonl'), '')
    }

    // Use unique base port for each test to avoid conflicts
    basePort = 20000 + Math.floor(Math.random() * 10000)
  })

  afterEach(async () => {
    // Wait for any pending debounced saves
    await sleep(600)

    // Disconnect all services sequentially to avoid race conditions
    if (serviceA?.connected) await serviceA.disconnect()
    if (serviceB?.connected) await serviceB.disconnect()
    if (serviceC?.connected) await serviceC.disconnect()

    // Small delay to ensure all writes complete
    await sleep(100)

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('Two-Peer Sync', () => {
    beforeEach(async () => {
      serviceA = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectA,
        meshConfig: {
          peerId: 'peer-a',
          nebulaIp: '127.0.0.1',
          port: basePort,
          peers: [{ id: 'peer-b', nebulaIp: '127.0.0.1', port: basePort + 1 }],
        },
      })

      serviceB = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectB,
        meshConfig: {
          peerId: 'peer-b',
          nebulaIp: '127.0.0.1',
          port: basePort + 1,
          peers: [{ id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort }],
        },
      })

      await Promise.all([serviceA.connect(), serviceB.connect()])
      await sleep(500) // Wait for initial sync
    })

    it('should sync spec from A to B', async () => {
      const spec: SpecCRDT = {
        id: 's-test1',
        uuid: 'uuid-1',
        title: 'Test Spec',
        content: '# Test',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceA.syncSpec(spec)
      await sleep(300)

      const synced = serviceB.getSpec('s-test1')
      expect(synced).toBeDefined()
      expect(synced?.title).toBe('Test Spec')
    })

    it('should sync issue from B to A', async () => {
      const issue: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-1',
        title: 'Test Issue',
        status: 'open',
        content: 'Fix this',
        priority: 2,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceB.syncIssue(issue)
      await sleep(300)

      const synced = serviceA.getIssue('i-test1')
      expect(synced).toBeDefined()
      expect(synced?.title).toBe('Test Issue')
    })

    it('should sync updates bidirectionally', async () => {
      // Create on A
      const issue: IssueCRDT = {
        id: 'i-test1',
        uuid: 'uuid-1',
        title: 'Original Title',
        status: 'open',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      serviceA.syncIssue(issue)
      await sleep(300)

      // Update on B
      const updated = { ...serviceB.getIssue('i-test1')!, status: 'in_progress' as const }
      serviceB.syncIssue(updated)
      await sleep(300)

      // Verify on A
      expect(serviceA.getIssue('i-test1')?.status).toBe('in_progress')
    })

    it('should sync deletions', async () => {
      const spec: SpecCRDT = {
        id: 's-delete-me',
        uuid: 'uuid-delete',
        title: 'To Delete',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceA.syncSpec(spec)
      await sleep(300)
      expect(serviceB.getSpec('s-delete-me')).toBeDefined()

      serviceA.deleteSpec('s-delete-me')
      await sleep(300)
      expect(serviceB.getSpec('s-delete-me')).toBeUndefined()
    })

    it('should sync relationships', async () => {
      // Create entities first
      const spec: SpecCRDT = {
        id: 's-spec1',
        uuid: 'uuid-spec',
        title: 'Spec',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const issue: IssueCRDT = {
        id: 'i-issue1',
        uuid: 'uuid-issue',
        title: 'Issue',
        status: 'open',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceA.syncSpec(spec)
      serviceA.syncIssue(issue)
      await sleep(300)

      // Create relationship on A
      const rel: RelationshipCRDT = {
        from_id: 'i-issue1',
        from_uuid: 'uuid-issue',
        from_type: 'issue',
        to_id: 's-spec1',
        to_uuid: 'uuid-spec',
        to_type: 'spec',
        relationship_type: 'implements',
        created_at: new Date().toISOString(),
      }
      serviceA.syncRelationship(rel)
      await sleep(300)

      // Verify on B
      const synced = serviceB.getAllRelationships()
      expect(synced).toHaveLength(1)
      expect(synced[0].relationship_type).toBe('implements')
    })

    it('should sync feedback', async () => {
      const fb: FeedbackCRDT = {
        id: 'fb-test1',
        to_id: 's-spec1',
        to_uuid: 'uuid-spec',
        feedback_type: 'comment',
        content: 'Looks good!',
        dismissed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceA.syncFeedback(fb)
      await sleep(300)

      const synced = serviceB.getAllFeedback()
      expect(synced).toHaveLength(1)
      expect(synced[0].content).toBe('Looks good!')
    })

    it('should handle rapid sequential updates', async () => {
      const issue: IssueCRDT = {
        id: 'i-rapid',
        uuid: 'uuid-rapid',
        title: 'Rapid Updates',
        status: 'open',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Rapid updates from A
      serviceA.syncIssue(issue)
      serviceA.syncIssue({ ...issue, status: 'in_progress' })
      serviceA.syncIssue({ ...issue, status: 'blocked' })
      serviceA.syncIssue({ ...issue, status: 'closed', closed_at: new Date().toISOString() })

      await sleep(500)

      // Final state should be closed
      expect(serviceB.getIssue('i-rapid')?.status).toBe('closed')
    })

    it('should handle concurrent updates to different entities', async () => {
      // A creates spec, B creates issue simultaneously
      const spec: SpecCRDT = {
        id: 's-concurrent',
        uuid: 'uuid-spec',
        title: 'Concurrent Spec',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const issue: IssueCRDT = {
        id: 'i-concurrent',
        uuid: 'uuid-issue',
        title: 'Concurrent Issue',
        status: 'open',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Concurrent operations
      serviceA.syncSpec(spec)
      serviceB.syncIssue(issue)

      await sleep(500)

      // Both should be on both peers
      expect(serviceA.getSpec('s-concurrent')).toBeDefined()
      expect(serviceA.getIssue('i-concurrent')).toBeDefined()
      expect(serviceB.getSpec('s-concurrent')).toBeDefined()
      expect(serviceB.getIssue('i-concurrent')).toBeDefined()
    })

    it('should persist synced entities to JSONL', async () => {
      const spec: SpecCRDT = {
        id: 's-persist',
        uuid: 'uuid-persist',
        title: 'Persist Me',
        content: '# Persist',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceA.syncSpec(spec)
      await sleep(1000) // Wait for debounced save

      const contentB = await fs.readFile(path.join(projectB, 'specs.jsonl'), 'utf-8')
      expect(contentB).toContain('s-persist')
      expect(contentB).toContain('Persist Me')
    })
  })

  describe('Three-Peer Sync', () => {
    beforeEach(async () => {
      // Full mesh: each peer knows about the other two
      serviceA = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectA,
        meshConfig: {
          peerId: 'peer-a',
          nebulaIp: '127.0.0.1',
          port: basePort,
          peers: [
            { id: 'peer-b', nebulaIp: '127.0.0.1', port: basePort + 1 },
            { id: 'peer-c', nebulaIp: '127.0.0.1', port: basePort + 2 },
          ],
        },
      })

      serviceB = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectB,
        meshConfig: {
          peerId: 'peer-b',
          nebulaIp: '127.0.0.1',
          port: basePort + 1,
          peers: [
            { id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort },
            { id: 'peer-c', nebulaIp: '127.0.0.1', port: basePort + 2 },
          ],
        },
      })

      serviceC = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectC,
        meshConfig: {
          peerId: 'peer-c',
          nebulaIp: '127.0.0.1',
          port: basePort + 2,
          peers: [
            { id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort },
            { id: 'peer-b', nebulaIp: '127.0.0.1', port: basePort + 1 },
          ],
        },
      })

      await Promise.all([serviceA.connect(), serviceB.connect(), serviceC.connect()])
      await sleep(1000) // Wait for all connections
    })

    it('should sync to all peers', async () => {
      const spec: SpecCRDT = {
        id: 's-three-way',
        uuid: 'uuid-three',
        title: 'Three Way Sync',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      serviceA.syncSpec(spec)
      await sleep(1000) // More time for 3-peer sync

      expect(serviceB.getSpec('s-three-way')).toBeDefined()
      expect(serviceC.getSpec('s-three-way')).toBeDefined()
    })

    it('should sync updates from any peer to all others', async () => {
      // Create on A
      const issue: IssueCRDT = {
        id: 'i-chain',
        uuid: 'uuid-chain',
        title: 'Chain Sync',
        status: 'open',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      serviceA.syncIssue(issue)
      await sleep(500)

      // Update on B
      serviceB.syncIssue({ ...issue, status: 'in_progress' })
      await sleep(500)

      // Update on C
      serviceC.syncIssue({ ...issue, status: 'closed' })
      await sleep(500)

      // All should have final state
      expect(serviceA.getIssue('i-chain')?.status).toBe('closed')
      expect(serviceB.getIssue('i-chain')?.status).toBe('closed')
      expect(serviceC.getIssue('i-chain')?.status).toBe('closed')
    })

    it('should handle concurrent updates from multiple peers', async () => {
      // All three peers create different entities at the same time
      const specA: SpecCRDT = {
        id: 's-from-a',
        uuid: 'uuid-a',
        title: 'From A',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const specB: SpecCRDT = {
        id: 's-from-b',
        uuid: 'uuid-b',
        title: 'From B',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const specC: SpecCRDT = {
        id: 's-from-c',
        uuid: 'uuid-c',
        title: 'From C',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Concurrent creates
      serviceA.syncSpec(specA)
      serviceB.syncSpec(specB)
      serviceC.syncSpec(specC)

      await sleep(1000)

      // All peers should have all specs
      for (const svc of [serviceA, serviceB, serviceC]) {
        expect(svc.getAllSpecs()).toHaveLength(3)
        expect(svc.getSpec('s-from-a')).toBeDefined()
        expect(svc.getSpec('s-from-b')).toBeDefined()
        expect(svc.getSpec('s-from-c')).toBeDefined()
      }
    })
  })

  describe('Late Joiner Sync', () => {
    // TODO: This test requires enhanced sync protocol where late-joiners
    // receive full state from existing peers. Currently, sync only happens
    // when both peers are connected from the start.
    it.skip('should sync existing state to late-joining peer', async () => {
      // Start with only A
      serviceA = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectA,
        meshConfig: {
          peerId: 'peer-a',
          nebulaIp: '127.0.0.1',
          port: basePort,
          peers: [{ id: 'peer-b', nebulaIp: '127.0.0.1', port: basePort + 1 }],
        },
      })
      await serviceA.connect()

      // Create some entities on A
      serviceA.syncSpec({
        id: 's-existing',
        uuid: 'uuid-existing',
        title: 'Existing Spec',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      serviceA.syncIssue({
        id: 'i-existing',
        uuid: 'uuid-existing-issue',
        title: 'Existing Issue',
        status: 'in_progress',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      await sleep(1000) // More time for initial state to settle

      // Now B joins
      serviceB = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectB,
        meshConfig: {
          peerId: 'peer-b',
          nebulaIp: '127.0.0.1',
          port: basePort + 1,
          peers: [{ id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort }],
        },
      })
      await serviceB.connect()
      await sleep(1500) // More time for late joiner sync

      // B should have A's existing state
      expect(serviceB.getSpec('s-existing')).toBeDefined()
      expect(serviceB.getIssue('i-existing')).toBeDefined()
      expect(serviceB.getIssue('i-existing')?.status).toBe('in_progress')
    })
  })

  describe('Reconnection', () => {
    // TODO: This test requires offline queue or CRDT persistence to survive
    // across reconnections. Currently, state created while a peer is offline
    // is not synced on reconnect unless the other peer also has it persisted.
    it.skip('should sync after reconnection', async () => {
      // Initial connection
      serviceA = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectA,
        meshConfig: {
          peerId: 'peer-a',
          nebulaIp: '127.0.0.1',
          port: basePort,
          peers: [{ id: 'peer-b', nebulaIp: '127.0.0.1', port: basePort + 1 }],
        },
      })
      serviceB = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectB,
        meshConfig: {
          peerId: 'peer-b',
          nebulaIp: '127.0.0.1',
          port: basePort + 1,
          peers: [{ id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort }],
        },
      })

      await Promise.all([serviceA.connect(), serviceB.connect()])
      await sleep(1000)

      // Create initial data
      serviceA.syncSpec({
        id: 's-before',
        uuid: 'uuid-before',
        title: 'Before Disconnect',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await sleep(500)

      // Wait for debounce before disconnect
      await sleep(600)

      // Disconnect B
      await serviceB.disconnect()
      await sleep(200)

      // A creates more data while B is offline
      serviceA.syncSpec({
        id: 's-while-offline',
        uuid: 'uuid-offline',
        title: 'While B Offline',
        content: '',
        priority: 1,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await sleep(500)

      // Reconnect B
      serviceB = new SudocodeMeshService({
        projectId: 'test-project',
        projectPath: projectB,
        meshConfig: {
          peerId: 'peer-b',
          nebulaIp: '127.0.0.1',
          port: basePort + 1,
          peers: [{ id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort }],
        },
      })
      await serviceB.connect()
      await sleep(1500)

      // B should have both specs
      expect(serviceB.getSpec('s-before')).toBeDefined()
      expect(serviceB.getSpec('s-while-offline')).toBeDefined()
    })
  })
})
