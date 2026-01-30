#!/usr/bin/env node
/**
 * git-remote-mesh
 *
 * Git remote helper for mesh:// URLs. This binary is spawned by git
 * when you use URLs like: git fetch mesh://peer-id/repo
 *
 * It communicates with the local MeshPeer HTTP server to forward
 * git operations to remote peers over agentic-mesh.
 *
 * Usage:
 *   git remote add peer mesh://peer-id-abc123
 *   git fetch peer main
 *   git push peer feature-branch
 *
 * Environment variables:
 *   MESH_PEER_URL - URL of local MeshPeer (default: http://localhost:3456)
 *   GIT_REMOTE_MESH_VERBOSE - Enable verbose logging
 */

import { createInterface, Interface as ReadlineInterface } from 'readline'
import { execSync, spawn } from 'child_process'
import type {
  GitRemoteHelperConfig,
  MeshGitUrl,
  ListRefsResponse,
  UploadPackResponse,
  ReceivePackResponse,
  GitRef,
  RefUpdateCommand,
} from './types'
import { DEFAULT_GIT_REMOTE_HELPER_CONFIG } from './types'

// =============================================================================
// Configuration
// =============================================================================

function getConfig(): GitRemoteHelperConfig {
  return {
    meshPeerUrl: process.env.MESH_PEER_URL ?? DEFAULT_GIT_REMOTE_HELPER_CONFIG.meshPeerUrl,
    connectionTimeoutMs:
      parseInt(process.env.GIT_REMOTE_MESH_CONNECTION_TIMEOUT ?? '', 10) ||
      DEFAULT_GIT_REMOTE_HELPER_CONFIG.connectionTimeoutMs,
    operationTimeoutMs:
      parseInt(process.env.GIT_REMOTE_MESH_OPERATION_TIMEOUT ?? '', 10) ||
      DEFAULT_GIT_REMOTE_HELPER_CONFIG.operationTimeoutMs,
    verbose: process.env.GIT_REMOTE_MESH_VERBOSE === '1' || process.env.GIT_REMOTE_MESH_VERBOSE === 'true',
  }
}

// =============================================================================
// URL Parsing
// =============================================================================

function parseMeshUrl(url: string): MeshGitUrl {
  // Format: mesh://peer-id or mesh://peer-id/path
  const match = url.match(/^mesh:\/\/([^\/]+)(\/.*)?$/)
  if (!match) {
    throw new Error(`Invalid mesh URL: ${url}`)
  }

  return {
    protocol: 'mesh',
    peerId: match[1],
    repoPath: match[2] || '/',
  }
}

// =============================================================================
// HTTP Client
// =============================================================================

