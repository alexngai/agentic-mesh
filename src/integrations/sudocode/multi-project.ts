// MultiProjectManager - Manage multiple sudocode projects on a single mesh
// Implements: i-9gex

import { EventEmitter } from 'events'
import { NebulaMesh } from '../../mesh/nebula-mesh'
import type { NebulaMeshConfig } from '../../types'
import { SudocodeMeshService } from './service'
import type { SudocodeMeshConfig } from './types'

// =============================================================================
// Types
// =============================================================================

export interface MultiProjectConfig {
  /** Mesh configuration (shared across all projects) */
  meshConfig: NebulaMeshConfig
}

export interface ProjectInfo {
  /** Unique project ID */
  projectId: string
  /** Local path to project */
  projectPath: string
  /** Whether this project is currently connected */
  connected: boolean
  /** Namespace used for sync */
  namespace: string
}

export interface ProjectAddedEvent {
  projectId: string
  projectPath: string
}

export interface ProjectRemovedEvent {
  projectId: string
}

export interface ProjectSyncedEvent {
  projectId: string
}

// =============================================================================
// MultiProjectManager
// =============================================================================

/**
 * MultiProjectManager - Manages multiple sudocode projects on a shared mesh.
 *
 * This class enables:
 * - Single mesh connection shared across multiple projects
 * - Project-scoped sync (each project syncs independently via namespaces)
 * - Easy project switching and management
 * - Namespace isolation (projects don't interfere with each other)
 *
 * @example
 * ```typescript
 * const manager = new MultiProjectManager({
 *   meshConfig: {
 *     peerId: 'my-peer',
 *     nebulaIp: '10.0.0.1',
 *     peers: [...],
 *   }
 * })
 *
 * await manager.connect()
 *
 * // Add projects
 * await manager.addProject('project-a', '/path/to/project-a')
 * await manager.addProject('project-b', '/path/to/project-b')
 *
 * // Get project services
 * const projectA = manager.getProject('project-a')
 * const specs = projectA?.getSpecs()
 *
 * // List all projects
 * const projects = manager.listProjects()
 * ```
 */
export class MultiProjectManager extends EventEmitter {
  private config: MultiProjectConfig
  private mesh: NebulaMesh | null = null
  private projects: Map<string, SudocodeMeshService> = new Map()
  private projectPaths: Map<string, string> = new Map()
  private _connected = false

