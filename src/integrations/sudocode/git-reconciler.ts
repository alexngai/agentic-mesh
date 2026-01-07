// GitReconciler - Detects git changes and triggers CRDT reconciliation
// Implements: i-2jru

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

export interface GitReconcilerConfig {
  /** Project path containing JSONL files */
  projectPath: string
  /** Debounce delay for file changes in ms. Default: 100 */
  debounceMs?: number
  /** Whether to start watching immediately. Default: true */
  autoStart?: boolean
}

export interface FileHashState {
  path: string
  hash: string | null
  lastModified: number
}

export interface ReconcileEvent {
  changedFiles: string[]
  trigger: 'git' | 'external' | 'manual'
  timestamp: Date
}

const DEFAULT_DEBOUNCE_MS = 100
const WATCHED_FILES = ['specs.jsonl', 'issues.jsonl']

export class GitReconciler extends EventEmitter {
  private config: Required<GitReconcilerConfig>
  private watchers: fs.FSWatcher[] = []
  private fileHashes: Map<string, FileHashState> = new Map()
  private debounceTimer: NodeJS.Timeout | null = null
  private pendingChanges: Set<string> = new Set()
  private isReconciling = false
  private running = false
  private ignoredFiles: Set<string> = new Set()

  constructor(config: GitReconcilerConfig) {
    super()
    this.config = {
      ...config,
      debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      autoStart: config.autoStart ?? true,
    }

    if (this.config.autoStart) {
      this.start()
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start watching JSONL files for changes.
   */
  start(): void {
    if (this.running) return

    // Initialize file hashes
    this.updateAllHashes()

    // Start file watchers
    for (const filename of WATCHED_FILES) {
      const filePath = path.join(this.config.projectPath, filename)
      try {
        const watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
          if (eventType === 'change') {
            this.handleFileChange(filename)
          }
        })

        watcher.on('error', () => {
          // File might not exist yet, that's okay
        })

        this.watchers.push(watcher)
      } catch {
        // File doesn't exist yet, watch the directory instead
        this.watchDirectory()
      }
    }

    // Also watch directory for new files
    this.watchDirectory()

    this.running = true
    this.emit('started')
  }

  /**
   * Stop watching files.
   */
  stop(): void {
    if (!this.running) return

    // Clear watchers
    for (const watcher of this.watchers) {
      watcher.close()
    }
    this.watchers = []

    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.pendingChanges.clear()
    this.ignoredFiles.clear()
    this.running = false
    this.emit('stopped')
  }

  /**
   * Check if reconciler is running.
   */
  get isRunning(): boolean {
    return this.running
  }

  // ==========================================================================
  // Hash Management
  // ==========================================================================

  /**
   * Update hashes for all watched files.
   * Call this after writing to JSONL to prevent false positives.
   */
  updateAllHashes(): void {
    for (const filename of WATCHED_FILES) {
      this.updateFileHash(filename)
    }
  }

  /**
   * Mark that the next change should be ignored (we're about to write).
   * Use this before writing to JSONL to prevent triggering reconciliation.
   */
  ignoreNextWrite(): void {
    // Add all watched files to ignore set
    for (const filename of WATCHED_FILES) {
      this.ignoredFiles.add(filename)
    }
  }

  /**
   * Get current hash state for a file.
   */
  getFileHash(filename: string): FileHashState | undefined {
    return this.fileHashes.get(filename)
  }

  /**
   * Get all file hash states.
   */
  getAllHashes(): FileHashState[] {
    return Array.from(this.fileHashes.values())
  }

