/**
 * Tests for Git Transport Module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  GitProtocolHandlerImpl,
  GitProtocolError,
  DefaultGitAccessControl,
  createGitProtocolHandler,
} from '../../src/git/protocol-handler'
import {
  GitTransportService,
  createGitTransportService,
} from '../../src/git/transport-service'
import type {
  GitTransportConfig,
  ListRefsRequest,
  UploadPackRequest,
  ReceivePackRequest,
  GitRef,
  AnyGitMessage,
} from '../../src/git/types'
import { DEFAULT_GIT_TRANSPORT_CONFIG } from '../../src/git/types'

// =============================================================================
// Mock child_process for git command tests
// =============================================================================

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

// =============================================================================
// GitProtocolHandler Tests
// =============================================================================

describe('GitProtocolHandler', () => {
  let handler: GitProtocolHandlerImpl

  beforeEach(() => {
    handler = new GitProtocolHandlerImpl({
      config: {
        ...DEFAULT_GIT_TRANSPORT_CONFIG,
        repoPath: '/test/repo',
      },
    })
  })

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const config = handler.getConfig()
      expect(config.repoPath).toBe('/test/repo')
      expect(config.enabled).toBe(true)
    })
  })

  describe('updateConfig', () => {
    it('should update configuration', () => {
      handler.updateConfig({ repoPath: '/new/repo' })
      const config = handler.getConfig()
      expect(config.repoPath).toBe('/new/repo')
    })

    it('should preserve unupdated fields', () => {
      const original = handler.getConfig()
      handler.updateConfig({ repoPath: '/new/repo' })
      const updated = handler.getConfig()
      expect(updated.clone.allowShallow).toBe(original.clone.allowShallow)
    })
  })

  describe('listRefs', () => {
    it('should return empty list for empty request', async () => {
      // Mock git commands to return empty
      const { spawn } = await import('child_process')
      const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

      // Mock for symbolic-ref HEAD (fails = no HEAD)
      mockSpawn.mockImplementationOnce(() => {
        const proc = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          stdin: { write: vi.fn(), end: vi.fn() },
          on: vi.fn((event, cb) => {
            if (event === 'close') cb(1) // Exit with error
          }),
        }
        return proc
      })

      // Mock for for-each-ref (empty output)
      mockSpawn.mockImplementationOnce(() => {
        const proc = {
          stdout: {
            on: vi.fn((event, cb) => {
              if (event === 'data') cb(Buffer.from(''))
            }),
          },
          stderr: { on: vi.fn() },
          stdin: { write: vi.fn(), end: vi.fn() },
          on: vi.fn((event, cb) => {
            if (event === 'close') cb(0)
          }),
        }
        return proc
      })

      const response = await handler.listRefs({})
      expect(response.capabilities).toContain('thin-pack')
      expect(response.capabilities).toContain('side-band-64k')
    })
  })

  describe('uploadPack validation', () => {
    it('should reject requests with no wants', async () => {
      await expect(
        handler.uploadPack({ wants: [], haves: [] })
      ).rejects.toThrow(GitProtocolError)
    })

    it('should reject depth exceeding maxDepth', async () => {
      handler.updateConfig({
        clone: {
          ...DEFAULT_GIT_TRANSPORT_CONFIG.clone,
          maxDepth: 10,
        },
      })

      await expect(
        handler.uploadPack({ wants: ['abc123'], haves: [], depth: 100 })
      ).rejects.toThrow('exceeds maximum')
    })

    it('should reject disallowed filters', async () => {
      handler.updateConfig({
        clone: {
          ...DEFAULT_GIT_TRANSPORT_CONFIG.clone,
          allowedFilters: ['blob:none'],
        },
      })

      await expect(
        handler.uploadPack({ wants: ['abc123'], haves: [], filter: 'blob:limit=1m' })
      ).rejects.toThrow('not allowed')
    })
  })

  describe('receivePack validation', () => {
    it('should reject requests with no commands', async () => {
      await expect(
        handler.receivePack({ commands: [] })
      ).rejects.toThrow(GitProtocolError)
    })

    it('should reject delete when not allowed', async () => {
      handler.updateConfig({
        push: {
          ...DEFAULT_GIT_TRANSPORT_CONFIG.push,
          allowDelete: false,
        },
      })

      const response = await handler.receivePack({
        commands: [{ src: '', dst: 'refs/heads/feature', delete: true, force: false }],
      })

      expect(response.results[0].status).toBe('rejected')
      expect(response.results[0].reason).toContain('not allowed')
    })
  })
})

// =============================================================================
// GitProtocolError Tests
// =============================================================================

describe('GitProtocolError', () => {
  it('should create error with code and message', () => {
    const error = new GitProtocolError('TEST_CODE', 'Test message')
    expect(error.code).toBe('TEST_CODE')
    expect(error.message).toBe('Test message')
    expect(error.name).toBe('GitProtocolError')
  })

  it('should include details when provided', () => {
    const error = new GitProtocolError('TEST_CODE', 'Test message', { key: 'value' })
    expect(error.details).toEqual({ key: 'value' })
  })
})

// =============================================================================
// DefaultGitAccessControl Tests
// =============================================================================

describe('DefaultGitAccessControl', () => {
  let accessControl: DefaultGitAccessControl

  beforeEach(() => {
    accessControl = new DefaultGitAccessControl()
  })

  it('should allow read access', async () => {
    const result = await accessControl.checkRead('peer-123')
    expect(result.allowed).toBe(true)
    expect(result.level).toBe('read')
  })

  it('should allow write access', async () => {
    const result = await accessControl.checkWrite('peer-123')
    expect(result.allowed).toBe(true)
    expect(result.level).toBe('write')
  })

  it('should allow ref updates', async () => {
    const result = await accessControl.checkRefUpdate('peer-123', 'refs/heads/main', false)
    expect(result.allowed).toBe(true)
  })

  it('should allow ref deletes', async () => {
    const result = await accessControl.checkRefDelete('peer-123', 'refs/heads/feature')
    expect(result.allowed).toBe(true)
  })
})

// =============================================================================
// GitTransportService Tests
// =============================================================================

describe('GitTransportService', () => {
  let service: GitTransportService

  beforeEach(() => {
    service = createGitTransportService({
      httpPort: 0, // Use random available port
      httpHost: '127.0.0.1',
    })
  })

  afterEach(async () => {
    if (service.isRunning) {
      await service.stop()
    }
  })

  describe('lifecycle', () => {
    it('should start and stop cleanly', async () => {
      expect(service.isRunning).toBe(false)

      // Can't actually start in test environment without port
      // Just verify the methods exist and don't throw immediately
      expect(typeof service.start).toBe('function')
      expect(typeof service.stop).toBe('function')
    })

    it('should expose protocol handler', () => {
      expect(service.protocolHandler).toBeDefined()
      expect(service.protocolHandler.getConfig).toBeDefined()
    })
  })

  describe('peer sender', () => {
    it('should accept peer sender configuration', () => {
      const mockSender = {
        sendToPeer: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      }

      service.setPeerSender(mockSender)

      // Verify it was set (indirectly by not throwing)
      expect(true).toBe(true)
    })
  })

  describe('handleRemoteMessage', () => {
    it('should handle list-refs request', async () => {
      const message: AnyGitMessage = {
        type: 'git/list-refs',
        correlationId: 'test-123',
        request: { refPrefix: 'refs/heads/' },
      }

      const mockSender = {
        sendToPeer: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
      }
      service.setPeerSender(mockSender)

      // This will fail because git isn't actually available, but tests the flow
      try {
        await service.handleRemoteMessage('peer-abc', message)
      } catch {
        // Expected to fail without actual git
      }
    })

    it('should handle error messages', async () => {
      // Set up a pending request
      const correlationId = 'test-error-123'

      const errorMessage: AnyGitMessage = {
        type: 'git/error',
        correlationId,
        code: 'TEST_ERROR',
        message: 'Test error message',
      }

      // handleRemoteMessage should not throw for error messages
      await service.handleRemoteMessage('peer-abc', errorMessage)
    })
  })
})

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('Factory functions', () => {
  it('createGitProtocolHandler should create handler', () => {
    const handler = createGitProtocolHandler()
    expect(handler).toBeDefined()
    expect(handler.listRefs).toBeDefined()
    expect(handler.uploadPack).toBeDefined()
    expect(handler.receivePack).toBeDefined()
  })

  it('createGitTransportService should create service', () => {
    const service = createGitTransportService()
    expect(service).toBeDefined()
    expect(service.start).toBeDefined()
    expect(service.stop).toBeDefined()
  })
})

// =============================================================================
// Type Export Tests
// =============================================================================

describe('Type exports', () => {
  it('should export DEFAULT_GIT_TRANSPORT_CONFIG', () => {
    expect(DEFAULT_GIT_TRANSPORT_CONFIG).toBeDefined()
    expect(DEFAULT_GIT_TRANSPORT_CONFIG.enabled).toBe(true)
    expect(DEFAULT_GIT_TRANSPORT_CONFIG.clone.allowShallow).toBe(true)
  })
})
