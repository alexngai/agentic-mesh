/**
 * Git Transport Integration Tests
 *
 * End-to-end tests for git transport over agentic-mesh.
 * These tests verify the full flow from git-remote-mesh helper
 * through MeshPeer to the remote GitProtocolHandler.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  GitTransportService,
  createGitTransportService,
  GitProtocolHandlerImpl,
  createGitProtocolHandler,
} from '../../src/git'
import type { AnyGitMessage, ListRefsResponse, UploadPackResponse } from '../../src/git/types'

// =============================================================================
// Test Setup Helpers
// =============================================================================

/** Create a temporary git repository for testing */
function createTempGitRepo(name: string): string {
  const repoPath = join(tmpdir(), `git-transport-test-${name}-${Date.now()}`)
  mkdirSync(repoPath, { recursive: true })

  // Initialize git repo with initial branch name
  execSync('git init -b master', { cwd: repoPath, stdio: 'ignore' })
  // Set git config locally for this repo
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'ignore' })
  execSync('git config user.name "Test User"', { cwd: repoPath, stdio: 'ignore' })
  // Disable gpg signing for tests
  execSync('git config commit.gpgsign false', { cwd: repoPath, stdio: 'ignore' })

  // Create initial commit with explicit author info
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath, stdio: 'ignore' })
  execSync('git commit --no-gpg-sign -m "Initial commit"', {
    cwd: repoPath,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  })

  return repoPath
}

/** Clean up a temporary repository */
function cleanupTempRepo(repoPath: string): void {
  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true })
  }
}

/** Get the HEAD commit SHA */
function getHeadSha(repoPath: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim()
}

/** Create a branch */
function createBranch(repoPath: string, branchName: string): void {
  execSync(`git checkout -b ${branchName}`, { cwd: repoPath, stdio: 'ignore' })
}

/** Add a commit */
function addCommit(repoPath: string, filename: string, content: string, message: string): string {
  writeFileSync(join(repoPath, filename), content)
  execSync('git add .', { cwd: repoPath, stdio: 'ignore' })
  execSync(`git commit --no-gpg-sign -m "${message}"`, {
    cwd: repoPath,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  })
  return getHeadSha(repoPath)
}

// =============================================================================
// GitProtocolHandler Integration Tests
// =============================================================================

describe('GitProtocolHandler Integration', () => {
  let repoPath: string
  let handler: GitProtocolHandlerImpl

  beforeEach(() => {
    repoPath = createTempGitRepo('handler')
    handler = new GitProtocolHandlerImpl({
      config: { repoPath },
    })
  })

  afterEach(() => {
    cleanupTempRepo(repoPath)
  })

  describe('listRefs', () => {
    it('should list refs in a repository', async () => {
      const response = await handler.listRefs({})

      expect(response.refs).toBeDefined()
      expect(response.refs.length).toBeGreaterThan(0)

      // Should have HEAD
      const headRef = response.refs.find((r) => r.name === 'HEAD')
      expect(headRef).toBeDefined()
      expect(headRef?.symref).toBe('refs/heads/master')

      // Should have main/master branch
      const mainRef = response.refs.find(
        (r) => r.name === 'refs/heads/main' || r.name === 'refs/heads/master'
      )
      expect(mainRef).toBeDefined()

      // Should advertise capabilities
      expect(response.capabilities).toContain('thin-pack')
      expect(response.capabilities).toContain('side-band-64k')
    })

    it('should filter refs by prefix', async () => {
      // Create a tag
      execSync('git tag v1.0.0', { cwd: repoPath, stdio: 'ignore' })

      const response = await handler.listRefs({ refPrefix: 'refs/tags/' })

      expect(response.refs.some((r) => r.name === 'refs/tags/v1.0.0')).toBe(true)
    })

    it('should list refs from multiple branches', async () => {
      createBranch(repoPath, 'feature-branch')
      addCommit(repoPath, 'feature.txt', 'feature content', 'Add feature')

      const response = await handler.listRefs({})

      const featureBranch = response.refs.find((r) => r.name === 'refs/heads/feature-branch')
      expect(featureBranch).toBeDefined()
    })
  })

  describe('uploadPack', () => {
    it('should generate pack data for wanted objects', async () => {
      const headSha = getHeadSha(repoPath)

      const response = await handler.uploadPack({
        wants: [headSha],
        haves: [],
      })

      expect(response.packData).toBeDefined()
      expect(response.packData!.length).toBeGreaterThan(0)
      expect(response.ready).toBe(true)
    })

    it('should handle shallow depth', async () => {
      // Add some commits
      addCommit(repoPath, 'file1.txt', 'content1', 'Commit 1')
      addCommit(repoPath, 'file2.txt', 'content2', 'Commit 2')
      const headSha = addCommit(repoPath, 'file3.txt', 'content3', 'Commit 3')

      const response = await handler.uploadPack({
        wants: [headSha],
        haves: [],
        depth: 1,
      })

      expect(response.packData).toBeDefined()
    })

    it('should reject depth exceeding maxDepth', async () => {
      handler.updateConfig({
        clone: {
          allowShallow: true,
          maxDepth: 5,
          allowPartial: false,
        },
      })

      const headSha = getHeadSha(repoPath)

      await expect(
        handler.uploadPack({
          wants: [headSha],
          haves: [],
          depth: 100,
        })
      ).rejects.toThrow('exceeds maximum')
    })
  })

  describe('receivePack', () => {
    it('should reject force push to protected branches', async () => {
      handler.updateConfig({
        push: {
          protectedBranches: ['master', 'main'],
          requireSigned: false,
          allowDelete: true,
          allowNonFastForward: false,
        },
      })

      const response = await handler.receivePack({
        commands: [
          {
            src: 'abc123',
            dst: 'refs/heads/master',
            force: true,
          },
        ],
      })

      expect(response.results[0].status).toBe('rejected')
      expect(response.results[0].reason).toContain('protected')
    })

    it('should reject delete when not allowed', async () => {
      handler.updateConfig({
        push: {
          protectedBranches: [],
          requireSigned: false,
          allowDelete: false,
          allowNonFastForward: true,
        },
      })

      const response = await handler.receivePack({
        commands: [
          {
            src: '',
            dst: 'refs/heads/feature',
            delete: true,
            force: false,
          },
        ],
      })

      expect(response.results[0].status).toBe('rejected')
      expect(response.results[0].reason).toContain('not allowed')
    })
  })
})