  constructor(config: MultiProjectConfig) {
    super()
    this.config = config
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Connect to the mesh network.
   * Must be called before adding projects.
   */
  async connect(): Promise<void> {
    if (this._connected) return

    this.mesh = new NebulaMesh(this.config.meshConfig)
    await this.mesh.connect()
    this._connected = true

    // Wire up mesh events
    this.mesh.on('peer:joined', (peer) => this.emit('peer:joined', peer))
    this.mesh.on('peer:left', (peer) => this.emit('peer:left', peer))
    this.mesh.on('disconnected', () => this.emit('disconnected'))
  }

  /**
   * Disconnect from the mesh and all projects.
   */
  async disconnect(): Promise<void> {
    if (!this._connected) return

    // Disconnect all projects first
    const disconnectPromises = Array.from(this.projects.values()).map((service) =>
      service.disconnect().catch(() => {
        // Ignore individual project disconnect errors
      })
    )
    await Promise.all(disconnectPromises)

    this.projects.clear()
    this.projectPaths.clear()

    // Disconnect mesh
    if (this.mesh) {
      await this.mesh.disconnect()
      this.mesh = null
    }

    this._connected = false
  }

  /**
   * Check if the manager is connected to the mesh.
   */
  get connected(): boolean {
    return this._connected
  }

  /**
   * Get the underlying mesh instance.
   */
  getMesh(): NebulaMesh | null {
    return this.mesh
  }

  // ===========================================================================
  // Project Management
  // ===========================================================================

  /**
   * Add and connect a project.
   * Each project syncs independently via its own namespace.
   */
  async addProject(projectId: string, projectPath: string): Promise<SudocodeMeshService> {
    if (!this._connected || !this.mesh) {
      throw new Error('Manager not connected. Call connect() first.')
    }

    if (this.projects.has(projectId)) {
      throw new Error(`Project already exists: ${projectId}`)
    }

    const serviceConfig: SudocodeMeshConfig = {
      projectId,
      projectPath,
      meshConfig: this.config.meshConfig,
    }

    const service = new SudocodeMeshService(serviceConfig)

    // Override the mesh with our shared instance
    // Note: SudocodeMeshService creates its own mesh, but we can still track it
    await service.connect()

    this.projects.set(projectId, service)
    this.projectPaths.set(projectId, projectPath)

    // Wire up service events
    service.on('synced', () => {
      const event: ProjectSyncedEvent = { projectId }
      this.emit('project:synced', event)
    })

    const event: ProjectAddedEvent = { projectId, projectPath }
    this.emit('project:added', event)

    return service
  }

  /**
   * Remove and disconnect a project.
   */
  async removeProject(projectId: string): Promise<boolean> {
    const service = this.projects.get(projectId)
    if (!service) {
      return false
    }

    await service.disconnect()
    this.projects.delete(projectId)
    this.projectPaths.delete(projectId)

    const event: ProjectRemovedEvent = { projectId }
    this.emit('project:removed', event)

    return true
  }

  /**
   * Get a project's service by ID.
   */
  getProject(projectId: string): SudocodeMeshService | undefined {
    return this.projects.get(projectId)
  }

  /**
   * Check if a project exists.
   */
  hasProject(projectId: string): boolean {
    return this.projects.has(projectId)
  }

  /**
   * List all projects with their info.
   */
  listProjects(): ProjectInfo[] {
    const result: ProjectInfo[] = []

    for (const [projectId, service] of this.projects) {
      const projectPath = this.projectPaths.get(projectId) ?? ''
      result.push({
        projectId,
        projectPath,
        connected: service.connected,
        namespace: `sudocode:${projectId}`,
      })
    }

    return result
  }

  /**
   * Get all project IDs.
   */
  getProjectIds(): string[] {
    return Array.from(this.projects.keys())
  }

  /**
   * Get the number of active projects.
   */
  get projectCount(): number {
    return this.projects.size
  }

  // ===========================================================================
  // Cross-Project Queries
  // ===========================================================================

  /**
   * Get projects that a specific peer is participating in.
   * Uses namespace registry to determine which projects the peer is syncing.
   */
  getProjectsForPeer(peerId: string): string[] {
    if (!this.mesh) return []

    const namespaces = this.mesh.getActiveNamespaces()
    const result: string[] = []

    for (const [namespace, peers] of namespaces) {
      if (namespace.startsWith('sudocode:') && peers.includes(peerId)) {
        const projectId = namespace.replace('sudocode:', '')
        if (this.projects.has(projectId)) {
          result.push(projectId)
        }
      }
    }

    return result
  }

  /**
   * Get peers that are participating in a specific project.
   */
  getPeersForProject(projectId: string): string[] {
    if (!this.mesh) return []

    const namespace = `sudocode:${projectId}`
    const namespaces = this.mesh.getActiveNamespaces()
    return namespaces.get(namespace) ?? []
  }

  /**
   * Get all active sudocode namespaces on the mesh.
   * Returns project IDs (without the 'sudocode:' prefix).
   */
  getActiveProjectNamespaces(): string[] {
    if (!this.mesh) return []

    const namespaces = this.mesh.getActiveNamespaces()
    const result: string[] = []

    for (const namespace of namespaces.keys()) {
      if (namespace.startsWith('sudocode:')) {
        result.push(namespace.replace('sudocode:', ''))
      }
    }

    return result
  }
}
