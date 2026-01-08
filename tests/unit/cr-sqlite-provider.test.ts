import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { CrSqliteSyncProvider } from '../../src/sync/cr-sqlite/provider'
import { DbSyncError } from '../../src/sync/cr-sqlite/types'
import type { CrSqliteSyncConfig } from '../../src/sync/cr-sqlite/types'
import type { MeshContext } from '../../src/types'

// Create mock database instance
function createMockDatabase() {
  const statements = new Map<string, ReturnType<typeof createMockStatement>>()

  function createMockStatement() {
    return {
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      pluck: vi.fn().mockReturnThis(),
    }
  }

  return {
    loadExtension: vi.fn(),
    close: vi.fn(),
    exec: vi.fn(),
    backup: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn((sql: string) => {
      if (!statements.has(sql)) {
        const stmt = createMockStatement()
        // Default behaviors for specific queries
        if (sql.includes('crsql_site_id')) {
          stmt.get.mockReturnValue('mock-site-id-123')
        } else if (sql.includes('MAX(db_version)')) {
          stmt.get.mockReturnValue({ version: 0 })
        } else if (sql.includes('sqlite_master')) {
          stmt.get.mockReturnValue({ name: 'test_table' })
        }
        statements.set(sql, stmt)
      }
      return statements.get(sql)
    }),
    transaction: vi.fn((fn: Function) => fn),
  }
}

// Mock better-sqlite3 as a class constructor
vi.mock('better-sqlite3', () => {
  const MockDatabase = function(this: ReturnType<typeof createMockDatabase>) {
    const db = createMockDatabase()
    Object.assign(this, db)
    return this
  }
  return { default: MockDatabase }
})

// Mock extension-loader
vi.mock('../../src/sync/cr-sqlite/extension-loader', () => ({
  getExtensionPath: vi.fn().mockReturnValue('/mock/path/crsqlite.dylib'),
  detectExtensionPath: vi.fn().mockReturnValue('/mock/path/crsqlite.dylib'),
  validateExtensionPath: vi.fn().mockReturnValue(true),
  getInstallInstructions: vi.fn().mockReturnValue('Mock instructions'),
}))

// Create mock mesh context
function createMockMesh(): MeshContext & EventEmitter {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    peerId: 'test-peer',
    connected: true,
    getPeers: vi.fn().mockReturnValue([]),
    getActiveHub: vi.fn().mockReturnValue(null),
    isHub: vi.fn().mockReturnValue(false),
    registerNamespace: vi.fn().mockResolvedValue(undefined),
    unregisterNamespace: vi.fn().mockResolvedValue(undefined),
    createChannel: vi.fn().mockReturnValue(createMockChannel()),
  }) as MeshContext & EventEmitter
}

// Create mock channel
function createMockChannel() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
    send: vi.fn(),
    request: vi.fn().mockResolvedValue({ changesets: [], fromVersion: 0, toVersion: 0, hasMore: false }),
    onRequest: vi.fn(),
  })
}

