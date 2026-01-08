// CrSqliteSyncProvider - SQLite CRDT Sync Provider
// Implements: s-iidh, i-64xr

import Database from 'better-sqlite3'
import { SyncProvider } from '../provider'
import { MessageChannel } from '../../channel'
import type { MeshContext, PeerInfo } from '../../types'
import type { NebulaMesh } from '../../mesh/nebula-mesh'
import { getExtensionPath } from './extension-loader'
import {
  CrSqliteSyncConfig,
  DbSyncMessages,
  DbSyncError,
  CrSqliteChangeset,
  DbSyncRequest,
  DbSyncResponse,
  DbChangesMessage,
  DbVersionMessage,
} from './types'

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLL_INTERVAL = 100
const DEFAULT_BATCH_SIZE = 1000

// =============================================================================
// CrSqliteSyncProvider
// =============================================================================

// Wire message format for the channel
interface DbWireMessage {
  type: keyof DbSyncMessages
  payload: DbSyncMessages[keyof DbSyncMessages]
}

export class CrSqliteSyncProvider extends SyncProvider {
  private config: CrSqliteSyncConfig
  private db: Database.Database | null = null
  private channel: MessageChannel<DbWireMessage> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null

  private localVersion: number = 0
  private siteId: string = ''
  private peerVersions: Map<string, number> = new Map()

  private _synced: boolean = false
  private _syncing: boolean = false

  constructor(mesh: MeshContext, config: CrSqliteSyncConfig) {
    super(mesh, config)
    this.config = config
  }

  // ===========================================================================
  // SyncProvider Interface
  // ===========================================================================

  get synced(): boolean {
    return this._synced
  }

  get syncing(): boolean {
    return this._syncing
  }

  async start(): Promise<void> {
    try {
      // 1. Open database and load cr-sqlite extension
      this.db = new Database(this.config.dbPath)
      const extensionPath = getExtensionPath(this.config.extensionPath)
      this.db.loadExtension(extensionPath)

      // 2. Get our site ID
      this.siteId = this.db.prepare('SELECT crsql_site_id()').pluck().get() as string

      // 3. Ensure configured tables are CRRs
      await this.setupCrrTables()

      // 4. Get current version
      this.localVersion = this.getCurrentVersion()

      // 5. Create message channel
      const meshInstance = this.mesh as NebulaMesh
      this.channel = meshInstance.createChannel<DbWireMessage>(`db:${this.namespace}`)
      await this.channel.open()
      this.setupMessageHandlers()

      // 6. Register namespace
      await this.mesh.registerNamespace(this.namespace)

      // 7. Setup hub behavior if applicable
      this.setupHubBehavior()

      // 8. Initial sync from existing peers
      this._syncing = true
      this.emit('syncing')
      await this.initialSync()

      // 9. Start polling for local changes
      this.startPolling()

      this._syncing = false
      this._synced = true
      this.emit('synced')
    } catch (err) {
      const error = err instanceof DbSyncError ? err : new DbSyncError(
        `Failed to start CrSqliteSyncProvider: ${(err as Error).message}`,
        'DB_OPEN_FAILED',
        false
      )
      this.emit('error', error)
      throw error
    }
  }

  async stop(): Promise<void> {
    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // Stop snapshot timer
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }

    // Unregister namespace
    await this.mesh.unregisterNamespace(this.namespace)

    // Close database
    if (this.db) {
      this.db.close()
      this.db = null
    }

