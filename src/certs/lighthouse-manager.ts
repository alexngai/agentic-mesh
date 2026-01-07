// Lighthouse Process Manager
// Implements: i-2qn1

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { ConfigGenerator, LighthouseConfigOptions } from './config-generator'

/**
 * Lighthouse process state
 */
export type LighthouseStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * Lighthouse info stored in index
 */
export interface LighthouseInfo {
  name: string
  nebulaIp: string
  publicEndpoint: string
  listenPort: number
  configPath: string
  caCertPath: string
  certPath: string
  keyPath: string
  status: LighthouseStatus
  pid?: number
  startedAt?: Date
  lastHealthCheck?: Date
  healthy?: boolean
  error?: string
}

/**
 * Lighthouse index file structure
 */
export interface LighthouseIndex {
  lighthouses: Record<string, LighthouseInfo>
  lastUpdated: Date
}

/**
 * Configuration for LighthouseManager
 */
export interface LighthouseManagerConfig {
  /**
   * Directory to store lighthouse configs
   * Default: ./lighthouses
   */
  lighthousesDir?: string

  /**
   * Path to nebula binary
   * Default: nebula (assumes in PATH)
   */
  nebulaBinaryPath?: string

  /**
   * Health check interval in ms
   * Default: 30000 (30 seconds)
   */
  healthCheckInterval?: number

  /**
   * Process startup timeout in ms
   * Default: 10000 (10 seconds)
   */
  startupTimeout?: number
}

/**
 * Options for creating a lighthouse
 */
export interface CreateLighthouseOptions {
  name: string
  nebulaIp: string
  publicEndpoint: string
  caCertPath: string
  certPath: string
  keyPath: string
  listenPort?: number
  otherLighthouses?: Record<string, string>
  dns?: {
    enabled: boolean
    port?: number
  }
}

/**
 * Lighthouse health info
 */
export interface LighthouseHealth {
  name: string
  healthy: boolean
  status: LighthouseStatus
  pid?: number
  uptime?: number
  lastCheck: Date
  error?: string
}

/**
 * Event types emitted by LighthouseManager
 */
export type LighthouseEventType =
  | 'lighthouse:created'
  | 'lighthouse:started'
  | 'lighthouse:stopped'
  | 'lighthouse:error'
  | 'lighthouse:health-changed'
  | 'lighthouse:removed'

/**
 * LighthouseManager - Manages Nebula lighthouse processes
 *
 * Handles the full lifecycle of lighthouse nodes including configuration
 * generation, process management, and health monitoring.
 *
 * @example
 * ```typescript
 * const manager = new LighthouseManager({
 *   lighthousesDir: './lighthouses',
 * })
 * await manager.initialize()
 *
 * // Create a lighthouse
 * await manager.create({
 *   name: 'lighthouse-1',
 *   nebulaIp: '10.42.0.1/24',
 *   publicEndpoint: 'lighthouse.example.com:4242',
 *   caCertPath: './certs/ca.crt',
 *   certPath: './certs/lighthouse-1.crt',
 *   keyPath: './certs/lighthouse-1.key',
 * })
 *
 * // Start the lighthouse
 * await manager.start('lighthouse-1')
 *
 * // Check health
 * const health = await manager.health('lighthouse-1')
 * ```
 */
export class LighthouseManager extends EventEmitter {
  private readonly config: Required<LighthouseManagerConfig>
  private index: LighthouseIndex
  private processes: Map<string, ChildProcess> = new Map()
  private healthIntervals: Map<string, NodeJS.Timeout> = new Map()
  private initialized = false
  private readonly configGenerator: ConfigGenerator

  constructor(config: LighthouseManagerConfig = {}) {
    super()

    this.config = {
      lighthousesDir: config.lighthousesDir ?? './lighthouses',
      nebulaBinaryPath: config.nebulaBinaryPath ?? 'nebula',
      healthCheckInterval: config.healthCheckInterval ?? 30000,
      startupTimeout: config.startupTimeout ?? 10000,
    }

    this.index = {
      lighthouses: {},
      lastUpdated: new Date(),
    }

    this.configGenerator = new ConfigGenerator()
  }

  /**
   * Initialize the manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Ensure directory exists
    await fs.mkdir(this.config.lighthousesDir, { recursive: true })

    // Load existing index
    await this.loadIndex()

    // Update status of any previously running lighthouses
    for (const [name, info] of Object.entries(this.index.lighthouses)) {
      if (info.status === 'running' || info.status === 'starting') {
        // Check if process is still running
        if (info.pid && this.isProcessRunning(info.pid)) {
          // Re-attach to process output isn't possible, mark as running
          info.status = 'running'
        } else {
          info.status = 'stopped'
          info.pid = undefined
        }
      }
    }
    await this.saveIndex()

    this.initialized = true
  }

  /**
   * Shutdown the manager and stop all lighthouses
   */
  async shutdown(): Promise<void> {
    this.ensureInitialized()

    // Stop all health monitors
    for (const name of this.healthIntervals.keys()) {
      this.stopHealthMonitor(name)
    }

    // Stop all running lighthouses
    for (const [name, info] of Object.entries(this.index.lighthouses)) {
      if (info.status === 'running') {
        await this.stop(name)
      }
    }

    await this.saveIndex()
    this.initialized = false
  }

