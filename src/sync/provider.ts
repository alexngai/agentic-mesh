// SyncProvider - Abstract interface for sync providers
// Implements: s-1aak

import { EventEmitter } from 'events'
import type { SyncProviderConfig, SyncError, MeshContext } from '../types'

export abstract class SyncProvider extends EventEmitter {
  readonly namespace: string
  protected mesh: MeshContext

  constructor(mesh: MeshContext, config: SyncProviderConfig) {
    super()
    this.mesh = mesh
    this.namespace = config.namespace
  }

  // ==========================================================================
  // Lifecycle - providers must implement
  // ==========================================================================

  abstract start(): Promise<void>
  abstract stop(): Promise<void>

  // ==========================================================================
  // State - providers must implement
  // ==========================================================================

  abstract get synced(): boolean
  abstract get syncing(): boolean

  // ==========================================================================
  // Optional: force sync
  // ==========================================================================

  sync?(): Promise<void>

  // ==========================================================================
  // Events (inherited from EventEmitter)
  // - 'synced': () => void
  // - 'syncing': () => void
  // - 'error': (error: SyncError) => void
  // - 'peer:synced': (peerId: string) => void
  // ==========================================================================
}
