/**
 * Git Protocol Handler
 *
 * Handles git protocol operations (upload-pack, receive-pack) by delegating
 * to native git commands. This runs on the remote peer side.
 */

import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import type {
  GitProtocolHandler,
  GitTransportConfig,
  ListRefsRequest,
  ListRefsResponse,
  UploadPackRequest,
  UploadPackResponse,
  ReceivePackRequest,
  ReceivePackResponse,
  GitRef,
  GitCapability,
  GitAccessControl,
  GitAccessCheckResult,
  RefUpdateCommand,
  RefUpdateResult,
} from './types'
import { DEFAULT_GIT_TRANSPORT_CONFIG } from './types'

// =============================================================================
// Utility Functions
// =============================================================================

/** Convert buffer to base64 string */
function bufferToBase64(buffer: Buffer): string {
  return buffer.toString('base64')
}

/** Convert base64 string to buffer */
function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, 'base64')
}

/** Collect all data from a stream into a buffer */
async function streamToBuffer(
  stream: NodeJS.ReadableStream,
  maxSize?: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += buffer.length

    if (maxSize && totalSize > maxSize) {
      throw new GitProtocolError(
        'PACK_TOO_LARGE',
        `Pack size ${totalSize} exceeds maximum ${maxSize}`
      )
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

/** Execute a git command and return stdout */
async function execGit(
  args: string[],
  options: {
    cwd?: string
    stdin?: Buffer
    timeout?: number
  } = {}
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    proc.stdout.on('data', (chunk) => stdout.push(chunk))
    proc.stderr.on('data', (chunk) => stderr.push(chunk))

    if (options.stdin) {
      proc.stdin.write(options.stdin)
      proc.stdin.end()
    } else {
      proc.stdin.end()
    }

    const timeout = options.timeout
      ? setTimeout(() => {
          proc.kill('SIGTERM')
          reject(new GitProtocolError('TIMEOUT', 'Git command timed out'))
        }, options.timeout)
      : null

    proc.on('close', (code) => {
      if (timeout) clearTimeout(timeout)

      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        })
      } else {
        const stderrStr = Buffer.concat(stderr).toString('utf8')
        reject(
          new GitProtocolError(
            'GIT_ERROR',
            `Git command failed with code ${code}: ${stderrStr}`
          )
        )
      }
    })

    proc.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      reject(new GitProtocolError('SPAWN_ERROR', `Failed to spawn git: ${err.message}`))
    })
  })
}

// =============================================================================
// Error Class
// =============================================================================

/** Error class for git protocol errors */
export class GitProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'GitProtocolError'
  }
}

// =============================================================================
// Default Access Control
// =============================================================================

/** Default access control that allows all operations */
export class DefaultGitAccessControl implements GitAccessControl {
  async checkRead(_peerId: string): Promise<GitAccessCheckResult> {
    return { allowed: true, level: 'read' }
  }

  async checkWrite(_peerId: string): Promise<GitAccessCheckResult> {
    return { allowed: true, level: 'write' }
  }

  async checkRefUpdate(
    _peerId: string,
    _ref: string,
    _force: boolean
  ): Promise<GitAccessCheckResult> {
    return { allowed: true, level: 'write' }
  }

  async checkRefDelete(_peerId: string, _ref: string): Promise<GitAccessCheckResult> {
    return { allowed: true, level: 'write' }
  }
}

// =============================================================================
// Git Protocol Handler Implementation
// =============================================================================

export interface GitProtocolHandlerOptions {
  config?: Partial<GitTransportConfig>
  accessControl?: GitAccessControl
}