async function meshRequest<T>(
  config: GitRemoteHelperConfig,
  endpoint: string,
  body: unknown
): Promise<T> {
  const url = `${config.meshPeerUrl}${endpoint}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.operationTimeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`
      try {
        const errorJson = JSON.parse(errorBody)
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message
        }
      } catch {
        // Use default message
      }
      throw new Error(errorMessage)
    }

    return (await response.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

// =============================================================================
// Git Remote Helper Implementation
// =============================================================================

class GitRemoteMesh {
  private readonly config: GitRemoteHelperConfig
  private readonly meshUrl: MeshGitUrl
  private verbosity = 0
  private progress = true

  constructor(url: string) {
    this.config = getConfig()
    this.meshUrl = parseMeshUrl(url)

    if (this.config.verbose) {
      this.log(`Parsed URL: peer=${this.meshUrl.peerId} path=${this.meshUrl.repoPath}`)
    }
  }

  private log(message: string): void {
    if (this.config.verbose || this.verbosity > 0) {
      process.stderr.write(`git-remote-mesh: ${message}\n`)
    }
  }

  async run(): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

    for await (const line of rl) {
      const trimmed = line.trim()

      if (this.config.verbose) {
        this.log(`< ${trimmed || '(empty line)'}`)
      }

      // Empty line = end of session
      if (!trimmed) {
        break
      }

      const [cmd, ...args] = trimmed.split(' ')

      try {
        switch (cmd) {
          case 'capabilities':
            await this.handleCapabilities()
            break

          case 'list':
            await this.handleList(args.includes('for-push'))
            break

          case 'fetch':
            await this.handleFetch(args[0], args[1], rl)
            break

          case 'push':
            await this.handlePush(args[0], rl)
            break

          case 'option':
            this.handleOption(args[0], args.slice(1).join(' '))
            break

          default:
            this.log(`Unknown command: ${cmd}`)
            process.exit(1)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        process.stderr.write(`fatal: ${message}\n`)
        process.exit(128)
      }
    }
  }

  // ==========================================================================
  // Command Handlers
  // ==========================================================================

  private async handleCapabilities(): Promise<void> {
    // Advertise our capabilities to git
    this.output('fetch')
    this.output('push')
    this.output('option')
    this.output('') // End capabilities
  }

  private async handleList(forPush: boolean): Promise<void> {
    const response = await meshRequest<ListRefsResponse>(
      this.config,
      '/git/list-refs',
      {
        peerId: this.meshUrl.peerId,
        forPush,
      }
    )

    // Output refs in git format
    for (const ref of response.refs) {
      if (ref.symref) {
        // Symref format: @symref-target HEAD
        this.output(`@${ref.symref} ${ref.name}`)
      } else {
        this.output(`${ref.sha} ${ref.name}`)
      }
    }

    this.output('') // End list
  }

  private async handleFetch(
    sha: string,
    ref: string,
    rl: ReadlineInterface
  ): Promise<void> {
    // Collect all fetch commands until blank line
    const fetches: Array<{ sha: string; ref: string }> = [{ sha, ref }]

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) break

      const parts = trimmed.split(' ')
      if (parts[0] === 'fetch') {
        fetches.push({ sha: parts[1], ref: parts[2] })
      }
    }

    this.log(`Fetching ${fetches.length} refs from ${this.meshUrl.peerId}`)

    // Get local haves for negotiation
    const haves = this.getLocalHaves()

    // Request pack from mesh peer
    const response = await meshRequest<UploadPackResponse>(
      this.config,
      '/git/upload-pack',
      {
        peerId: this.meshUrl.peerId,
        wants: fetches.map((f) => f.sha),
        haves,
        noProgress: !this.progress,
      }
    )

    // Write pack to git via index-pack
    if (response.packData) {
      await this.indexPack(Buffer.from(response.packData, 'base64'))
    }

    this.output('') // Done
  }

  private async handlePush(
    refspec: string,
    rl: ReadlineInterface
  ): Promise<void> {
    // Collect all push commands
    const pushes: RefUpdateCommand[] = [this.parseRefspec(refspec)]

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) break

      if (trimmed.startsWith('push ')) {
        pushes.push(this.parseRefspec(trimmed.slice(5)))
      }
    }

    this.log(`Pushing ${pushes.length} refs to ${this.meshUrl.peerId}`)

    // Resolve local SHAs
    const commands: RefUpdateCommand[] = pushes.map((p) => ({
      ...p,
      newSha: p.delete ? undefined : this.resolveRef(p.src),
    }))

    // Create pack of objects to send (only if there are non-delete commands)
    const nonDeleteCommands = commands.filter((c) => !c.delete)
    const packData = nonDeleteCommands.length > 0
      ? await this.createPack(nonDeleteCommands)
      : undefined

    // Send to mesh peer
    const response = await meshRequest<ReceivePackResponse>(
      this.config,
      '/git/receive-pack',
      {
        peerId: this.meshUrl.peerId,
        commands,
        packData: packData?.toString('base64'),
      }
    )

    // Report results to git
    for (const result of response.results) {
      if (result.status === 'ok') {
        this.output(`ok ${result.ref}`)
      } else {
        this.output(`error ${result.ref} ${result.reason || 'rejected'}`)
      }
    }

    this.output('') // Done
  }

  private handleOption(name: string, value: string): void {
    switch (name) {
      case 'verbosity':
        this.verbosity = parseInt(value, 10)
        this.output('ok')
        break

      case 'progress':
        this.progress = value === 'true'
        this.output('ok')
        break

      default:
        this.output('unsupported')
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private output(line: string): void {
    if (this.config.verbose) {
      this.log(`> ${line || '(empty line)'}`)
    }
    process.stdout.write(line + '\n')
  }

  private parseRefspec(refspec: string): RefUpdateCommand {
    // Handle force push prefix
    const force = refspec.startsWith('+')
    const spec = force ? refspec.slice(1) : refspec

    // Handle delete (empty src)
    if (spec.startsWith(':')) {
      return {
        src: '',
        dst: spec.slice(1),
        force,
        delete: true,
      }
    }

    const [src, dst] = spec.split(':')
    return {
      src,
      dst: dst || src,
      force,
      delete: false,
    }
  }

  private getLocalHaves(): string[] {
    try {
      const output = execSync('git rev-parse --all', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      return output.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  private resolveRef(ref: string): string {
    try {
      const output = execSync(`git rev-parse ${ref}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      return output.trim()
    } catch {
      throw new Error(`Cannot resolve ref: ${ref}`)
    }
  }

  private async createPack(commands: RefUpdateCommand[]): Promise<Buffer> {
    const refs = commands
      .filter((c) => c.newSha)
      .map((c) => c.newSha)
      .join('\n')

    return new Promise((resolve, reject) => {
      const proc = spawn('git', ['pack-objects', '--stdout', '--revs'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const chunks: Buffer[] = []
      proc.stdout.on('data', (chunk) => chunks.push(chunk))

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks))
        } else {
          reject(new Error(`git pack-objects failed with code ${code}`))
        }
      })

      proc.on('error', reject)

      // Write refs to stdin
      proc.stdin.write(refs + '\n')
      proc.stdin.end()
    })
  }

  private async indexPack(packData: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', ['index-pack', '--stdin', '--fix-thin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`git index-pack failed with code ${code}`))
        }
      })

      proc.on('error', reject)

      // Write pack data and close
      proc.stdin.write(packData)
      proc.stdin.end()
    })
  }
}

// =============================================================================
// Entry Point
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    process.stderr.write('usage: git-remote-mesh <url>\n')
    process.stderr.write('\n')
    process.stderr.write('This is a git remote helper for mesh:// URLs.\n')
    process.stderr.write('It is invoked automatically by git.\n')
    process.stderr.write('\n')
    process.stderr.write('Example:\n')
    process.stderr.write('  git remote add peer mesh://peer-id-abc123\n')
    process.stderr.write('  git fetch peer main\n')
    process.exit(1)
  }

  const url = args[0]

  try {
    const helper = new GitRemoteMesh(url)
    await helper.run()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    process.stderr.write(`fatal: ${message}\n`)
    process.exit(128)
  }
}

// Run if this is the main module
main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`)
  process.exit(128)
})