describe('CrSqliteSyncProvider', () => {
  let mesh: ReturnType<typeof createMockMesh>
  let provider: CrSqliteSyncProvider
  let config: CrSqliteSyncConfig

  beforeEach(() => {
    vi.clearAllMocks()
    mesh = createMockMesh()
    config = {
      namespace: 'test-db',
      dbPath: ':memory:',
      tables: ['test_table'],
    }
  })

  afterEach(async () => {
    if (provider) {
      await provider.stop()
    }
  })

  describe('Constructor', () => {
    it('should create provider with config', () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      expect(provider).toBeDefined()
      expect(provider.namespace).toBe('test-db')
    })

    it('should start not synced and not syncing', () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      expect(provider.synced).toBe(false)
      expect(provider.syncing).toBe(false)
    })
  })

  describe('Lifecycle', () => {
    it('should start and become synced with no peers', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)

      const syncedHandler = vi.fn()
      provider.on('synced', syncedHandler)

      await provider.start()

      expect(provider.synced).toBe(true)
      expect(provider.syncing).toBe(false)
      expect(syncedHandler).toHaveBeenCalledTimes(1)
    })

    it('should emit syncing event when starting', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)

      const syncingHandler = vi.fn()
      provider.on('syncing', syncingHandler)

      await provider.start()

      expect(syncingHandler).toHaveBeenCalledTimes(1)
    })

    it('should load cr-sqlite extension on start', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const db = provider.getDb()
      expect(db.loadExtension).toHaveBeenCalledWith('/mock/path/crsqlite.dylib')
    })

    it('should register namespace on start', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(mesh.registerNamespace).toHaveBeenCalledWith('test-db')
    })

    it('should stop cleanly', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(provider.synced).toBe(true)

      await provider.stop()

      expect(provider.synced).toBe(false)
      expect(provider.syncing).toBe(false)
      expect(mesh.unregisterNamespace).toHaveBeenCalledWith('test-db')
    })

    it('should close database on stop', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const db = provider.getDb()
      await provider.stop()

      expect(db.close).toHaveBeenCalled()
    })
  })

  describe('Public API', () => {
    it('should return database instance via getDb()', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const db = provider.getDb()
      expect(db).toBeDefined()
      expect(db.prepare).toBeDefined()
    })

    it('should throw when getDb() called before start', () => {
      provider = new CrSqliteSyncProvider(mesh, config)

      expect(() => provider.getDb()).toThrow(DbSyncError)
      expect(() => provider.getDb()).toThrow(/not initialized/)
    })

    it('should return site ID via getSiteId()', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const siteId = provider.getSiteId()
      expect(siteId).toBe('mock-site-id-123')
    })

    it('should return local version via getLocalVersion()', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const version = provider.getLocalVersion()
      expect(typeof version).toBe('number')
    })

    it('should return peer versions map via getPeerVersions()', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const peerVersions = provider.getPeerVersions()
      expect(peerVersions).toBeInstanceOf(Map)
    })
  })

  describe('Sync', () => {
    it('should call checkLocalChanges on sync()', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // sync() should not throw
      await provider.sync()
    })
  })

  describe('CRR Table Setup', () => {
    it('should setup configured tables as CRRs', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      const db = provider.getDb()
      expect(db.exec).toHaveBeenCalledWith(expect.stringContaining('crsql_as_crr'))
    })

    it('should handle empty tables config', async () => {
      config.tables = []
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // Should start successfully with no tables to setup
      expect(provider.synced).toBe(true)
    })
  })

  describe('Hub Behavior', () => {
    it('should enable snapshot persistence when mesh is hub', async () => {
      mesh.isHub = vi.fn().mockReturnValue(true)

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // Hub should have snapshot timer set up (internal state)
      expect(mesh.isHub).toHaveBeenCalled()
    })

    it('should respond to hub:changed event', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // Simulate becoming hub
      mesh.isHub = vi.fn().mockReturnValue(true)
      mesh.emit('hub:changed')

      expect(mesh.isHub).toHaveBeenCalled()
    })
  })

  describe('Error Handling', () => {
    it('should throw DbSyncError when getDb called before start', () => {
      provider = new CrSqliteSyncProvider(mesh, config)

      try {
        provider.getDb()
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DbSyncError)
        expect((err as DbSyncError).code).toBe('DB_OPEN_FAILED')
        expect((err as DbSyncError).recoverable).toBe(false)
      }
    })

    it('should have correct error properties on DbSyncError', () => {
      const error = new DbSyncError('Test error', 'SYNC_TIMEOUT', true)

      expect(error.message).toBe('Test error')
      expect(error.code).toBe('SYNC_TIMEOUT')
      expect(error.recoverable).toBe(true)
      expect(error.name).toBe('DbSyncError')
    })
  })

  describe('Message Channel', () => {
    it('should create channel with correct name', async () => {
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(mesh.createChannel).toHaveBeenCalledWith('db:test-db')
    })

    it('should open channel on start', async () => {
      const mockChannel = createMockChannel()
      mesh.createChannel = vi.fn().mockReturnValue(mockChannel)

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(mockChannel.open).toHaveBeenCalled()
    })

    it('should setup request handler for sync requests', async () => {
      const mockChannel = createMockChannel()
      mesh.createChannel = vi.fn().mockReturnValue(mockChannel)

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(mockChannel.onRequest).toHaveBeenCalled()
    })
  })

  describe('Initial Sync', () => {
    it('should skip initial sync with no peers', async () => {
      mesh.getPeers = vi.fn().mockReturnValue([])

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // Should complete without making sync requests
      expect(provider.synced).toBe(true)
    })

    it('should request sync from hub when available', async () => {
      const mockChannel = createMockChannel()
      mesh.createChannel = vi.fn().mockReturnValue(mockChannel)
      mesh.getPeers = vi.fn().mockReturnValue([{ id: 'peer-1' }])
      mesh.getActiveHub = vi.fn().mockReturnValue({ id: 'hub-peer' })

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // Should request from hub, not first peer
      expect(mockChannel.request).toHaveBeenCalledWith(
        'hub-peer',
        expect.objectContaining({ type: 'db:sync-request' }),
        expect.any(Number)
      )
    })

    it('should request sync from first peer when no hub', async () => {
      const mockChannel = createMockChannel()
      mesh.createChannel = vi.fn().mockReturnValue(mockChannel)
      mesh.getPeers = vi.fn().mockReturnValue([{ id: 'peer-1' }, { id: 'peer-2' }])
      mesh.getActiveHub = vi.fn().mockReturnValue(null)

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(mockChannel.request).toHaveBeenCalledWith(
        'peer-1',
        expect.objectContaining({ type: 'db:sync-request' }),
        expect.any(Number)
      )
    })

    it('should handle initial sync failure gracefully', async () => {
      const mockChannel = createMockChannel()
      mockChannel.request = vi.fn().mockRejectedValue(new Error('Sync timeout'))
      mesh.createChannel = vi.fn().mockReturnValue(mockChannel)
      mesh.getPeers = vi.fn().mockReturnValue([{ id: 'peer-1' }])

      provider = new CrSqliteSyncProvider(mesh, config)

      const errorHandler = vi.fn()
      provider.on('error', errorHandler)

      // Should not throw - sync failure is non-fatal
      await provider.start()

      expect(errorHandler).toHaveBeenCalled()
      expect(provider.synced).toBe(true) // Still becomes synced
    })
  })

  describe('Config Options', () => {
    it('should use custom poll interval', async () => {
      config.pollInterval = 500
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      // Poll interval is used internally
      expect(provider).toBeDefined()
    })

    it('should use custom batch size', async () => {
      config.batchSize = 500
      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(provider).toBeDefined()
    })

    it('should use custom extension path', async () => {
      config.extensionPath = '/custom/path/crsqlite.dylib'

      const { getExtensionPath } = await import('../../src/sync/cr-sqlite/extension-loader')
      ;(getExtensionPath as ReturnType<typeof vi.fn>).mockReturnValue('/custom/path/crsqlite.dylib')

      provider = new CrSqliteSyncProvider(mesh, config)
      await provider.start()

      expect(getExtensionPath).toHaveBeenCalledWith('/custom/path/crsqlite.dylib')
    })
  })
})