export class GitProtocolHandlerImpl
  extends EventEmitter
  implements GitProtocolHandler
{
  private config: GitTransportConfig
  private accessControl: GitAccessControl

  constructor(options: GitProtocolHandlerOptions = {}) {
    super()
    this.config = { ...DEFAULT_GIT_TRANSPORT_CONFIG, ...options.config }
    this.accessControl = options.accessControl ?? new DefaultGitAccessControl()
  }

  getConfig(): GitTransportConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<GitTransportConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * List refs in the repository
   */
  async listRefs(request: ListRefsRequest): Promise<ListRefsResponse> {
    const refs: GitRef[] = []

    // Get HEAD
    try {
      const { stdout: headTarget } = await execGit(
        ['symbolic-ref', 'HEAD'],
        { cwd: this.config.repoPath, timeout: 5000 }
      )
      const headTargetStr = headTarget.toString('utf8').trim()

      // Get HEAD SHA
      const { stdout: headSha } = await execGit(
        ['rev-parse', 'HEAD'],
        { cwd: this.config.repoPath, timeout: 5000 }
      )

      refs.push({
        sha: headSha.toString('utf8').trim(),
        name: 'HEAD',
        symref: headTargetStr,
      })
    } catch {
      // Repository might be empty or HEAD detached
    }

    // Get all refs using for-each-ref
    const refPrefix = request.refPrefix || 'refs/'
    const format = '%(objectname) %(refname) %(symref)'

    try {
      const { stdout } = await execGit(
        ['for-each-ref', `--format=${format}`, refPrefix],
        { cwd: this.config.repoPath, timeout: 10000 }
      )

      const lines = stdout.toString('utf8').trim().split('\n').filter(Boolean)

      for (const line of lines) {
        const parts = line.split(' ')
        const sha = parts[0]
        const name = parts[1]
        const symref = parts[2] || undefined

        if (sha && name) {
          refs.push({ sha, name, symref })
        }
      }
    } catch {
      // No refs found or other error
    }

    // Determine capabilities
    const capabilities: GitCapability[] = [
      'thin-pack',
      'side-band-64k',
      'symref',
      'object-format',
    ]

    if (this.config.clone.allowShallow) {
      capabilities.push('shallow')
    }

    if (this.config.clone.allowPartial) {
      capabilities.push('filter')
    }

    // Find HEAD target
    const headRef = refs.find((r) => r.name === 'HEAD')
    const head = headRef?.symref

    return { refs, capabilities, head }
  }

  /**
   * Handle fetch operation (git-upload-pack)
   */
  async uploadPack(request: UploadPackRequest): Promise<UploadPackResponse> {
    // Validate request
    if (!request.wants || request.wants.length === 0) {
      throw new GitProtocolError('INVALID_REQUEST', 'No wants specified')
    }

    // Check depth limits
    if (request.depth && this.config.clone.maxDepth) {
      if (request.depth > this.config.clone.maxDepth) {
        throw new GitProtocolError(
          'DEPTH_EXCEEDED',
          `Requested depth ${request.depth} exceeds maximum ${this.config.clone.maxDepth}`
        )
      }
    }

    // Check filter allowlist
    if (request.filter && this.config.clone.allowedFilters) {
      if (!this.config.clone.allowedFilters.includes(request.filter)) {
        throw new GitProtocolError(
          'FILTER_NOT_ALLOWED',
          `Filter '${request.filter}' is not allowed`
        )
      }
    }

    // Build upload-pack input
    const input = this.buildUploadPackInput(request)

    // Run git-upload-pack
    const { stdout: packData } = await execGit(
      ['upload-pack', '--stateless-rpc', this.config.repoPath],
      {
        cwd: this.config.repoPath,
        stdin: Buffer.from(input),
        timeout: this.config.operationTimeoutMs,
      }
    )

    // Check pack size
    if (this.config.maxPackSize && packData.length > this.config.maxPackSize) {
      throw new GitProtocolError(
        'PACK_TOO_LARGE',
        `Pack size ${packData.length} exceeds maximum ${this.config.maxPackSize}`
      )
    }

    return {
      packData: bufferToBase64(packData),
      ready: true,
    }
  }

  /**
   * Handle push operation (git-receive-pack)
   */
  async receivePack(request: ReceivePackRequest): Promise<ReceivePackResponse> {
    // Validate request
    if (!request.commands || request.commands.length === 0) {
      throw new GitProtocolError('INVALID_REQUEST', 'No commands specified')
    }

    // Validate each command against config
    const results: RefUpdateResult[] = []

    for (const cmd of request.commands) {
      // Check protected branches
      if (this.isProtectedBranch(cmd.dst)) {
        if (cmd.force && !this.config.push.allowNonFastForward) {
          results.push({
            ref: cmd.dst,
            status: 'rejected',
            reason: 'Force push to protected branch not allowed',
          })
          continue
        }
      }

      // Check delete permission
      if (cmd.delete && !this.config.push.allowDelete) {
        results.push({
          ref: cmd.dst,
          status: 'rejected',
          reason: 'Deleting refs is not allowed',
        })
        continue
      }

      // Mark as pending (will be processed by git-receive-pack)
      results.push({
        ref: cmd.dst,
        status: 'ok',
      })
    }

    // If all commands were rejected, return early
    if (results.every((r) => r.status === 'rejected')) {
      return { results }
    }

    // Build receive-pack input
    const input = this.buildReceivePackInput(request)

    try {
      // Run git-receive-pack
      await execGit(
        ['receive-pack', '--stateless-rpc', this.config.repoPath],
        {
          cwd: this.config.repoPath,
          stdin: input,
          timeout: this.config.operationTimeoutMs,
        }
      )

      // Mark successful commands as ok
      for (const result of results) {
        if (result.status !== 'rejected') {
          result.status = 'ok'
        }
      }
    } catch (err) {
      // Mark non-rejected commands as error
      for (const result of results) {
        if (result.status !== 'rejected') {
          result.status = 'error'
          result.reason = err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }

    return { results }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private isProtectedBranch(ref: string): boolean {
    const branchName = ref.replace(/^refs\/heads\//, '')
    return this.config.push.protectedBranches.some(
      (pattern) => branchName === pattern || ref === pattern
    )
  }

  private buildUploadPackInput(request: UploadPackRequest): string {
    const lines: string[] = []

    // Add wants
    for (const want of request.wants) {
      lines.push(this.pktLine(`want ${want}\n`))
    }

    // Add depth if specified
    if (request.depth) {
      lines.push(this.pktLine(`deepen ${request.depth}\n`))
    }

    // Add filter if specified
    if (request.filter) {
      lines.push(this.pktLine(`filter ${request.filter}\n`))
    }

    // Flush packet
    lines.push('0000')

    // Add haves
    for (const have of request.haves) {
      lines.push(this.pktLine(`have ${have}\n`))
    }

    // Done
    lines.push(this.pktLine('done\n'))

    return lines.join('')
  }

  private buildReceivePackInput(request: ReceivePackRequest): Buffer {
    const parts: Buffer[] = []

    // Add commands
    for (const cmd of request.commands) {
      const oldSha = cmd.oldSha || '0'.repeat(40)
      const newSha = cmd.delete ? '0'.repeat(40) : cmd.newSha || cmd.src
      const line = `${oldSha} ${newSha} ${cmd.dst}\n`
      parts.push(Buffer.from(this.pktLine(line)))
    }

    // Flush packet
    parts.push(Buffer.from('0000'))

    // Add pack data if present
    if (request.packData) {
      parts.push(base64ToBuffer(request.packData))
    }

    return Buffer.concat(parts)
  }

  private pktLine(data: string): string {
    const len = data.length + 4
    return len.toString(16).padStart(4, '0') + data
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/** Create a new git protocol handler */
export function createGitProtocolHandler(
  options?: GitProtocolHandlerOptions
): GitProtocolHandler {
  return new GitProtocolHandlerImpl(options)
}