  // =========================================================================
  // Lighthouse CRUD
  // =========================================================================

  /**
   * Create a new lighthouse configuration
   */
  async create(options: CreateLighthouseOptions): Promise<LighthouseInfo> {
    this.ensureInitialized()

    if (this.index.lighthouses[options.name]) {
      throw new Error(`Lighthouse '${options.name}' already exists`)
    }

    const listenPort = options.listenPort ?? 4242
    const lighthouseDir = path.join(this.config.lighthousesDir, options.name)
    const configPath = path.join(lighthouseDir, 'config.yml')

    // Create lighthouse directory
    await fs.mkdir(lighthouseDir, { recursive: true })

    // Generate configuration
    const configYaml = this.configGenerator.generateLighthouseConfig({
      caCertPath: options.caCertPath,
      certPath: options.certPath,
      keyPath: options.keyPath,
      lighthouses: options.otherLighthouses ?? {},
      nebulaIp: options.nebulaIp,
      listenPort,
      dns: options.dns,
    })

    // Write config file
    await fs.writeFile(configPath, configYaml, 'utf-8')

    // Create lighthouse info
    const info: LighthouseInfo = {
      name: options.name,
      nebulaIp: options.nebulaIp,
      publicEndpoint: options.publicEndpoint,
      listenPort,
      configPath,
      caCertPath: options.caCertPath,
      certPath: options.certPath,
      keyPath: options.keyPath,
      status: 'stopped',
    }

    this.index.lighthouses[options.name] = info
    await this.saveIndex()

    this.emit('lighthouse:created', { lighthouse: info })
    return info
  }

  /**
   * Get lighthouse info
   */
  get(name: string): LighthouseInfo | undefined {
    this.ensureInitialized()
    return this.index.lighthouses[name]
  }

  /**
   * List all lighthouses
   */
  list(): LighthouseInfo[] {
    this.ensureInitialized()
    return Object.values(this.index.lighthouses)
  }

  /**
   * Remove a lighthouse
   */
  async remove(name: string): Promise<void> {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    // Stop if running
    if (info.status === 'running') {
      await this.stop(name)
    }

    // Stop health monitor
    this.stopHealthMonitor(name)

    // Remove config directory
    const lighthouseDir = path.join(this.config.lighthousesDir, name)
    try {
      await fs.rm(lighthouseDir, { recursive: true })
    } catch {
      // Ignore if directory doesn't exist
    }

    // Remove from index
    delete this.index.lighthouses[name]
    await this.saveIndex()

    this.emit('lighthouse:removed', { name })
  }

  // =========================================================================
  // Process Management
  // =========================================================================

