import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { GitReconciler, ReconcileEvent } from '../../src/integrations/sudocode/git-reconciler'

describe('GitReconciler', () => {
  let tempDir: string
  let reconciler: GitReconciler

  beforeEach(async () => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-reconciler-test-'))

    // Create initial JSONL files
    fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-test1"}\n')
    fs.writeFileSync(path.join(tempDir, 'issues.jsonl'), '{"id": "i-test1"}\n')
  })

  afterEach(() => {
    // Stop reconciler
    if (reconciler) {
      reconciler.stop()
    }

    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('lifecycle', () => {
    it('should start with autoStart true', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      expect(reconciler.isRunning).toBe(true)
    })

    it('should not start with autoStart false', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: false,
      })

      expect(reconciler.isRunning).toBe(false)
    })

    it('should start when start() is called', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: false,
      })

      reconciler.start()
      expect(reconciler.isRunning).toBe(true)
    })

    it('should stop when stop() is called', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      reconciler.stop()
      expect(reconciler.isRunning).toBe(false)
    })

    it('should emit started event', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: false,
      })

      const startedHandler = vi.fn()
      reconciler.on('started', startedHandler)
      reconciler.start()

      expect(startedHandler).toHaveBeenCalled()
    })

    it('should emit stopped event', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const stoppedHandler = vi.fn()
      reconciler.on('stopped', stoppedHandler)
      reconciler.stop()

      expect(stoppedHandler).toHaveBeenCalled()
    })
  })

  describe('hash management', () => {
    it('should compute hashes for existing files', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const specsHash = reconciler.getFileHash('specs.jsonl')
      const issuesHash = reconciler.getFileHash('issues.jsonl')

      expect(specsHash).toBeDefined()
      expect(specsHash?.hash).toBeTruthy()
      expect(issuesHash).toBeDefined()
      expect(issuesHash?.hash).toBeTruthy()
    })

    it('should return all hashes', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const allHashes = reconciler.getAllHashes()
      expect(allHashes).toHaveLength(2)
    })

    it('should handle missing files gracefully', () => {
      // Delete one file
      fs.unlinkSync(path.join(tempDir, 'specs.jsonl'))

      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const specsHash = reconciler.getFileHash('specs.jsonl')
      expect(specsHash?.hash).toBeNull()
    })

    it('should update hashes on demand', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const originalHash = reconciler.getFileHash('specs.jsonl')?.hash

      // Modify file
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-test2"}\n')

      // Update hashes
      reconciler.updateAllHashes()

      const newHash = reconciler.getFileHash('specs.jsonl')?.hash
      expect(newHash).not.toBe(originalHash)
    })
  })

  describe('change detection', () => {
    it('should detect external file changes', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      // Modify file externally (simulating git)
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-new"}\n')

      const changedFiles = reconciler.checkForExternalChanges()
      expect(changedFiles).toContain('specs.jsonl')
    })

    it('should return empty array when no changes', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const changedFiles = reconciler.checkForExternalChanges()
      expect(changedFiles).toHaveLength(0)
    })

    it('should detect file deletion', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      // Delete file
      fs.unlinkSync(path.join(tempDir, 'specs.jsonl'))

      const changedFiles = reconciler.checkForExternalChanges()
      expect(changedFiles).toContain('specs.jsonl')
    })
  })

  describe('ignoreNextWrite', () => {
    it('should ignore next file change when flagged', async () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
        debounceMs: 10,
      })

      const reconcileHandler = vi.fn()
      reconciler.on('reconcile', reconcileHandler)

      // Flag to ignore
      reconciler.ignoreNextWrite()

      // Modify file
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-new"}\n')

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Should not have triggered reconcile
      expect(reconcileHandler).not.toHaveBeenCalled()
    })
  })

  describe('manual reconciliation check', () => {
    it('should return event when changes detected', async () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      // Modify file externally
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-new"}\n')

      const event = await reconciler.checkAndReconcile()

      expect(event).not.toBeNull()
      expect(event?.changedFiles).toContain('specs.jsonl')
      expect(event?.trigger).toBe('manual')
    })

    it('should return null when no changes', async () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const event = await reconciler.checkAndReconcile()
      expect(event).toBeNull()
    })

    it('should emit reconcile event', async () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      const reconcileHandler = vi.fn()
      reconciler.on('reconcile', reconcileHandler)

      // Modify file
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-new"}\n')

      await reconciler.checkAndReconcile()

      expect(reconcileHandler).toHaveBeenCalled()
      const event = reconcileHandler.mock.calls[0][0] as ReconcileEvent
      expect(event.changedFiles).toContain('specs.jsonl')
    })
  })

  describe('file watching', () => {
    it('should emit reconcile event on file change', async () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
        debounceMs: 10,
      })

      const reconcileHandler = vi.fn()
      reconciler.on('reconcile', reconcileHandler)

      // Wait a bit for watchers to be set up
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Modify file
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-changed"}\n')

      // Wait for debounce and processing
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(reconcileHandler).toHaveBeenCalled()
    })

    it('should debounce rapid changes', async () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
        debounceMs: 50,
      })

      const reconcileHandler = vi.fn()
      reconciler.on('reconcile', reconcileHandler)

      // Wait for watchers
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Make rapid changes
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-change1"}\n')
      await new Promise((resolve) => setTimeout(resolve, 10))
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-change2"}\n')
      await new Promise((resolve) => setTimeout(resolve, 10))
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-change3"}\n')

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Should only have one reconcile event (debounced)
      expect(reconcileHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('multiple file changes', () => {
    it('should detect changes to multiple files', () => {
      reconciler = new GitReconciler({
        projectPath: tempDir,
        autoStart: true,
      })

      // Modify both files
      fs.writeFileSync(path.join(tempDir, 'specs.jsonl'), '{"id": "s-new"}\n')
      fs.writeFileSync(path.join(tempDir, 'issues.jsonl'), '{"id": "i-new"}\n')

      const changedFiles = reconciler.checkForExternalChanges()
      expect(changedFiles).toHaveLength(2)
      expect(changedFiles).toContain('specs.jsonl')
      expect(changedFiles).toContain('issues.jsonl')
    })
  })
})
