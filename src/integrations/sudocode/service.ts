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
  SyncableEntityType,
  IssueExecutionOptions,
  IssueExecutionResult,
  IssueExecutionRequestEvent,
  SudocodeAction,
  SudocodePermissionResult,
} from './types'
import { ALL_SYNCABLE_ENTITIES } from './types'
import { ExecutionRouter, type ExecutionRequestEvent } from '../../mesh/execution-router'
import { ExecutionStream, type StreamingExecutionRequestEvent } from '../../mesh/execution-stream'
import { GroupPermissions, PermissionLevel } from '../../certs/group-permissions'
import { EntityMapper } from './mapper'
import { JSONLBridge } from './jsonl-bridge'
import { GitReconciler, ReconcileEvent } from './git-reconciler'
import { SyncFilterEngine, type SyncFilter } from './sync-filter'
import { PartitionManager, type PartitionConfig, type PartitionInfo } from './partition-manager'

const DEFAULT_SAVE_DEBOUNCE_MS = 500

export class SudocodeMeshService extends EventEmitter {
  private config: SudocodeMeshConfig
  private mesh: NebulaMesh | null = null
  private provider: YjsSyncProvider | null = null
  private mapper: EntityMapper
  private bridge: JSONLBridge
  private gitReconciler: GitReconciler | null = null
  private executionRouter: ExecutionRouter | null = null
  private saveDebounceTimer: NodeJS.Timeout | null = null
  private _connected = false
  private syncEntities: Set<SyncableEntityType>
  private filterEngine: SyncFilterEngine
  private partitionManager: PartitionManager
  private permissions: GroupPermissions

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
    // Resolve syncEntities - default to all types
    this.syncEntities = new Set(config.syncEntities ?? ALL_SYNCABLE_ENTITIES)
    // Initialize filter engine with optional config
    this.filterEngine = new SyncFilterEngine(config.syncFilter)
    // Initialize partition manager with optional config
    this.partitionManager = new PartitionManager(config.projectId, config.partitionConfig)
    // Initialize permissions with optional config
    const permConfig = config.permissionConfig ?? {}
    this.permissions = new GroupPermissions({
      hierarchy: {
        admin: permConfig.adminGroups ?? ['admin', 'admins'],
        write: permConfig.developerGroups ?? ['developer', 'developers', 'editor', 'editors'],
        read: permConfig.readonlyGroups ?? ['readonly', 'viewer', 'viewers'],
      },
    })
  }

  // ==========================================================================
  // Entity Sync Filtering
  // ==========================================================================

  /**
   * Check if a specific entity type should be synced over the mesh.
   * Returns true if sync is enabled for this type.
   */
  shouldSyncEntityType(entityType: SyncableEntityType): boolean {
    return this.syncEntities.has(entityType)
  }

  /**
   * Get the list of entity types enabled for sync.
   */
  getSyncedEntityTypes(): SyncableEntityType[] {
    return Array.from(this.syncEntities)
  }

  // ==========================================================================
  // Fine-Grained Sync Filtering (ID/Attribute)
  // ==========================================================================

  /**
   * Set or update the sync filter at runtime.
   * Use this for fine-grained control over which entities sync.
   */
  setSyncFilter(filter: SyncFilter): void {
    this.filterEngine.setFilter(filter)
    this.emit('filter:changed', filter)
  }

  /**
   * Get the current sync filter configuration.
   */
  getSyncFilter(): SyncFilter {
    return this.filterEngine.getFilter()
  }

  /**
   * Clear all sync filters (sync everything that passes entity type filter).
   */
  clearSyncFilter(): void {
    this.filterEngine.clearFilter()
    this.emit('filter:cleared')
  }

  /**
   * Check if a specific spec passes the sync filter.
   */
  shouldSyncSpec(spec: SpecCRDT): boolean {
    return this.shouldSyncEntityType('specs') && this.filterEngine.shouldSyncSpec(spec)
  }

  /**
   * Check if a specific issue passes the sync filter.
   */
  shouldSyncIssue(issue: IssueCRDT): boolean {
    return this.shouldSyncEntityType('issues') && this.filterEngine.shouldSyncIssue(issue)
  }

  /**
   * Check if a specific relationship passes the sync filter.
   */
  shouldSyncRelationship(rel: RelationshipCRDT): boolean {
    return (
      this.shouldSyncEntityType('relationships') &&
      this.filterEngine.shouldSyncRelationship(rel)
    )
  }

  /**
   * Check if specific feedback passes the sync filter.
   */
  shouldSyncFeedback(fb: FeedbackCRDT): boolean {
    return this.shouldSyncEntityType('feedback') && this.filterEngine.shouldSyncFeedback(fb)
  }

  // ==========================================================================
  // Namespace Partitioning
  // ==========================================================================

  /**
   * Check if partitioning is enabled.
   */
  get partitioningEnabled(): boolean {
    return this.partitionManager.enabled
  }

  /**
   * Get the partition manager for advanced partition operations.
   */
  getPartitionManager(): PartitionManager {
    return this.partitionManager
  }

  /**
   * Set or update partition configuration at runtime.
   */
  setPartitionConfig(config: PartitionConfig): void {
    this.partitionManager.setConfig(config)
    this.emit('partition:config:changed', config)
  }

  /**
   * Subscribe to a partition (will sync entities in that partition).
   */
  subscribeToPartition(partition: string): void {
    this.partitionManager.subscribe(partition)
  }

  /**
   * Unsubscribe from a partition (will stop syncing entities in that partition).
   */
  unsubscribeFromPartition(partition: string): void {
    this.partitionManager.unsubscribe(partition)
  }

  /**
   * Get list of partitions this peer is subscribed to.
   */
  getSubscribedPartitions(): string[] {
    return this.partitionManager.getSubscriptions()
  }

  /**
   * Get all known partitions with subscription status.
   */
  getKnownPartitions(): PartitionInfo[] {
    return this.partitionManager.getKnownPartitions()
  }

  /**
   * Check if a spec should be synced (combines type, filter, and partition checks).
   */
  shouldSyncSpecWithPartition(spec: SpecCRDT): boolean {
    if (!this.shouldSyncSpec(spec)) return false
    return this.partitionManager.shouldSync('spec', spec)
  }

  /**
   * Check if an issue should be synced (combines type, filter, and partition checks).
   */
  shouldSyncIssueWithPartition(issue: IssueCRDT): boolean {
    if (!this.shouldSyncIssue(issue)) return false
    return this.partitionManager.shouldSync('issue', issue)
  }

  /**
   * Check if a relationship should be synced (combines type, filter, and partition checks).
   */
  shouldSyncRelationshipWithPartition(rel: RelationshipCRDT): boolean {
    if (!this.shouldSyncRelationship(rel)) return false
    return this.partitionManager.shouldSync('relationship', rel)
  }

  /**
   * Check if feedback should be synced (combines type, filter, and partition checks).
   */
  shouldSyncFeedbackWithPartition(fb: FeedbackCRDT): boolean {
    if (!this.shouldSyncFeedback(fb)) return false
    return this.partitionManager.shouldSync('feedback', fb)
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

    // Start git reconciler for "git wins" behavior
    this.gitReconciler = new GitReconciler({
      projectPath: this.config.projectPath,
      autoStart: true,
    })

    this.gitReconciler.on('reconcile', async (event: ReconcileEvent) => {
      await this.handleGitChange(event)
    })

    // Initialize execution router for remote execution
    this.executionRouter = new ExecutionRouter(this.mesh)
    this.setupExecutionHandlers()

    this._connected = true
    this.emit('connected')
  }

  /**
   * Set up execution event forwarding.
   */
  private setupExecutionHandlers(): void {
    if (!this.executionRouter) return

    // Forward execution request events for issue-based execution
    this.executionRouter.on('execution:requested', (event: ExecutionRequestEvent) => {
      this.emit('execution:requested', event)
    })

    this.executionRouter.on('execution:streaming', (event: StreamingExecutionRequestEvent) => {
      this.emit('execution:streaming', event)
    })
  }

  /**
   * Handle git-induced file changes.
   * Implements "git wins" reconciliation.
   */
  private async handleGitChange(event: ReconcileEvent): Promise<void> {
    this.emit('git:change', event)

    // Reconcile CRDT from JSONL (git wins)
    await this.reconcileFromJSONL()

    this.emit('git:reconciled', event)
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return

    // Clear debounce timer
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer)
      this.saveDebounceTimer = null
    }

    // Stop git reconciler
    if (this.gitReconciler) {
      this.gitReconciler.stop()
      this.gitReconciler = null
    }

    // Stop execution router
    if (this.executionRouter) {
      await this.executionRouter.stop()
      this.executionRouter = null
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
   * Sync a spec change to CRDT.
   * Skips sync if 'specs' entity type is not enabled or spec doesn't pass filter.
   */
  syncSpec(spec: SpecCRDT, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if specs sync is disabled or doesn't pass filter
    if (!this.shouldSyncSpec(spec)) {
      return
    }

    this.provider.doc.transact(() => {
      this.specs.set(spec.id, spec)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Sync an issue change to CRDT.
   * Skips sync if 'issues' entity type is not enabled or issue doesn't pass filter.
   */
  syncIssue(issue: IssueCRDT, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if issues sync is disabled or doesn't pass filter
    if (!this.shouldSyncIssue(issue)) {
      return
    }

    this.provider.doc.transact(() => {
      this.issues.set(issue.id, issue)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Sync a relationship change to CRDT.
   * Skips sync if 'relationships' entity type is not enabled or doesn't pass filter.
   */
  syncRelationship(
    relationship: RelationshipCRDT,
    source: EntityChangeSource = 'local'
  ): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if relationships sync is disabled or doesn't pass filter
    if (!this.shouldSyncRelationship(relationship)) {
      return
    }

    const key = `${relationship.from_id}:${relationship.to_id}:${relationship.relationship_type}`

    this.provider.doc.transact(() => {
      this.relationships.set(key, relationship)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Sync feedback change to CRDT.
   * Skips sync if 'feedback' entity type is not enabled or doesn't pass filter.
   */
  syncFeedback(fb: FeedbackCRDT, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if feedback sync is disabled or doesn't pass filter
    if (!this.shouldSyncFeedback(fb)) {
      return
    }

    this.provider.doc.transact(() => {
      this.feedback.set(fb.id, fb)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete a spec from CRDT.
   * Skips if 'specs' entity type is not enabled.
   */
  deleteSpec(id: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if specs sync is disabled
    if (!this.shouldSyncEntityType('specs')) {
      return
    }

    this.provider.doc.transact(() => {
      this.specs.delete(id)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete an issue from CRDT.
   * Skips if 'issues' entity type is not enabled.
   */
  deleteIssue(id: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if issues sync is disabled
    if (!this.shouldSyncEntityType('issues')) {
      return
    }

    this.provider.doc.transact(() => {
      this.issues.delete(id)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete a relationship from CRDT.
   * Skips if 'relationships' entity type is not enabled.
   */
  deleteRelationship(key: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if relationships sync is disabled
    if (!this.shouldSyncEntityType('relationships')) {
      return
    }

    this.provider.doc.transact(() => {
      this.relationships.delete(key)
    }, source)

    if (source === 'local') {
      this.scheduleSave()
    }
  }

  /**
   * Delete feedback from CRDT.
   * Skips if 'feedback' entity type is not enabled.
   */
  deleteFeedback(id: string, source: EntityChangeSource = 'local'): void {
    if (!this.provider) throw new Error('Not connected')

    // Skip if feedback sync is disabled
    if (!this.shouldSyncEntityType('feedback')) {
      return
    }

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

  /**
   * Map SudocodeEntityType to SyncableEntityType for filtering.
   */
  private entityTypeToSyncable(entityType: SudocodeEntityType): SyncableEntityType {
    const mapping: Record<SudocodeEntityType, SyncableEntityType> = {
      spec: 'specs',
      issue: 'issues',
      relationship: 'relationships',
      feedback: 'feedback',
    }
    return mapping[entityType]
  }

  private handleMapChange<T>(
    entityType: SudocodeEntityType,
    event: Y.YMapEvent<T>,
    map: Y.Map<T>
  ): void {
    const source = (event.transaction.origin as EntityChangeSource) ?? 'remote'

    // Only process remote changes
    if (source === 'local') return

    // Filter: ignore remote changes for disabled entity types
    const syncableType = this.entityTypeToSyncable(entityType)
    if (!this.shouldSyncEntityType(syncableType)) {
      return
    }

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

    // Tell git reconciler to ignore this write (we're the source)
    if (this.gitReconciler) {
      this.gitReconciler.ignoreNextWrite()
    }

    await this.bridge.saveToJSONL(state)

    // Update hashes so reconciler knows current state
    if (this.gitReconciler) {
      this.gitReconciler.updateAllHashes()
    }
  }

  /**
   * Manually trigger git reconciliation check.
   * Useful after operations like git pull, git checkout, etc.
   */
  async checkForGitChanges(): Promise<boolean> {
    if (!this.gitReconciler) return false

    const event = await this.gitReconciler.checkAndReconcile()
    return event !== null
  }

  // ==========================================================================
  // Remote Execution (Phase 9.3)
  // ==========================================================================

  /**
   * Request execution of an issue on a remote peer.
   *
   * @param peerId Target peer to execute on
   * @param issueId Issue ID to execute
   * @param options Execution options
   * @returns Execution result
   *
   * @example
   * ```typescript
   * const result = await meshService.requestExecution('bob-workstation', 'i-abc1', {
   *   agentType: 'claude-code',
   *   worktreeSync: 'squash'
   * })
   * ```
   */
  async requestExecution(
    peerId: string,
    issueId: string,
    options: IssueExecutionOptions = {}
  ): Promise<IssueExecutionResult> {
    if (!this.executionRouter) {
      throw new Error('Not connected')
    }

    // Validate issue exists locally
    const issue = this.getIssue(issueId)
    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`)
    }

    // Build command based on options
    const command = this.buildExecutionCommand(issueId, options)

    try {
      const response = await this.executionRouter.requestExecution(peerId, command, {
        timeout: options.timeout,
        cwd: this.config.projectPath,
      })

      return {
        success: response.success,
        issueId,
        peerId,
        exitCode: response.exitCode,
        output: response.stdout,
        error: response.error ?? response.stderr,
      }
    } catch (error) {
      return {
        success: false,
        issueId,
        peerId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Request streaming execution of an issue on a remote peer.
   * Returns an ExecutionStream for real-time output.
   *
   * @param peerId Target peer to execute on
   * @param issueId Issue ID to execute
   * @param options Execution options
   * @returns ExecutionStream for receiving output
   *
   * @example
   * ```typescript
   * const stream = meshService.requestExecutionWithStream('bob-workstation', 'i-abc1')
   * stream.on('stdout', (data) => console.log(data))
   * stream.on('exit', (code) => console.log('Done:', code))
   * ```
   */
  requestExecutionWithStream(
    peerId: string,
    issueId: string,
    options: IssueExecutionOptions = {}
  ): ExecutionStream {
    if (!this.executionRouter) {
      throw new Error('Not connected')
    }

    // Validate issue exists locally
    const issue = this.getIssue(issueId)
    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`)
    }

    // Build command based on options
    const command = this.buildExecutionCommand(issueId, options)

    return this.executionRouter.requestExecutionWithStream(peerId, command, {
      cwd: this.config.projectPath,
    })
  }

  /**
   * Build the execution command for an issue.
   */
  private buildExecutionCommand(issueId: string, options: IssueExecutionOptions): string {
    const parts = ['sudocode', 'exec', issueId]

    if (options.agentType) {
      parts.push('--agent', options.agentType)
    }

    if (options.worktreeSync) {
      parts.push('--worktree-sync', options.worktreeSync)
    }

    return parts.join(' ')
  }

  /**
   * Get the execution router for advanced operations.
   */
  getExecutionRouter(): ExecutionRouter | null {
    return this.executionRouter
  }

  // ==========================================================================
  // Permission Checking (Phase 9.5)
  // ==========================================================================

  /**
   * Check if a peer has permission for a specific action.
   *
   * Permission model:
   * - read: All groups can read
   * - write: developer/admin groups can write
   * - execute: developer/admin groups can execute
   * - admin: admin groups only
   *
   * @param peer The peer to check permissions for
   * @param action The action to check
   * @returns Permission check result
   *
   * @example
   * ```typescript
   * const result = meshService.checkPermission(peer, 'write')
   * if (result.allowed) {
   *   // Allow write operation
   * }
   * ```
   */
  checkPermission(peer: PeerInfo, action: SudocodeAction): SudocodePermissionResult {
    const level = this.actionToPermissionLevel(action)
    const result = this.permissions.checkPermission(peer.groups, level)

    return {
      allowed: result.allowed,
      action,
      peerGroups: peer.groups,
      requiredGroups: result.missingGroups,
    }
  }

  /**
   * Check if a peer can read entities.
   */
  canRead(peer: PeerInfo): boolean {
    return this.permissions.canRead(peer.groups)
  }

  /**
   * Check if a peer can write entities.
   */
  canWrite(peer: PeerInfo): boolean {
    return this.permissions.canWrite(peer.groups)
  }

  /**
   * Check if a peer can execute issues.
   */
  canExecute(peer: PeerInfo): boolean {
    // Execute requires write-level permissions
    return this.permissions.canWrite(peer.groups)
  }

  /**
   * Check if a peer has admin access.
   */
  canAdmin(peer: PeerInfo): boolean {
    return this.permissions.canAdmin(peer.groups)
  }

  /**
   * Enforce a permission, throwing an error if denied.
   */
  enforcePermission(peer: PeerInfo, action: SudocodeAction): void {
    const level = this.actionToPermissionLevel(action)
    this.permissions.enforcePermission(peer.groups, level)
  }

  /**
   * Get the GroupPermissions instance for advanced operations.
   */
  getPermissions(): GroupPermissions {
    return this.permissions
  }

  /**
   * Map action to permission level.
   */
  private actionToPermissionLevel(action: SudocodeAction): PermissionLevel {
    switch (action) {
      case 'admin':
        return PermissionLevel.ADMIN
      case 'write':
      case 'execute':
        return PermissionLevel.WRITE
      case 'read':
        return PermissionLevel.READ
      default:
        return PermissionLevel.NONE
    }
  }
}
