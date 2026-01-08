import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  detectExtensionPath,
  validateExtensionPath,
  getExtensionPath,
  getInstallInstructions,
} from '../../src/sync/cr-sqlite/extension-loader'
import { DbSyncError } from '../../src/sync/cr-sqlite/types'

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  }
})

describe('cr-sqlite extension-loader', () => {
  const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>
  const mockStatSync = fs.statSync as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset environment variable
    delete process.env.CRSQLITE_EXTENSION_PATH
  })

  afterEach(() => {
    delete process.env.CRSQLITE_EXTENSION_PATH
  })

  describe('detectExtensionPath', () => {
    it('should find extension in current working directory', () => {
      const expectedPath = path.join(process.cwd(), getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = detectExtensionPath()
      expect(result).toBe(expectedPath)
    })

    it('should find extension in extensions subdirectory', () => {
      const expectedPath = path.join(process.cwd(), 'extensions', getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = detectExtensionPath()
      expect(result).toBe(expectedPath)
    })

    it('should find extension in lib subdirectory', () => {
      const expectedPath = path.join(process.cwd(), 'lib', getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = detectExtensionPath()
      expect(result).toBe(expectedPath)
    })

    it('should find extension in node_modules', () => {
      const expectedPath = path.join(process.cwd(), 'node_modules', '.cr-sqlite', getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = detectExtensionPath()
      expect(result).toBe(expectedPath)
    })

    it('should find extension in home directory .cr-sqlite', () => {
      const expectedPath = path.join(os.homedir(), '.cr-sqlite', getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = detectExtensionPath()
      expect(result).toBe(expectedPath)
    })

    it('should prioritize CRSQLITE_EXTENSION_PATH environment variable', () => {
      const envPath = '/custom/path/to/crsqlite.dylib'
      process.env.CRSQLITE_EXTENSION_PATH = envPath
      mockExistsSync.mockImplementation((p: string) => p === envPath)

      const result = detectExtensionPath()
      expect(result).toBe(envPath)
    })

    it('should throw DbSyncError when extension not found', () => {
      mockExistsSync.mockReturnValue(false)

      expect(() => detectExtensionPath()).toThrow(DbSyncError)
      expect(() => detectExtensionPath()).toThrow(/cr-sqlite extension not found/)
    })

    it('should include installation instructions in error message', () => {
      mockExistsSync.mockReturnValue(false)

      try {
        detectExtensionPath()
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DbSyncError)
        const error = err as DbSyncError
        expect(error.code).toBe('EXTENSION_NOT_FOUND')
        expect(error.message).toContain('npm install')
        expect(error.message).toContain('CRSQLITE_EXTENSION_PATH')
      }
    })
  })

  describe('validateExtensionPath', () => {
    it('should return true for valid file path', () => {
      const testPath = '/path/to/crsqlite.dylib'
      mockExistsSync.mockReturnValue(true)
      mockStatSync.mockReturnValue({ isFile: () => true } as fs.Stats)

      const result = validateExtensionPath(testPath)
      expect(result).toBe(true)
    })

    it('should throw DbSyncError when path does not exist', () => {
      mockExistsSync.mockReturnValue(false)

      expect(() => validateExtensionPath('/nonexistent/path')).toThrow(DbSyncError)
      expect(() => validateExtensionPath('/nonexistent/path')).toThrow(/not found at/)
    })

    it('should throw DbSyncError when path is not a file', () => {
      mockExistsSync.mockReturnValue(true)
      mockStatSync.mockReturnValue({ isFile: () => false } as fs.Stats)

      expect(() => validateExtensionPath('/some/directory')).toThrow(DbSyncError)
      expect(() => validateExtensionPath('/some/directory')).toThrow(/not a file/)
    })

    it('should have EXTENSION_NOT_FOUND error code', () => {
      mockExistsSync.mockReturnValue(false)

      try {
        validateExtensionPath('/nonexistent')
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DbSyncError)
        expect((err as DbSyncError).code).toBe('EXTENSION_NOT_FOUND')
      }
    })
  })

  describe('getExtensionPath', () => {
    it('should use provided config path when valid', () => {
      const configPath = '/custom/crsqlite.dylib'
      mockExistsSync.mockReturnValue(true)
      mockStatSync.mockReturnValue({ isFile: () => true } as fs.Stats)

      const result = getExtensionPath(configPath)
      expect(result).toBe(configPath)
    })

    it('should auto-detect when no config path provided', () => {
      const expectedPath = path.join(process.cwd(), getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = getExtensionPath()
      expect(result).toBe(expectedPath)
    })

    it('should auto-detect when config path is undefined', () => {
      const expectedPath = path.join(process.cwd(), getExpectedExtensionName())
      mockExistsSync.mockImplementation((p: string) => p === expectedPath)

      const result = getExtensionPath(undefined)
      expect(result).toBe(expectedPath)
    })

    it('should throw when config path is invalid', () => {
      mockExistsSync.mockReturnValue(false)

      expect(() => getExtensionPath('/invalid/path')).toThrow(DbSyncError)
    })
  })

  describe('getInstallInstructions', () => {
    it('should return installation instructions', () => {
      const instructions = getInstallInstructions()

      expect(instructions).toContain('cr-sqlite Installation Instructions')
      expect(instructions).toContain('npm install')
      expect(instructions).toContain('curl')
      expect(instructions).toContain('CRSQLITE_EXTENSION_PATH')
    })

    it('should include platform-specific download URL', () => {
      const instructions = getInstallInstructions()
      const platform = os.platform()

      if (platform === 'darwin') {
        expect(instructions).toContain('darwin')
        expect(instructions).toContain('.dylib')
      } else if (platform === 'linux') {
        expect(instructions).toContain('linux')
        expect(instructions).toContain('.so')
      } else if (platform === 'win32') {
        expect(instructions).toContain('windows')
        expect(instructions).toContain('.dll')
      }
    })

    it('should include GitHub release URL', () => {
      const instructions = getInstallInstructions()
      expect(instructions).toContain('github.com/vlcn-io/cr-sqlite')
    })

    it('should include npm package option', () => {
      const instructions = getInstallInstructions()
      expect(instructions).toContain('@aspect-build/aspect-rules-cr-sqlite')
    })
  })
})

// Helper to get expected extension name for current platform
function getExpectedExtensionName(): string {
  const platform = os.platform()
  switch (platform) {
    case 'darwin':
      return 'crsqlite.dylib'
    case 'linux':
      return 'crsqlite.so'
    case 'win32':
      return 'crsqlite.dll'
    default:
      return 'crsqlite.so'
  }
}