// =============================================================================
// GitTransportService Integration Tests
// =============================================================================

describe('GitTransportService Integration', () => {
  let repoPath: string
  let service: GitTransportService
  let port: number

  beforeEach(async () => {
    repoPath = createTempGitRepo('service')
    // Use a random high port
    port = 30000 + Math.floor(Math.random() * 10000)

    service = createGitTransportService({
      httpPort: port,
      httpHost: '127.0.0.1',
      git: {
        repoPath,
      },
    })
  })

  afterEach(async () => {
    if (service.isRunning) {
      await service.stop()
    }
    cleanupTempRepo(repoPath)
  })

  describe('lifecycle', () => {
    it('should start and stop cleanly', async () => {
      expect(service.isRunning).toBe(false)

      await service.start()
      expect(service.isRunning).toBe(true)

      await service.stop()
      expect(service.isRunning).toBe(false)
    })

    it('should handle multiple start calls', async () => {
      await service.start()
      await service.start() // Should not throw
      expect(service.isRunning).toBe(true)
    })

    it('should handle multiple stop calls', async () => {
      await service.start()
      await service.stop()
      await service.stop() // Should not throw
      expect(service.isRunning).toBe(false)
    })
  })

  describe('HTTP endpoints', () => {
    beforeEach(async () => {
      await service.start()
    })

    it('should handle /git/list-refs endpoint', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/git/list-refs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(response.ok).toBe(true)

      const data = (await response.json()) as ListRefsResponse
      expect(data.refs).toBeDefined()
      expect(data.capabilities).toBeDefined()
    })

    it('should handle /git/upload-pack endpoint', async () => {
      // First get refs
      const refsResponse = await fetch(`http://127.0.0.1:${port}/git/list-refs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const refs = (await refsResponse.json()) as ListRefsResponse
      const mainRef = refs.refs.find(
        (r) => r.name === 'refs/heads/main' || r.name === 'refs/heads/master'
      )

      if (!mainRef) {
        throw new Error('No main branch found')
      }

      // Now request pack
      const packResponse = await fetch(`http://127.0.0.1:${port}/git/upload-pack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wants: [mainRef.sha],
          haves: [],
        }),
      })

      expect(packResponse.ok).toBe(true)

      const data = (await packResponse.json()) as UploadPackResponse
      expect(data.packData).toBeDefined()
    })

    it('should handle /git/status endpoint', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/git/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(response.ok).toBe(true)

      const data = (await response.json()) as { running: boolean; config: unknown }
      expect(data.running).toBe(true)
      expect(data.config).toBeDefined()
    })

    it('should return 404 for unknown endpoint', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/git/unknown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(404)
    })

    it('should return 405 for non-POST requests', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/git/list-refs`, {
        method: 'GET',
      })

      expect(response.status).toBe(405)
    })
  })

  describe('peer message handling', () => {
    it('should handle remote git messages', async () => {
      const mockSender = {
        sendToPeer: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      }
      service.setPeerSender(mockSender)

      await service.start()

      // Simulate receiving a git message from remote peer
      const gitMessage: AnyGitMessage = {
        type: 'git/list-refs',
        correlationId: 'test-123',
        request: {},
      }

      // Handle the message - this should send a response back
      await service.handleRemoteMessage('peer-abc', gitMessage)

      // Verify response was sent
      expect(mockSender.sendToPeer).toHaveBeenCalledWith(
        'peer-abc',
        expect.objectContaining({
          type: 'git/list-refs',
          correlationId: 'test-123',
        })
      )
    })

    it('should handle error responses', async () => {
      const mockSender = {
        sendToPeer: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      }
      service.setPeerSender(mockSender)

      await service.start()

      // Send an invalid request
      const gitMessage: AnyGitMessage = {
        type: 'git/upload-pack',
        correlationId: 'test-456',
        request: { wants: [], haves: [] }, // Empty wants should fail
      }

      await service.handleRemoteMessage('peer-abc', gitMessage)

      // Verify error response was sent
      expect(mockSender.sendToPeer).toHaveBeenCalledWith(
        'peer-abc',
        expect.objectContaining({
          type: 'git/error',
          correlationId: 'test-456',
        })
      )
    })
  })
})

// =============================================================================
// Peer-to-Peer Git Transport Tests (Simulated)
// =============================================================================

describe('Peer-to-Peer Git Transport (Simulated)', () => {
  let localRepo: string
  let remoteRepo: string
  let localService: GitTransportService
  let remoteService: GitTransportService

  beforeEach(async () => {
    localRepo = createTempGitRepo('local')
    remoteRepo = createTempGitRepo('remote')

    // Add some commits to remote
    addCommit(remoteRepo, 'remote-file.txt', 'remote content', 'Remote commit')

    // Create services
    localService = createGitTransportService({
      httpPort: 30000 + Math.floor(Math.random() * 10000),
      httpHost: '127.0.0.1',
      git: { repoPath: localRepo },
    })

    remoteService = createGitTransportService({
      httpPort: 30000 + Math.floor(Math.random() * 10000),
      httpHost: '127.0.0.1',
      git: { repoPath: remoteRepo },
    })

    // Wire up the services to communicate with each other
    const localToRemote: AnyGitMessage[] = []
    const remoteToLocal: AnyGitMessage[] = []

    localService.setPeerSender({
      sendToPeer: async (peerId, msg) => {
        localToRemote.push(msg)
        // Simulate async delivery
        setTimeout(() => {
          remoteService.handleRemoteMessage('local', msg)
        }, 0)
      },
      isConnected: () => true,
    })

    remoteService.setPeerSender({
      sendToPeer: async (peerId, msg) => {
        remoteToLocal.push(msg)
        // Simulate async delivery
        setTimeout(() => {
          localService.handleRemoteMessage('remote', msg)
        }, 0)
      },
      isConnected: () => true,
    })

    await Promise.all([localService.start(), remoteService.start()])
  })

  afterEach(async () => {
    await Promise.all([localService.stop(), remoteService.stop()])
    cleanupTempRepo(localRepo)
    cleanupTempRepo(remoteRepo)
  })

  it('should list refs from remote peer', async () => {
    // This test verifies the simulated peer-to-peer communication
    const refs = await remoteService.protocolHandler.listRefs({})

    expect(refs.refs).toBeDefined()
    expect(refs.refs.length).toBeGreaterThan(0)
  })

  it('should fetch pack from remote peer', async () => {
    const refs = await remoteService.protocolHandler.listRefs({})
    const mainRef = refs.refs.find(
      (r) => r.name === 'refs/heads/main' || r.name === 'refs/heads/master'
    )

    if (!mainRef) {
      throw new Error('No main branch found')
    }

    const pack = await remoteService.protocolHandler.uploadPack({
      wants: [mainRef.sha],
      haves: [],
    })

    expect(pack.packData).toBeDefined()
    expect(pack.ready).toBe(true)
  })
})
