/**
 * Git Sync Client
 *
 * High-level API for git sync operations over agentic-mesh.
 * Provides convenient methods for MAP clients/agents to sync repos with peers.
 *
 * Usage:
 * ```typescript
 * const client = peer.git.createSyncClient('/path/to/local/repo')
 *
 * // Sync with a remote peer (fetch + merge)
 * await client.sync('peer-id', { branch: 'main' })
 *
 * // Pull changes from peer
 * await client.pull('peer-id', 'main')
 *
 * // Push changes to peer
 * await client.push('peer-id', 'main')
 *
 * // Clone from peer
 * await client.clone('peer-id', '/path/to/new/repo')
 * ```
 */

import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import type { GitTransportService } from './transport-service'

// =============================================================================
// Types
// =============================================================================

/** Options for sync operations */
export interface SyncOptions {
  /** Branch to sync (default: current branch) */
  branch?: string
  /** Remote name to use (default: mesh-<peerId>) */
  remoteName?: string
  /** Whether to push after pulling (bidirectional sync) */
  bidirectional?: boolean
  /** Force overwrite local changes */
  force?: boolean
  /** Rebase instead of merge */
  rebase?: boolean
}

/** Options for clone operations */
export interface CloneOptions {
  /** Branch to clone (default: default branch) */
  branch?: string
  /** Shallow clone depth */
  depth?: number
  /** Clone bare repository */
  bare?: boolean
}

/** Options for push operations */
export interface PushOptions {
  /** Force push */
  force?: boolean
  /** Set upstream */
  setUpstream?: boolean
  /** Push all branches */
  all?: boolean
  /** Push tags */
  tags?: boolean
}

/** Options for pull operations */
export interface PullOptions {
  /** Rebase instead of merge */
  rebase?: boolean
  /** Fast-forward only */
  ffOnly?: boolean
}

/** Result of a sync operation */
export interface SyncResult {
  /** Whether the sync was successful */
  success: boolean
  /** Operation that was performed */
  operation: 'fetch' | 'pull' | 'push' | 'clone' | 'sync'
  /** Peer ID involved */
  peerId: string
  /** Branch involved */
  branch?: string
  /** Commits fetched/pushed */
  commits?: string[]
  /** Error message if failed */
  error?: string
  /** Output from git commands */
  output?: string
}

/** Events emitted by the sync client */
export interface GitSyncClientEvents {
  'sync:start': (peerId: string, operation: string) => void
  'sync:progress': (peerId: string, message: string) => void
  'sync:complete': (result: SyncResult) => void
  'sync:error': (error: Error) => void
}

// =============================================================================
// Git Sync Client
// =============================================================================

export class GitSyncClient extends EventEmitter {
  private readonly repoPath: string
  private readonly service: GitTransportService
  private readonly httpPort: number

  constructor(
    repoPath: string,
    service: GitTransportService,
    httpPort: number = 3456
  ) {
    super()
    this.repoPath = repoPath
    this.service = service
    this.httpPort = httpPort
  }

  /**
   * Sync with a remote peer (fetch + optionally push)
   */
  async sync(peerId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const { branch, bidirectional = false } = options

    this.emit('sync:start', peerId, 'sync')

    try {
      // Ensure remote is configured
      await this.ensureRemote(peerId, options.remoteName)

      // Fetch from remote
      const fetchResult = await this.fetch(peerId, branch, options)
      if (!fetchResult.success) {
        return fetchResult
      }

      // Merge or rebase
      if (branch) {
        const mergeOutput = await this.runGit(
          options.rebase
            ? ['rebase', `${this.getRemoteName(peerId, options.remoteName)}/${branch}`]
            : ['merge', `${this.getRemoteName(peerId, options.remoteName)}/${branch}`, '--ff-only']
        )
        this.emit('sync:progress', peerId, mergeOutput)
      }

      // Push if bidirectional
      if (bidirectional) {
        const pushResult = await this.push(peerId, branch, { setUpstream: true })
        if (!pushResult.success) {
          return {
            ...pushResult,
            operation: 'sync',
          }
        }
      }

      const result: SyncResult = {
        success: true,
        operation: 'sync',
        peerId,
        branch,
      }

      this.emit('sync:complete', result)
      return result
    } catch (err) {
      const result: SyncResult = {
        success: false,
        operation: 'sync',
        peerId,
        branch,
        error: err instanceof Error ? err.message : String(err),
      }
      this.emit('sync:error', err instanceof Error ? err : new Error(String(err)))
      return result
    }
  }

  /**
   * Fetch from a remote peer
   */
  async fetch(
    peerId: string,
    branch?: string,
    options: SyncOptions = {}
  ): Promise<SyncResult> {
    this.emit('sync:start', peerId, 'fetch')

    try {
      await this.ensureRemote(peerId, options.remoteName)

      const remoteName = this.getRemoteName(peerId, options.remoteName)
      const args = ['fetch', remoteName]
      if (branch) {
        args.push(branch)
      }

      const output = await this.runGit(args)
      this.emit('sync:progress', peerId, output)

      const result: SyncResult = {
        success: true,
        operation: 'fetch',
        peerId,
        branch,
        output,
      }

      this.emit('sync:complete', result)
      return result
    } catch (err) {
      const result: SyncResult = {
        success: false,
        operation: 'fetch',
        peerId,
        branch,
        error: err instanceof Error ? err.message : String(err),
      }
      this.emit('sync:error', err instanceof Error ? err : new Error(String(err)))
      return result
    }
  }

