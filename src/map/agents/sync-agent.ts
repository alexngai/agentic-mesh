/**
 * Sync Agent
 *
 * A built-in agent for CRDT synchronization using Yjs.
 * Handles state synchronization across mesh peers using MAP messaging.
 */

import { EventEmitter } from 'events'
import type {
  AgentId,
  ScopeId,
  Message,
} from '../types'
import { BaseAgent, type BaseAgentConfig } from './base-agent'
import type { AgentConnection } from '../connection/agent'

/**
 * Sync message types.
 */
export type SyncMessageType =
  | 'sync:request'      // Request sync with a peer
  | 'sync:state-vector' // Send state vector for comparison
  | 'sync:diff'         // Send diff/update
  | 'sync:ack'          // Acknowledge receipt
  | 'sync:full'         // Full state transfer

/**
 * Sync message payload.
 */
export interface SyncMessage {
  type: SyncMessageType
  namespace: string
  data?: Uint8Array | number[]
  stateVector?: Uint8Array | number[]
  version?: number
}

/**
 * Configuration for the sync agent.
 */
export interface SyncAgentConfig extends BaseAgentConfig {
  /** Namespace for sync (becomes a scope) */
  namespace: string

  /** Sync interval in milliseconds */
  syncInterval?: number

  /** Get current state vector */
  getStateVector: () => Uint8Array

  /** Get diff from a state vector */
  getDiff: (stateVector: Uint8Array) => Uint8Array

  /** Apply an update */
  applyUpdate: (update: Uint8Array) => void

  /** Get full state (for initial sync) */
  getFullState: () => Uint8Array

  /** Apply full state */
  applyFullState: (state: Uint8Array) => void
}

/**
 * Sync Agent - handles CRDT synchronization.
 */
export class SyncAgent extends BaseAgent {
  private readonly syncConfig: SyncAgentConfig
  private readonly scopeId: ScopeId
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private peerVersions = new Map<AgentId, number>()
  private localVersion = 0

  constructor(connection: AgentConnection, config: SyncAgentConfig) {
    super(connection, {
      name: config.name ?? `sync-${config.namespace}`,
      role: 'sync',
      description: `Sync agent for namespace ${config.namespace}`,
      scopes: [config.namespace],
      metadata: { namespace: config.namespace },
    })
    this.syncConfig = config
    this.scopeId = config.namespace
  }

  /**
   * Namespace being synced.
   */
  get namespace(): string {
    return this.syncConfig.namespace
  }

  /**
   * Current local version.
   */
  get version(): number {
    return this.localVersion
  }

  /**
   * Called when the agent starts.
   */
  protected async onStart(): Promise<void> {
    // Join the sync scope
    await this.joinScope(this.scopeId)

    // Start periodic sync
    const interval = this.syncConfig.syncInterval ?? 5000
    this.syncTimer = setInterval(() => {
      this.broadcastStateVector().catch((err) => {
        this.emit('error', err)
      })
    }, interval)

    // Request initial sync from peers
    await this.requestSync()
  }

  /**
   * Called when the agent stops.
   */
  protected async onStop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
  }

  /**
   * Handle an incoming message.
   */
  protected async handleMessage(message: Message): Promise<void> {
    const payload = message.payload as SyncMessage
    if (!payload || typeof payload !== 'object') return
    if (payload.namespace !== this.namespace) return

    const fromAgent = message.from

    switch (payload.type) {
      case 'sync:request':
        await this.handleSyncRequest(fromAgent)
        break

      case 'sync:state-vector':
        await this.handleStateVector(fromAgent, payload)
        break

      case 'sync:diff':
        this.handleDiff(fromAgent, payload)
        break

      case 'sync:full':
        this.handleFullState(fromAgent, payload)
        break

      case 'sync:ack':
        this.handleAck(fromAgent, payload)
        break
    }
  }

  /**
   * Request sync from peers.
   */
  async requestSync(): Promise<void> {
    const message: SyncMessage = {
      type: 'sync:request',
      namespace: this.namespace,
    }

    await this.broadcastToScope(this.scopeId, message)
  }

  /**
   * Broadcast current state vector to peers.
   */
  async broadcastStateVector(): Promise<void> {
    const stateVector = this.syncConfig.getStateVector()
    this.localVersion++

    const message: SyncMessage = {
      type: 'sync:state-vector',
      namespace: this.namespace,
      stateVector: Array.from(stateVector),
      version: this.localVersion,
    }

    await this.broadcastToScope(this.scopeId, message)
  }

  /**
   * Send an update to peers.
   */
  async broadcastUpdate(update: Uint8Array): Promise<void> {
    this.localVersion++

    const message: SyncMessage = {
      type: 'sync:diff',
      namespace: this.namespace,
      data: Array.from(update),
      version: this.localVersion,
    }

    await this.broadcastToScope(this.scopeId, message)
  }

  /**
   * Handle a sync request.
   */
  private async handleSyncRequest(fromAgent: string): Promise<void> {
    // Send full state to requesting peer
    const fullState = this.syncConfig.getFullState()

    const message: SyncMessage = {
      type: 'sync:full',
      namespace: this.namespace,
      data: Array.from(fullState),
      version: this.localVersion,
    }

    await this.send({ agent: fromAgent }, message)
  }

  /**
   * Handle a state vector from a peer.
   */
  private async handleStateVector(fromAgent: string, payload: SyncMessage): Promise<void> {
    if (!payload.stateVector) return

    const remoteStateVector = new Uint8Array(payload.stateVector)
    const diff = this.syncConfig.getDiff(remoteStateVector)

    // Only send diff if there are changes
    if (diff.length > 0) {
      const message: SyncMessage = {
        type: 'sync:diff',
        namespace: this.namespace,
        data: Array.from(diff),
        version: this.localVersion,
      }

      await this.send({ agent: fromAgent }, message)
    }

    // Update peer version tracking
    if (payload.version !== undefined) {
      this.peerVersions.set(fromAgent, payload.version)
    }
  }

  /**
   * Handle a diff/update from a peer.
   */
  private handleDiff(fromAgent: string, payload: SyncMessage): void {
    if (!payload.data) return

    const update = new Uint8Array(payload.data)
    this.syncConfig.applyUpdate(update)

    // Update peer version tracking
    if (payload.version !== undefined) {
      this.peerVersions.set(fromAgent, payload.version)
    }

    this.emit('synced', fromAgent, payload.version)
  }

  /**
   * Handle full state from a peer.
   */
  private handleFullState(fromAgent: string, payload: SyncMessage): void {
    if (!payload.data) return

    const state = new Uint8Array(payload.data)
    this.syncConfig.applyFullState(state)

    // Update peer version tracking
    if (payload.version !== undefined) {
      this.peerVersions.set(fromAgent, payload.version)
    }

    this.emit('synced', fromAgent, payload.version)
  }

  /**
   * Handle acknowledgment from a peer.
   */
  private handleAck(fromAgent: string, payload: SyncMessage): void {
    if (payload.version !== undefined) {
      this.peerVersions.set(fromAgent, payload.version)
    }
  }

  /**
   * Get the version known for a peer.
   */
  getPeerVersion(peerId: AgentId): number | undefined {
    return this.peerVersions.get(peerId)
  }

  /**
   * Get all known peer versions.
   */
  getAllPeerVersions(): Map<AgentId, number> {
    return new Map(this.peerVersions)
  }
}

/**
 * Create a sync agent.
 */
export function createSyncAgent(
  connection: AgentConnection,
  config: SyncAgentConfig
): SyncAgent {
  return new SyncAgent(connection, config)
}
