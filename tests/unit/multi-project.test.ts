import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { MultiProjectManager } from '../../src/integrations/sudocode/multi-project'

// Mock SudocodeMeshService to avoid creating real mesh connections
vi.mock('../../src/integrations/sudocode/service', () => {
  class MockSudocodeMeshService {
    config: unknown
    _connected = false

    constructor(config: unknown) {
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

    on() {}
    off() {}
    emit() {}
  }

  return {
    SudocodeMeshService: MockSudocodeMeshService,
  }
})

describe('MultiProjectManager', () => {
  let manager: MultiProjectManager
  let tempDir: string
  let projectAPath: string
  let projectBPath: string
  let basePort: number

  beforeEach(async () => {
    basePort = 21200 + Math.floor(Math.random() * 1000)
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-project-test-'))
    projectAPath = path.join(tempDir, 'project-a')
    projectBPath = path.join(tempDir, 'project-b')

    // Create project directories with .sudocode folders
    await fs.mkdir(path.join(projectAPath, '.sudocode'), { recursive: true })
    await fs.mkdir(path.join(projectBPath, '.sudocode'), { recursive: true })

    // Create empty JSONL files
    await fs.writeFile(path.join(projectAPath, '.sudocode', 'specs.jsonl'), '')
    await fs.writeFile(path.join(projectAPath, '.sudocode', 'issues.jsonl'), '')
    await fs.writeFile(path.join(projectBPath, '.sudocode', 'specs.jsonl'), '')
    await fs.writeFile(path.join(projectBPath, '.sudocode', 'issues.jsonl'), '')

    manager = new MultiProjectManager({
      meshConfig: {
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: basePort,
        peers: [],
      },
    })
  })

  afterEach(async () => {
    if (manager?.connected) {
      await manager.disconnect()
    }
    await fs.rm(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  describe('lifecycle', () => {
    it('should start disconnected', () => {
      expect(manager.connected).toBe(false)
    })

    it('should connect to mesh', async () => {
      await manager.connect()
      expect(manager.connected).toBe(true)
    })

    it('should disconnect from mesh', async () => {
      await manager.connect()
      await manager.disconnect()
      expect(manager.connected).toBe(false)
    })

    it('should be idempotent on connect', async () => {
      await manager.connect()
      await manager.connect()
      expect(manager.connected).toBe(true)
    })

    it('should be idempotent on disconnect', async () => {
      await manager.connect()
      await manager.disconnect()
      await manager.disconnect()
      expect(manager.connected).toBe(false)
    })
  })

  describe('project management', () => {
    beforeEach(async () => {
      await manager.connect()
    })

    it('should add a project', async () => {
      const service = await manager.addProject('project-a', projectAPath)
      expect(service).toBeDefined()
      expect(manager.hasProject('project-a')).toBe(true)
    })

    it('should throw when adding project before connecting', async () => {
      await manager.disconnect()
      await expect(
        manager.addProject('project-a', projectAPath)
      ).rejects.toThrow('Manager not connected')
    })

    it('should throw when adding duplicate project', async () => {
      await manager.addProject('project-a', projectAPath)
      await expect(
        manager.addProject('project-a', projectAPath)
      ).rejects.toThrow('Project already exists')
    })

    it('should remove a project', async () => {
      await manager.addProject('project-a', projectAPath)
      const removed = await manager.removeProject('project-a')
      expect(removed).toBe(true)
      expect(manager.hasProject('project-a')).toBe(false)
    })

    it('should return false when removing non-existent project', async () => {
      const removed = await manager.removeProject('non-existent')
      expect(removed).toBe(false)
    })

    it('should get a project by ID', async () => {
      await manager.addProject('project-a', projectAPath)
      const service = manager.getProject('project-a')
      expect(service).toBeDefined()
    })

    it('should return undefined for non-existent project', () => {
      const service = manager.getProject('non-existent')
      expect(service).toBeUndefined()
    })

    it('should track project count', async () => {
      expect(manager.projectCount).toBe(0)
      await manager.addProject('project-a', projectAPath)
      expect(manager.projectCount).toBe(1)
      await manager.addProject('project-b', projectBPath)
      expect(manager.projectCount).toBe(2)
      await manager.removeProject('project-a')
      expect(manager.projectCount).toBe(1)
    })
  })

  describe('project listing', () => {
    beforeEach(async () => {
      await manager.connect()
    })

    it('should list all projects', async () => {
      await manager.addProject('project-a', projectAPath)
      await manager.addProject('project-b', projectBPath)

      const projects = manager.listProjects()
      expect(projects).toHaveLength(2)

      const projectA = projects.find((p) => p.projectId === 'project-a')
      expect(projectA).toBeDefined()
      expect(projectA?.projectPath).toBe(projectAPath)
      expect(projectA?.namespace).toBe('sudocode:project-a')

      const projectB = projects.find((p) => p.projectId === 'project-b')
      expect(projectB).toBeDefined()
      expect(projectB?.projectPath).toBe(projectBPath)
      expect(projectB?.namespace).toBe('sudocode:project-b')
    })

    it('should get all project IDs', async () => {
      await manager.addProject('project-a', projectAPath)
      await manager.addProject('project-b', projectBPath)

      const ids = manager.getProjectIds()
      expect(ids).toContain('project-a')
      expect(ids).toContain('project-b')
      expect(ids).toHaveLength(2)
    })

    it('should return empty list when no projects', () => {
      const projects = manager.listProjects()
      expect(projects).toHaveLength(0)
    })
  })

  describe('events', () => {
    beforeEach(async () => {
      await manager.connect()
    })

    it('should emit project:added event', async () => {
      const handler = vi.fn()
      manager.on('project:added', handler)

      await manager.addProject('project-a', projectAPath)

      expect(handler).toHaveBeenCalledWith({
        projectId: 'project-a',
        projectPath: projectAPath,
      })
    })

    it('should emit project:removed event', async () => {
      const handler = vi.fn()
      manager.on('project:removed', handler)

      await manager.addProject('project-a', projectAPath)
      await manager.removeProject('project-a')

      expect(handler).toHaveBeenCalledWith({
        projectId: 'project-a',
      })
    })
  })

  describe('namespace isolation', () => {
    beforeEach(async () => {
      await manager.connect()
    })

    it('should use different namespaces for different projects', async () => {
      await manager.addProject('project-a', projectAPath)
      await manager.addProject('project-b', projectBPath)

      const projects = manager.listProjects()
      const namespaces = projects.map((p) => p.namespace)

      expect(namespaces).toContain('sudocode:project-a')
      expect(namespaces).toContain('sudocode:project-b')
      expect(new Set(namespaces).size).toBe(2) // All unique
    })
  })

  describe('getMesh', () => {
    it('should return null when not connected', () => {
      expect(manager.getMesh()).toBeNull()
    })

    it('should return mesh when connected', async () => {
      await manager.connect()
      expect(manager.getMesh()).not.toBeNull()
    })
  })
})