    this._synced = false
    this._syncing = false
  }

  async sync(): Promise<void> {
    // Force immediate sync - check for local changes and broadcast
    this.checkLocalChanges()
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get the underlying better-sqlite3 database instance.
   * Use this to run queries on the synced database.
   */
  getDb(): Database.Database {
    if (!this.db) {
      throw new DbSyncError('Database not initialized', 'DB_OPEN_FAILED', false)
    }
    return this.db
  }

  /**
   * Get the cr-sqlite site ID for this peer.
   */
  getSiteId(): string {
    return this.siteId
  }

  /**
   * Get the current local version.
   */
  getLocalVersion(): number {
    return this.localVersion
  }

  /**
   * Get versions known for each peer.
   */
  getPeerVersions(): Map<string, number> {
    return new Map(this.peerVersions)
  }

  // ===========================================================================
  // Setup Methods
  // ===========================================================================

  private async setupCrrTables(): Promise<void> {
    if (!this.db) return

    const tables = this.config.tables
    if (!tables || tables.length === 0) return

    for (const table of tables) {
      try {
        // Check if table exists
        const exists = this.db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table)

        if (!exists) {
          // Table doesn't exist - skip (will be created by app)
          continue
        }

        // Upgrade to CRR (idempotent)
        this.db.exec(`SELECT crsql_as_crr('${table}')`)
      } catch (err) {
        throw new DbSyncError(
          `Failed to setup CRR for table '${table}': ${(err as Error).message}`,
          'TABLE_NOT_CRR',
          false
        )
      }
    }
  }

  private getCurrentVersion(): number {
    if (!this.db) return 0

    const result = this.db.prepare(
      'SELECT COALESCE(MAX(db_version), 0) as version FROM crsql_changes'
    ).get() as { version: number }

    return result.version
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private setupMessageHandlers(): void {
    if (!this.channel) return

    // Handle sync requests via RPC
    this.channel.onRequest(async (message: DbWireMessage, from: PeerInfo) => {
      if (message.type === 'db:sync-request') {
        return this.handleSyncRequest(message.payload as DbSyncRequest)
      }
      return null
    })

    // Handle incoming messages
    this.channel.on('message', (message: DbWireMessage, from: PeerInfo) => {
      switch (message.type) {
        case 'db:changes': {
          const payload = message.payload as DbChangesMessage
          this.applyChangesets(payload.changesets, from.id)
          this.peerVersions.set(from.id, payload.version)
          break
        }
        case 'db:version': {
          const payload = message.payload as DbVersionMessage
          this.peerVersions.set(from.id, payload.version)
          break
        }
      }
    })
  }

  private handleSyncRequest(request: DbSyncRequest): DbSyncResponse {
    if (!this.db) {
      return { changesets: [], fromVersion: 0, toVersion: 0, hasMore: false }
    }

    const batchSize = this.config.batchSize ?? DEFAULT_BATCH_SIZE
    const tables = request.tables.length > 0 ? request.tables : this.config.tables

    let query = `
      SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id"
      FROM crsql_changes
      WHERE db_version > ?
    `

    const params: unknown[] = [request.sinceVersion]

    // Add table filter
    if (tables && tables.length > 0) {
      query += ` AND "table" IN (${tables.map(() => '?').join(',')})`
      params.push(...tables)
    }

    // Add scope filter
    query += this.buildScopeFilter(params)

    query += ` ORDER BY db_version LIMIT ?`
    params.push(batchSize + 1) // +1 to detect hasMore

    const rows = this.db.prepare(query).all(...params) as CrSqliteChangeset[]

    const hasMore = rows.length > batchSize
    const changesets = hasMore ? rows.slice(0, batchSize) : rows

    const toVersion = changesets.length > 0
      ? Math.max(...changesets.map(c => c.db_version))
      : request.sinceVersion

    return {
      changesets: changesets.map(c => this.serializeChangeset(c)),
      fromVersion: request.sinceVersion,
      toVersion,
      hasMore,
    }
  }

  // ===========================================================================
  // Change Detection & Broadcasting
  // ===========================================================================

  private startPolling(): void {
    const interval = this.config.pollInterval ?? DEFAULT_POLL_INTERVAL
    this.pollTimer = setInterval(() => {
      this.checkLocalChanges()
    }, interval)
  }

  private checkLocalChanges(): void {
    if (!this.db || !this.channel) return

    let query = `
      SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id"
      FROM crsql_changes
      WHERE db_version > ?
    `

    const params: unknown[] = [this.localVersion]

    // Add table filter
    if (this.config.tables && this.config.tables.length > 0) {
      query += ` AND "table" IN (${this.config.tables.map(() => '?').join(',')})`
      params.push(...this.config.tables)
    }

    // Add scope filter
    query += this.buildScopeFilter(params)

    query += ` ORDER BY db_version`

    const changes = this.db.prepare(query).all(...params) as CrSqliteChangeset[]

    if (changes.length > 0) {
      const newVersion = Math.max(...changes.map(c => c.db_version))
      const serialized = changes.map(c => this.serializeChangeset(c))

      // Broadcast to peers
      this.channel.broadcast({
        type: 'db:changes',
        payload: {
          changesets: serialized,
          version: newVersion,
        },
      })

      this.localVersion = newVersion

      // Emit event grouped by table
      const byTable = new Map<string, number>()
      for (const c of changes) {
        byTable.set(c.table, (byTable.get(c.table) ?? 0) + 1)
      }
      for (const [table, count] of byTable) {
        this.emit('change:sent', table, count)
      }
    }
  }

  // ===========================================================================
  // Applying Remote Changes
  // ===========================================================================

  private applyChangesets(changesets: CrSqliteChangeset[], fromPeer: string): void {
    if (!this.db || changesets.length === 0) return

    const insert = this.db.prepare(`
      INSERT INTO crsql_changes
        ("table", "pk", "cid", "val", "col_version", "db_version", "site_id")
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    try {
      const applyAll = this.db.transaction((changes: CrSqliteChangeset[]) => {
        for (const c of changes) {
          const siteId = typeof c.site_id === 'string'
            ? Buffer.from(c.site_id, 'hex')
            : c.site_id

          insert.run(c.table, c.pk, c.cid, c.val, c.col_version, c.db_version, siteId)

          // Parse pk for event emission
          let pk: unknown
          try {
            pk = JSON.parse(c.pk)
          } catch {
            pk = c.pk
          }

          this.emit('change:applied', c.table, pk)
        }
      })

      applyAll(changesets)

      // Update local version
      const maxVersion = Math.max(...changesets.map(c => c.db_version))
      if (maxVersion > this.localVersion) {
        this.localVersion = maxVersion
      }
    } catch (err) {
      const error = new DbSyncError(
        `Failed to apply changesets from ${fromPeer}: ${(err as Error).message}`,
        'APPLY_FAILED',
        true
      )
      this.emit('error', error)
    }
  }

  // ===========================================================================
  // Initial Sync
  // ===========================================================================

  private async initialSync(): Promise<void> {
    if (!this.channel) return

    const peers = this.mesh.getPeers()
    if (peers.length === 0) {
      // First peer, nothing to sync
      return
    }

    // Prefer hub for initial sync
    const hub = this.mesh.getActiveHub()
    const syncTarget = hub?.id ?? peers[0].id

    try {
      let sinceVersion = 0
      let hasMore = true

      while (hasMore) {
        const response = await this.channel.request<DbSyncResponse>(syncTarget, {
          type: 'db:sync-request',
          payload: {
            tables: this.config.tables ?? [],
            sinceVersion,
          },
        }, 30000)

        if (response.changesets.length > 0) {
          this.applyChangesets(response.changesets, syncTarget)
        }

        sinceVersion = response.toVersion
        hasMore = response.hasMore
      }

      // Announce our version
      this.channel.broadcast({
        type: 'db:version',
        payload: {
          siteId: this.siteId,
          version: this.localVersion,
        },
      })
    } catch (err) {
      // Initial sync failure is not fatal - we can still work offline
      const error = new DbSyncError(
        `Initial sync failed: ${(err as Error).message}`,
        'SYNC_TIMEOUT',
        true
      )
      this.emit('error', error)
    }
  }

  // ===========================================================================
  // Hub Behavior
  // ===========================================================================

  private setupHubBehavior(): void {
    if (this.mesh.isHub()) {
      this.enableSnapshotPersistence()
    }

    this.mesh.on('hub:changed', () => {
      if (this.mesh.isHub()) {
        this.enableSnapshotPersistence()
      } else {
        this.disableSnapshotPersistence()
      }
    })
  }

  private enableSnapshotPersistence(): void {
    // Save snapshot every 60 seconds when hub
    this.snapshotTimer = setInterval(() => {
      this.saveSnapshot()
    }, 60_000)
  }

  private disableSnapshotPersistence(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
  }

  private async saveSnapshot(): Promise<void> {
    if (!this.db) return

    const snapshotPath = `${this.config.dbPath}.snapshot`
    try {
      await this.db.backup(snapshotPath)
      this.emit('snapshot:saved', snapshotPath)
    } catch (err) {
      // Snapshot failure is not critical
      console.warn(`Failed to save snapshot: ${(err as Error).message}`)
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private buildScopeFilter(params: unknown[]): string {
    if (!this.config.scope) return ''

    // Note: Scope filtering requires joining with the actual table
    // For now, we'll filter in memory after retrieval
    // A more efficient implementation would use table-specific queries
    return ''
  }

  private serializeChangeset(c: CrSqliteChangeset): CrSqliteChangeset {
    return {
      table: c.table,
      pk: c.pk,
      cid: c.cid,
      val: c.val,
      col_version: c.col_version,
      db_version: c.db_version,
      site_id: Buffer.isBuffer(c.site_id)
        ? (c.site_id as Buffer).toString('hex')
        : c.site_id,
    }
  }
}
