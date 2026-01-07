import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { NebulaMesh } from '../../src/mesh/nebula-mesh'
import { YjsSyncProvider } from '../../src/sync/yjs-provider'

describe('YjsSyncProvider', () => {
  let tmpDir: string
  let mesh: NebulaMesh
  let provider: YjsSyncProvider

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'yjs-provider-test-' + Date.now())
    await fs.mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    if (provider) {
      await provider.stop()
    }
    if (mesh?.connected) {
      await mesh.disconnect()
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('Lifecycle', () => {
    it('should start not synced and not syncing', async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30001,
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'test-namespace',
      })

      expect(provider.synced).toBe(false)
      expect(provider.syncing).toBe(false)
    })

    it('should become synced immediately with no peers', async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30002,
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'test-namespace',
      })

      const syncedHandler = vi.fn()
      provider.on('synced', syncedHandler)

      await provider.start()

      expect(provider.synced).toBe(true)
      expect(provider.syncing).toBe(false)
      expect(syncedHandler).toHaveBeenCalledTimes(1)
    })

    it('should emit syncing when starting with peers', async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30003,
        peers: [{ id: 'other-peer', nebulaIp: '127.0.0.1', port: 30004 }],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'test-namespace',
      })

      const syncingHandler = vi.fn()
      provider.on('syncing', syncingHandler)

      await provider.start()

      // With no connected peers, will emit syncing but then synced
      expect(syncingHandler).toHaveBeenCalled()
    })

    it('should stop cleanly', async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30005,
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'test-namespace',
      })
      await provider.start()

      await provider.stop()

      expect(provider.synced).toBe(false)
      expect(provider.syncing).toBe(false)
    })
  })

  describe('Document Access', () => {
    beforeEach(async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30006 + Math.floor(Math.random() * 100),
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'test-namespace',
      })
      await provider.start()
    })

    it('should provide access to Y.Doc', () => {
      expect(provider.doc).toBeInstanceOf(Y.Doc)
    })

    it('should create and access Y.Map', () => {
      const map = provider.getMap<string>('test-map')
      map.set('key1', 'value1')

      expect(map.get('key1')).toBe('value1')
    })

    it('should create and access Y.Array', () => {
      const arr = provider.getArray<number>('test-array')
      arr.push([1, 2, 3])

      expect(arr.toArray()).toEqual([1, 2, 3])
    })

    it('should create and access Y.Text', () => {
      const text = provider.getText('test-text')
      text.insert(0, 'Hello, World!')

      expect(text.toString()).toBe('Hello, World!')
    })

    it('should return same shared type on multiple gets', () => {
      const map1 = provider.getMap<string>('shared-map')
      const map2 = provider.getMap<string>('shared-map')

      map1.set('key', 'value')

      expect(map2.get('key')).toBe('value')
      expect(map1).toBe(map2)
    })
  })

  describe('Update Events', () => {
    beforeEach(async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30200 + Math.floor(Math.random() * 100),
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'test-namespace',
      })
      await provider.start()
    })

    it('should emit update event on local changes', async () => {
      const updateHandler = vi.fn()
      provider.on('update', updateHandler)

      const map = provider.getMap<string>('test-map')
      map.set('key', 'value')

      // Updates are async, give it a moment
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(updateHandler).toHaveBeenCalled()
      const [update, origin] = updateHandler.mock.calls[0]
      expect(update).toBeInstanceOf(Uint8Array)
      expect(origin).toBe('local')
    })

    it('should track document state across updates', () => {
      const map = provider.getMap<string>('state-map')

      map.set('a', '1')
      map.set('b', '2')
      map.set('a', '3') // Update existing

      expect(map.get('a')).toBe('3')
      expect(map.get('b')).toBe('2')
    })
  })

  describe('Namespace Registration', () => {
    it('should register namespace on start', async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30300,
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'my-namespace',
      })

      await provider.start()

      const namespaces = mesh.getActiveNamespaces()
      expect(namespaces.has('my-namespace')).toBe(true)
    })

    it('should unregister namespace on stop', async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30301,
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'temp-namespace',
      })

      await provider.start()
      expect(mesh.getActiveNamespaces().has('temp-namespace')).toBe(true)

      await provider.stop()
      expect(mesh.getActiveNamespaces().has('temp-namespace')).toBe(false)
    })
  })

  describe('CRDT Semantics', () => {
    beforeEach(async () => {
      mesh = new NebulaMesh({
        peerId: 'test-peer',
        nebulaIp: '127.0.0.1',
        port: 30400 + Math.floor(Math.random() * 100),
        peers: [],
      })
      await mesh.connect()

      provider = new YjsSyncProvider(mesh, {
        namespace: 'crdt-test',
      })
      await provider.start()
    })

    it('should support nested data in Y.Map', () => {
      const map = provider.getMap<Record<string, unknown>>('nested-map')

      map.set('user', {
        name: 'Alice',
        email: 'alice@example.com',
        settings: {
          theme: 'dark',
          notifications: true,
        },
      })

      const user = map.get('user')
      expect(user?.name).toBe('Alice')
      expect((user?.settings as Record<string, unknown>)?.theme).toBe('dark')
    })

    it('should support array operations', () => {
      const arr = provider.getArray<string>('items')

      arr.push(['first'])
      arr.push(['second'])
      arr.unshift(['zeroth'])

      expect(arr.toArray()).toEqual(['zeroth', 'first', 'second'])

      arr.delete(1, 1) // Remove 'first'
      expect(arr.toArray()).toEqual(['zeroth', 'second'])
    })

    it('should support text operations', () => {
      const text = provider.getText('document')

      text.insert(0, 'Hello')
      text.insert(5, ' World')
      text.delete(0, 5) // Remove 'Hello'

      expect(text.toString()).toBe(' World')
    })

    it('should handle transactions', () => {
      const map = provider.getMap<number>('transact-map')

      provider.doc.transact(() => {
        map.set('a', 1)
        map.set('b', 2)
        map.set('c', 3)
      })

      expect(map.get('a')).toBe(1)
      expect(map.get('b')).toBe(2)
      expect(map.get('c')).toBe(3)
    })

    it('should support transaction origin for tracking', () => {
      const origins: unknown[] = []

      provider.doc.on('update', (update: Uint8Array, origin: unknown) => {
        origins.push(origin)
      })

      const map = provider.getMap<string>('origin-map')

      provider.doc.transact(() => {
        map.set('key', 'local-value')
      }, 'local')

      provider.doc.transact(() => {
        map.set('key', 'remote-value')
      }, 'remote')

      expect(origins).toContain('local')
      expect(origins).toContain('remote')
    })
  })
})