  /**
   * Pull from a remote peer
   */
  async pull(
    peerId: string,
    branch?: string,
    options: PullOptions = {}
  ): Promise<SyncResult> {
    this.emit('sync:start', peerId, 'pull')

    try {
      await this.ensureRemote(peerId)

      const remoteName = this.getRemoteName(peerId)
      const args = ['pull']

      if (options.rebase) args.push('--rebase')
      if (options.ffOnly) args.push('--ff-only')

      args.push(remoteName)
      if (branch) args.push(branch)

      const output = await this.runGit(args)
      this.emit('sync:progress', peerId, output)

      const result: SyncResult = {
        success: true,
        operation: 'pull',
        peerId,
        branch,
        output,
      }

      this.emit('sync:complete', result)
      return result
    } catch (err) {
      const result: SyncResult = {
        success: false,
        operation: 'pull',
        peerId,
        branch,
        error: err instanceof Error ? err.message : String(err),
      }
      this.emit('sync:error', err instanceof Error ? err : new Error(String(err)))
      return result
    }
  }

  /**
   * Push to a remote peer
   */
  async push(
    peerId: string,
    branch?: string,
    options: PushOptions = {}
  ): Promise<SyncResult> {
    this.emit('sync:start', peerId, 'push')

    try {
      await this.ensureRemote(peerId)

      const remoteName = this.getRemoteName(peerId)
      const args = ['push']

      if (options.force) args.push('--force')
      if (options.setUpstream) args.push('--set-upstream')
      if (options.all) args.push('--all')
      if (options.tags) args.push('--tags')

      args.push(remoteName)
      if (branch) args.push(branch)

      const output = await this.runGit(args)
      this.emit('sync:progress', peerId, output)

      const result: SyncResult = {
        success: true,
        operation: 'push',
        peerId,
        branch,
        output,
      }

      this.emit('sync:complete', result)
      return result
    } catch (err) {
      const result: SyncResult = {
        success: false,
        operation: 'push',
        peerId,
        branch,
        error: err instanceof Error ? err.message : String(err),
      }
      this.emit('sync:error', err instanceof Error ? err : new Error(String(err)))
      return result
    }
  }

  /**
   * Clone from a remote peer
   */
  async clone(
    peerId: string,
    targetPath: string,
    options: CloneOptions = {}
  ): Promise<SyncResult> {
    this.emit('sync:start', peerId, 'clone')

    try {
      // Ensure parent directory exists
      const parentDir = join(targetPath, '..')
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true })
      }

      const meshUrl = this.getMeshUrl(peerId)
      const args = ['clone']

      if (options.branch) args.push('--branch', options.branch)
      if (options.depth) args.push('--depth', String(options.depth))
      if (options.bare) args.push('--bare')

      args.push(meshUrl, targetPath)

      // Run clone from parent directory (not the repo path)
      const output = execSync(`git ${args.join(' ')}`, {
        cwd: parentDir,
        encoding: 'utf8',
        env: this.getGitEnv(),
      })

      this.emit('sync:progress', peerId, output)

      const result: SyncResult = {
        success: true,
        operation: 'clone',
        peerId,
        branch: options.branch,
        output,
      }

      this.emit('sync:complete', result)
      return result
    } catch (err) {
      const result: SyncResult = {
        success: false,
        operation: 'clone',
        peerId,
        error: err instanceof Error ? err.message : String(err),
      }
      this.emit('sync:error', err instanceof Error ? err : new Error(String(err)))
      return result
    }
  }

  /**
   * List refs from a remote peer without fetching
   */
  async listRemoteRefs(peerId: string): Promise<{ ref: string; sha: string }[]> {
    await this.ensureRemote(peerId)

    const output = await this.runGit(['ls-remote', this.getRemoteName(peerId)])
    const lines = output.trim().split('\n').filter(Boolean)

    return lines.map((line) => {
      const [sha, ref] = line.split('\t')
      return { sha, ref }
    })
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(): Promise<string> {
    const output = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
    return output.trim()
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const output = await this.runGit(['status', '--porcelain'])
    return output.trim().length > 0
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private getRemoteName(peerId: string, customName?: string): string {
    return customName ?? `mesh-${peerId.replace(/[^a-zA-Z0-9]/g, '-')}`
  }

  private getMeshUrl(peerId: string): string {
    return `mesh://${peerId}/`
  }

  private async ensureRemote(peerId: string, customName?: string): Promise<void> {
    const remoteName = this.getRemoteName(peerId, customName)
    const meshUrl = this.getMeshUrl(peerId)

    try {
      // Check if remote exists
      const output = await this.runGit(['remote', 'get-url', remoteName])

      // Remote exists, check if URL matches
      if (output.trim() !== meshUrl) {
        await this.runGit(['remote', 'set-url', remoteName, meshUrl])
      }
    } catch {
      // Remote doesn't exist, add it
      await this.runGit(['remote', 'add', remoteName, meshUrl])
    }
  }

  private async runGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: this.repoPath,
        env: this.getGitEnv(),
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout + stderr)
        } else {
          reject(new Error(stderr || stdout || `git exited with code ${code}`))
        }
      })

      proc.on('error', reject)
    })
  }

  private getGitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // Tell git where to find the mesh remote helper
      GIT_TRANSPORT_MESH_PORT: String(this.httpPort),
      // Ensure git-remote-mesh is in PATH (assumes it's installed globally or via npm bin)
      PATH: `${process.env.PATH}:${join(__dirname, '..', '..', 'node_modules', '.bin')}`,
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/** Create a git sync client */
export function createGitSyncClient(
  repoPath: string,
  service: GitTransportService,
  httpPort?: number
): GitSyncClient {
  return new GitSyncClient(repoPath, service, httpPort)
}
