// YjsSyncProvider - CRDT-based sync using Yjs
// Implements: s-40hv

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { SyncProvider } from './provider'
import { MessageChannel } from '../channel/message-channel'
import type { YjsSyncConfig, YjsMessage, PeerInfo, MeshContext } from '../types'
import type { NebulaMesh } from '../mesh/nebula-mesh'

// Message type constants
const MSG_SYNC_STEP_1 = 0
const MSG_SYNC_STEP_2 = 1
const MSG_UPDATE = 2

interface YjsWireMessage {
  type: number
  data: number[] // Uint8Array serialized as number array for JSON
}

export class YjsSyncProvider extends SyncProvider {
  readonly doc: Y.Doc
  private channel: MessageChannel<YjsWireMessage> | null = null
  private _synced = false
  private _syncing = false
  private syncedPeers: Set<string> = new Set()
  private config: YjsSyncConfig

  constructor(mesh: MeshContext, config: YjsSyncConfig) {
    super(mesh, config)
    this.config = config
    this.doc = new Y.Doc()
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async start(): Promise<void> {
    // Register namespace
    await this.mesh.registerNamespace(this.namespace)

    // Create channel for Yjs messages
    const meshInstance = this.mesh as NebulaMesh
    this.channel = meshInstance.createChannel<YjsWireMessage>(`sync:yjs:${this.namespace}`)
    await this.channel.open()

    // Listen for incoming messages
    this.channel.on('message', (msg: YjsWireMessage, from: PeerInfo) => {
      this.handleMessage(msg, from)
    })

    // Listen for doc updates and broadcast
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') {
        this.broadcastUpdate(update)
      }
    })

    // Listen for peer events
    this.mesh.on('peer:joined', (peer: PeerInfo) => {
      this.initSyncWithPeer(peer.id)
    })

    this.mesh.on('peer:left', (peer: PeerInfo) => {
      this.syncedPeers.delete(peer.id)
    })

    // Start sync with existing peers
    this._syncing = true
    this.emit('syncing')

    const peers = this.mesh.getPeers()
    for (const peer of peers) {
      if (peer.status === 'online') {
        this.initSyncWithPeer(peer.id)
      }
    }

    // If no peers, we're immediately synced
    if (peers.filter((p) => p.status === 'online').length === 0) {
      this._synced = true
      this._syncing = false
      this.emit('synced')
    }
  }

  async stop(): Promise<void> {
    // Unregister namespace
    await this.mesh.unregisterNamespace(this.namespace)

    // Close channel
    if (this.channel) {
      await this.channel.close()
      this.channel = null
    }

    // Remove doc listeners
    this.doc.off('update', () => {})

    this._synced = false
    this._syncing = false
    this.syncedPeers.clear()
  }

  // ==========================================================================
  // State
  // ==========================================================================

  get synced(): boolean {
    return this._synced
  }

  get syncing(): boolean {
    return this._syncing
  }

  // ==========================================================================
  // Convenience accessors
  // ==========================================================================

  getMap<T>(name: string): Y.Map<T> {
    return this.doc.getMap<T>(name)
  }

  getArray<T>(name: string): Y.Array<T> {
    return this.doc.getArray<T>(name)
  }

  getText(name: string): Y.Text {
    return this.doc.getText(name)
  }

  // ==========================================================================
  // Sync Protocol
  // ==========================================================================

  private initSyncWithPeer(peerId: string): void {
    if (!this.channel) return

    // Send sync step 1 (our state vector)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC_STEP_1)
    syncProtocol.writeSyncStep1(encoder, this.doc)

    const message: YjsWireMessage = {
      type: MSG_SYNC_STEP_1,
      data: Array.from(encoding.toUint8Array(encoder)),
    }

    this.channel.send(peerId, message)
  }

  private handleMessage(msg: YjsWireMessage, from: PeerInfo): void {
    try {
      const data = new Uint8Array(msg.data)
      const decoder = decoding.createDecoder(data)
      const messageType = decoding.readVarUint(decoder)

      switch (messageType) {
        case MSG_SYNC_STEP_1:
          this.handleSyncStep1(decoder, from.id)
          break
        case MSG_SYNC_STEP_2:
          this.handleSyncStep2(decoder, from.id)
          break
        case MSG_UPDATE:
          this.handleUpdate(decoder, from.id)
          break
      }
    } catch {
      // Silently ignore malformed messages (can happen during peer disconnection)
    }
  }

  private handleSyncStep1(decoder: decoding.Decoder, fromPeerId: string): void {
    if (!this.channel) return

    // Read their state vector and send diff + our state vector
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC_STEP_2)
    syncProtocol.readSyncStep1(decoder, encoder, this.doc)

    const message: YjsWireMessage = {
      type: MSG_SYNC_STEP_2,
      data: Array.from(encoding.toUint8Array(encoder)),
    }

    this.channel.send(fromPeerId, message)
  }

  private handleSyncStep2(decoder: decoding.Decoder, fromPeerId: string): void {
    // Apply their diff
    syncProtocol.readSyncStep2(decoder, this.doc, 'remote')

    // Mark peer as synced
    this.syncedPeers.add(fromPeerId)
    this.emit('peer:synced', fromPeerId)

    // Check if we're fully synced
    this.checkSyncStatus()
  }

  private handleUpdate(decoder: decoding.Decoder, fromPeerId: string): void {
    // Apply incremental update
    const update = decoding.readVarUint8Array(decoder)
    Y.applyUpdate(this.doc, update, 'remote')

    this.emit('update', update, 'remote')
  }

  private broadcastUpdate(update: Uint8Array): void {
    if (!this.channel) return

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_UPDATE)
    encoding.writeVarUint8Array(encoder, update)

    const message: YjsWireMessage = {
      type: MSG_UPDATE,
      data: Array.from(encoding.toUint8Array(encoder)),
    }

    this.channel.broadcast(message)
    this.emit('update', update, 'local')
  }

  private checkSyncStatus(): void {
    const onlinePeers = this.mesh.getPeers().filter((p) => p.status === 'online')
    const allSynced = onlinePeers.every((p) => this.syncedPeers.has(p.id))

    if (allSynced && !this._synced) {
      this._synced = true
      this._syncing = false
      this.emit('synced')
    }
  }
}