  private updateFileHash(filename: string): void {
    const filePath = path.join(this.config.projectPath, filename)
    try {
      const stats = fs.statSync(filePath)
      const content = fs.readFileSync(filePath, 'utf-8')
      const hash = crypto.createHash('sha256').update(content).digest('hex')

      this.fileHashes.set(filename, {
        path: filePath,
        hash,
        lastModified: stats.mtimeMs,
      })
    } catch {
      this.fileHashes.set(filename, {
        path: filePath,
        hash: null,
        lastModified: 0,
      })
    }
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  /**
   * Check if JSONL files have been modified externally (e.g., by git).
   * Returns list of changed files.
   */
  checkForExternalChanges(): string[] {
    const changedFiles: string[] = []

    for (const filename of WATCHED_FILES) {
      const filePath = path.join(this.config.projectPath, filename)
      const previousState = this.fileHashes.get(filename)

      try {
        const stats = fs.statSync(filePath)
        const content = fs.readFileSync(filePath, 'utf-8')
        const currentHash = crypto.createHash('sha256').update(content).digest('hex')

        // Check if hash differs from what we expect
        if (previousState?.hash && previousState.hash !== currentHash) {
          changedFiles.push(filename)
        }
      } catch {
        // File doesn't exist or can't be read
        if (previousState?.hash) {
          // File was deleted
          changedFiles.push(filename)
        }
      }
    }

    return changedFiles
  }

  /**
   * Manually trigger reconciliation check.
   */
  async checkAndReconcile(): Promise<ReconcileEvent | null> {
    const changedFiles = this.checkForExternalChanges()

    if (changedFiles.length > 0) {
      const event: ReconcileEvent = {
        changedFiles,
        trigger: 'manual',
        timestamp: new Date(),
      }

      this.updateAllHashes()
      this.emit('reconcile', event)
      return event
    }

    return null
  }

  // ==========================================================================
  // Internal: File Watching
  // ==========================================================================

  private watchDirectory(): void {
    try {
      const watcher = fs.watch(
        this.config.projectPath,
        { persistent: false },
        (eventType, filename) => {
          if (filename && WATCHED_FILES.includes(filename)) {
            this.handleFileChange(filename)
          }
        }
      )

      watcher.on('error', () => {
        // Directory might not exist, that's okay
      })

      this.watchers.push(watcher)
    } catch {
      // Directory doesn't exist
    }
  }

  private handleFileChange(filename: string): void {
    // Check if we should ignore this file change
    if (this.ignoredFiles.has(filename)) {
      this.ignoredFiles.delete(filename)
      // Update hash to reflect our write
      this.updateFileHash(filename)
      return
    }

    // Add to pending changes
    this.pendingChanges.add(filename)

    // Debounce to avoid rapid reconciliation
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.processChanges()
    }, this.config.debounceMs)
  }

  private processChanges(): void {
    if (this.isReconciling || this.pendingChanges.size === 0) return

    this.isReconciling = true

    // Get files that actually changed (hash differs)
    const actuallyChanged: string[] = []

    for (const filename of this.pendingChanges) {
      const previousState = this.fileHashes.get(filename)
      const filePath = path.join(this.config.projectPath, filename)

      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const currentHash = crypto.createHash('sha256').update(content).digest('hex')

        if (!previousState?.hash || previousState.hash !== currentHash) {
          actuallyChanged.push(filename)
        }
      } catch {
        // File read error or doesn't exist
        if (previousState?.hash) {
          actuallyChanged.push(filename)
        }
      }
    }

    this.pendingChanges.clear()

    if (actuallyChanged.length > 0) {
      // Determine trigger type
      const trigger = this.detectTriggerType()

      const event: ReconcileEvent = {
        changedFiles: actuallyChanged,
        trigger,
        timestamp: new Date(),
      }

      // Update hashes to reflect new state
      this.updateAllHashes()

      // Emit reconcile event
      this.emit('reconcile', event)
    }

    this.isReconciling = false
  }

  private detectTriggerType(): 'git' | 'external' {
    // Try to detect if this is a git operation
    // Check for git lock files or recent git activity
    const gitLockPath = path.join(this.config.projectPath, '..', '.git', 'index.lock')
    const gitHeadPath = path.join(this.config.projectPath, '..', '.git', 'HEAD')

    try {
      // If git lock exists, a git operation is in progress
      if (fs.existsSync(gitLockPath)) {
        return 'git'
      }

      // Check if HEAD was modified recently (within last 5 seconds)
      const headStats = fs.statSync(gitHeadPath)
      const headAge = Date.now() - headStats.mtimeMs
      if (headAge < 5000) {
        return 'git'
      }
    } catch {
      // Git directory doesn't exist or not accessible
    }

    return 'external'
  }
}
