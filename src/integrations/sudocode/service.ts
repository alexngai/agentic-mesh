// SudocodeMeshService - Orchestrates mesh sync for sudocode entities
// Implements: i-72gp

import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as Y from 'yjs'
import { NebulaMesh } from '../../mesh/nebula-mesh'
import { YjsSyncProvider } from '../../sync/yjs-provider'
import type { PeerInfo } from '../../types'
import type {
  SudocodeMeshConfig,
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
  EntityChangeEvent,
  EntityChangeSource,
  SudocodeEntityType,
} from './types'
import { EntityMapper } from './mapper'
import { JSONLBridge } from './jsonl-bridge'

const DEFAULT_SAVE_DEBOUNCE_MS = 500

export class SudocodeMeshService extends EventEmitter {
  private config: SudocodeMeshConfig
  private mesh: NebulaMesh | null = null
  private provider: YjsSyncProvider | null = null
  private mapper: EntityMapper
  private bridge: JSONLBridge
  private saveDebounceTimer: NodeJS.Timeout | null = null
  private _connected = false

  // CRDT maps
  private specs!: Y.Map<SpecCRDT>
  private issues!: Y.Map<IssueCRDT>
  private relationships!: Y.Map<RelationshipCRDT>
  private feedback!: Y.Map<FeedbackCRDT>