  /**
   * Start a lighthouse process
   */
  async start(name: string): Promise<void> {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    if (info.status === 'running') {
      throw new Error(`Lighthouse '${name}' is already running`)
    }

    info.status = 'starting'
    info.error = undefined
    await this.saveIndex()

    try {
      // Verify config exists
      await fs.access(info.configPath)

      // Spawn nebula process
      const proc = spawn(this.config.nebulaBinaryPath, ['-config', info.configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      // Track process
      this.processes.set(name, proc)

      // Handle process events
      proc.on('error', (error) => {
        info.status = 'error'
        info.error = error.message
        info.pid = undefined
        this.processes.delete(name)
        this.saveIndex()
        this.emit('lighthouse:error', { name, error: error.message })
      })

      proc.on('exit', (code) => {
        if (info.status !== 'stopping') {
          info.status = code === 0 ? 'stopped' : 'error'
          info.error = code !== 0 ? `Process exited with code ${code}` : undefined
        } else {
          info.status = 'stopped'
        }
        info.pid = undefined
        this.processes.delete(name)
        this.saveIndex()
        this.emit('lighthouse:stopped', { name, code })
      })

      // Collect stderr for error messages
      let stderr = ''
      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      // Wait for startup
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // Check if process is still running
          if (proc.killed || proc.exitCode !== null) {
            reject(new Error(`Lighthouse failed to start: ${stderr.trim() || 'Unknown error'}`))
          } else {
            resolve()
          }
        }, this.config.startupTimeout)

        proc.on('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })

        proc.on('exit', (code) => {
          clearTimeout(timeout)
          if (code !== 0 && info.status === 'starting') {
            reject(new Error(`Lighthouse exited with code ${code}: ${stderr.trim()}`))
          }
        })

        // If process is still running after a short delay, consider it started
        setTimeout(() => {
          if (!proc.killed && proc.exitCode === null) {
            clearTimeout(timeout)
            resolve()
          }
        }, 1000)
      })

      info.status = 'running'
      info.pid = proc.pid
      info.startedAt = new Date()
      info.healthy = true
      info.lastHealthCheck = new Date()
      await this.saveIndex()

      this.emit('lighthouse:started', { name, pid: proc.pid })
    } catch (error) {
      info.status = 'error'
      info.error = (error as Error).message
      await this.saveIndex()
      this.emit('lighthouse:error', { name, error: (error as Error).message })
      throw error
    }
  }

  /**
   * Stop a lighthouse process
   */
  async stop(name: string): Promise<void> {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    if (info.status !== 'running') {
      throw new Error(`Lighthouse '${name}' is not running`)
    }

    info.status = 'stopping'
    await this.saveIndex()

    const proc = this.processes.get(name)
    if (proc) {
      // Try graceful shutdown first
      proc.kill('SIGTERM')

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if not stopped
          if (!proc.killed) {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        proc.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })

      this.processes.delete(name)
    } else if (info.pid) {
      // Try to kill by PID
      try {
        process.kill(info.pid, 'SIGTERM')
        // Wait a bit for process to exit
        await new Promise((resolve) => setTimeout(resolve, 1000))
        // Force kill if still running
        if (this.isProcessRunning(info.pid)) {
          process.kill(info.pid, 'SIGKILL')
        }
      } catch {
        // Process might already be dead
      }
    }

    info.status = 'stopped'
    info.pid = undefined
    await this.saveIndex()

    this.emit('lighthouse:stopped', { name })
  }

  /**
   * Restart a lighthouse process
   */
  async restart(name: string): Promise<void> {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    if (info.status === 'running') {
      await this.stop(name)
    }

    await this.start(name)
  }

  /**
   * Get lighthouse status
   */
  status(name: string): LighthouseStatus {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    return info.status
  }

  // =========================================================================
  // Health Monitoring
  // =========================================================================

  /**
   * Get health info for a lighthouse
   */
  async health(name: string): Promise<LighthouseHealth> {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    // Perform health check
    const healthy = await this.checkHealth(name)

    return {
      name,
      healthy,
      status: info.status,
      pid: info.pid,
      uptime: info.startedAt ? Date.now() - info.startedAt.getTime() : undefined,
      lastCheck: new Date(),
      error: info.error,
    }
  }

  /**
   * Start health monitoring for a lighthouse
   */
  startHealthMonitor(name: string): void {
    this.ensureInitialized()

    const info = this.index.lighthouses[name]
    if (!info) {
      throw new Error(`Lighthouse '${name}' not found`)
    }

    // Stop existing monitor if any
    this.stopHealthMonitor(name)

    // Start new monitor
    const interval = setInterval(async () => {
      try {
        const healthy = await this.checkHealth(name)
        const currentInfo = this.index.lighthouses[name]
        if (currentInfo && currentInfo.healthy !== healthy) {
          currentInfo.healthy = healthy
          currentInfo.lastHealthCheck = new Date()
          await this.saveIndex()
          this.emit('lighthouse:health-changed', { name, healthy })
        }
      } catch {
        // Ignore health check errors
      }
    }, this.config.healthCheckInterval)

    this.healthIntervals.set(name, interval)
  }

  /**
   * Stop health monitoring for a lighthouse
   */
  stopHealthMonitor(name: string): void {
    const interval = this.healthIntervals.get(name)
    if (interval) {
      clearInterval(interval)
      this.healthIntervals.delete(name)
    }
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('LighthouseManager not initialized. Call initialize() first.')
    }
  }

  private get indexPath(): string {
    return path.join(this.config.lighthousesDir, 'lighthouse-index.json')
  }

  private async loadIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.indexPath, 'utf-8')
      this.index = JSON.parse(data)
      // Restore dates
      this.index.lastUpdated = new Date(this.index.lastUpdated)
      for (const info of Object.values(this.index.lighthouses)) {
        if (info.startedAt) info.startedAt = new Date(info.startedAt)
        if (info.lastHealthCheck) info.lastHealthCheck = new Date(info.lastHealthCheck)
      }
    } catch {
      // Index doesn't exist yet
      this.index = {
        lighthouses: {},
        lastUpdated: new Date(),
      }
    }
  }

  private async saveIndex(): Promise<void> {
    this.index.lastUpdated = new Date()
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async checkHealth(name: string): Promise<boolean> {
    const info = this.index.lighthouses[name]
    if (!info) return false

    // Check if process is running
    if (info.status !== 'running') return false
    if (!info.pid) return false

    // Check if process is still alive
    if (!this.isProcessRunning(info.pid)) {
      info.status = 'error'
      info.error = 'Process died unexpectedly'
      info.pid = undefined
      await this.saveIndex()
      return false
    }

    return true
  }
}