  constructor(config: SudocodeMeshConfig) {
    super()
    this.config = {
      ...config,
      saveDebounceMs: config.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS,
    }
    this.mapper = new EntityMapper()
    this.bridge = new JSONLBridge(config.projectPath)
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    if (this._connected) return

    // Ensure mesh directory exists
    await this.ensureMeshDirectory()

    // Create mesh connection
    this.mesh = new NebulaMesh(this.config.meshConfig)

    // Create sync provider with project namespace
    this.provider = new YjsSyncProvider(this.mesh, {
      namespace: `sudocode:${this.config.projectId}`,
    })

    // Initialize CRDT maps
    this.specs = this.provider.getMap<SpecCRDT>('specs')
    this.issues = this.provider.getMap<IssueCRDT>('issues')
    this.relationships = this.provider.getMap<RelationshipCRDT>('relationships')
    this.feedback = this.provider.getMap<FeedbackCRDT>('feedback')

    // Set up observers for remote changes
    this.setupObservers()

    // Connect to mesh
    await this.mesh.connect()

    // Load initial state from JSONL or CRDT snapshot
    await this.loadInitialState()

    // Start sync
    await this.provider.start()

    // Wire up sync events
    this.provider.on('synced', () => {
      this.emit('synced')
    })

    this._connected = true
    this.emit('connected')
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return

    // Clear debounce timer
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer)
      this.saveDebounceTimer = null
    }

    // Save final state
    await this.saveToJSONL()
    await this.saveCRDTSnapshot()

    // Stop provider
    if (this.provider) {
      await this.provider.stop()
      this.provider = null
    }

    // Disconnect mesh
    if (this.mesh) {
      await this.mesh.disconnect()
      this.mesh = null
    }

    this._connected = false
    this.emit('disconnected')
  }

  // ==========================================================================
  // State Accessors
  // ==========================================================================

  get connected(): boolean {
    return this._connected
  }

  get synced(): boolean {
    return this.provider?.synced ?? false
  }

  get peers(): PeerInfo[] {
    return this.mesh?.getPeers() ?? []
  }

  // ==========================================================================
  // Entity Sync Methods
  // ==========================================================================

  /**
   * Sync a spec change to CRDT
   */
  syncSpec(spec: SpecCRDT, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.specs.set(spec.id, spec)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Sync an issue change to CRDT
   */
  syncIssue(issue: IssueCRDT, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.issues.set(issue.id, issue)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Sync a relationship change to CRDT
   */
  syncRelationship(
    relationship: RelationshipCRDT,
    source: EntityChangeSource = 'local'
  ): void {
    if (!this.provider) throw new Error('Not connected')

    const key = `${relationship.from_id}:${relationship.to_id}:${relationship.relationship_type}`

    this.provider.doc.transact(() => {
      this.relationships.set(key, relationship)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Sync feedback change to CRDT
   */
  syncFeedback(fb: FeedbackCRDT, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.feedback.set(fb.id, fb)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete a spec from CRDT
   */
  deleteSpec(id: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.specs.delete(id)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete an issue from CRDT
   */
  deleteIssue(id: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.issues.delete(id)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete a relationship from CRDT
   */
  deleteRelationship(key: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.relationships.delete(key)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete feedback from CRDT
   */
  deleteFeedback(id: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    this.provider.doc.transact(() => {
      this.feedback.delete(id)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  // ==========================================================================
  // Read Access
  // ==========================================================================

  getSpec(id: string): SpecCRDT | undefined {
    return this.specs?.get(id)
  }

  getIssue(id: string): IssueCRDT | undefined {
    return this.issues?.get(id)
  }

  getAllSpecs(): SpecCRDT[] {
    return this.specs ? Array.from(this.specs.values()) : []
  }

  getAllIssues(): IssueCRDT[] {
    return this.issues ? Array.from(this.issues.values()) : []
  }

  getAllRelationships(): RelationshipCRDT[] {
    return this.relationships ? Array.from(this.relationships.values()) : []
  }

  getAllFeedback(): FeedbackCRDT[] {
    return this.feedback ? Array.from(this.feedback.values()) : []
  }

  // ==========================================================================
  // Reconciliation
  // ==========================================================================

  /**
   * Trigger "git wins" reconciliation
   * Called when JSONL files are updated externally (e.g., git pull)
   */
  async reconcileFromJSONL(): Promise<void> {
    if (!this.provider) throw new Error('Not connected')

    // Load fresh state from JSONL
    const state = await this.bridge.loadFromJSONL()

    // Rebuild CRDT from JSONL
    this.provider.doc.transact(() => {
      // Clear existing data
      this.specs.clear()
      this.issues.clear()
      this.relationships.clear()
      this.feedback.clear()

      // Populate from JSONL
      for (const spec of state.specs) {
        this.specs.set(spec.id, spec)
      }
      for (const issue of state.issues) {
        this.issues.set(issue.id, issue)
      }
      for (const rel of state.relationships) {
        const key = `${rel.from_id}:${rel.to_id}:${rel.relationship_type}`
        this.relationships.set(key, rel)
      }
      for (const fb of state.feedback) {
        this.feedback.set(fb.id, fb)
      }
    }, 'reconcile')

    this.emit('reconciled')
  }

  // ==========================================================================
  // Internal: Observers
  // ==========================================================================

  private setupObservers(): void {
    // Observe specs
    this.specs.observe((event) => {
      this.handleMapChange('spec', event, this.specs)
    })

    // Observe issues
    this.issues.observe((event) => {
      this.handleMapChange('issue', event, this.issues)
    })

    // Observe relationships
    this.relationships.observe((event) => {
      this.handleMapChange('relationship', event, this.relationships)
    })

    // Observe feedback
    this.feedback.observe((event) => {
      this.handleMapChange('feedback', event, this.feedback)
    })
  }

  private handleMapChange<T>(
    entityType: SudocodeEntityType,
    event: Y.YMapEvent<T>,
    map: Y.Map<T>
  ): void {
    const source = (event.transaction.origin as EntityChangeSource) ?? 'remote'

    // Only process remote changes
    if (source === 'local') return

    for (const [key, change] of event.changes.keys) {
      const entity = map.get(key)
      const action =
        change.action === 'add' ? 'create' : change.action === 'delete' ? 'delete' : 'update'

      const changeEvent: EntityChangeEvent<T | undefined> = {
        entityType,
        entity,
        source,
        action,
      }

      this.emit('entity:changed', changeEvent)
      this.emit(`${entityType}:changed`, changeEvent)

      // Schedule save for remote changes
      if (source === 'remote') {
        this.scheduleSave()
      }
    }
  }

  // ==========================================================================
  // Internal: Persistence
  // ==========================================================================

  private async ensureMeshDirectory(): Promise<void> {
    const meshDir = path.join(this.config.projectPath, 'mesh')
    await fs.mkdir(meshDir, { recursive: true })
  }

  private async loadInitialState(): Promise<void> {
    // Try to load CRDT snapshot first
    const snapshotLoaded = await this.loadCRDTSnapshot()

    if (!snapshotLoaded) {
      // No snapshot, load from JSONL
      const state = await this.bridge.loadFromJSONL()

      this.provider!.doc.transact(() => {
        for (const spec of state.specs) {
          this.specs.set(spec.id, spec)
        }
        for (const issue of state.issues) {
          this.issues.set(issue.id, issue)
        }
        for (const rel of state.relationships) {
          const key = `${rel.from_id}:${rel.to_id}:${rel.relationship_type}`
          this.relationships.set(key, rel)
        }
        for (const fb of state.feedback) {
          this.feedback.set(fb.id, fb)
        }
      }, 'local')
    }
  }

  private async loadCRDTSnapshot(): Promise<boolean> {
    try {
      const snapshotPath = path.join(this.config.projectPath, 'mesh', 'crdt-state.bin')
      const data = await fs.readFile(snapshotPath)
      Y.applyUpdate(this.provider!.doc, new Uint8Array(data))
      return true
    } catch {
      return false
    }
  }

  private async saveCRDTSnapshot(): Promise<void> {
    if (!this.provider) return

    const snapshotPath = path.join(this.config.projectPath, 'mesh', 'crdt-state.bin')
    const state = Y.encodeStateAsUpdate(this.provider.doc)
    await fs.writeFile(snapshotPath, state)
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer)
    }

    this.saveDebounceTimer = setTimeout(async () => {
      await this.saveToJSONL()
      await this.saveCRDTSnapshot()
    }, this.config.saveDebounceMs)
  }

  private async saveToJSONL(): Promise<void> {
    const state = {
      specs: this.getAllSpecs(),
      issues: this.getAllIssues(),
      relationships: this.getAllRelationships(),
      feedback: this.getAllFeedback(),
    }

    await this.bridge.saveToJSONL(state)
  }
}
