import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NamespaceRegistry } from '../../src/mesh/namespace-registry'

describe('NamespaceRegistry', () => {
  let registry: NamespaceRegistry

  beforeEach(() => {
    registry = new NamespaceRegistry('local-peer')
  })

  describe('Hub-side Operations', () => {
    describe('registerPeer', () => {
      it('should register a peer for a namespace', () => {
        const update = registry.registerPeer('test-ns', 'peer-a')

        expect(update).not.toBeNull()
        expect(update?.namespace).toBe('test-ns')
        expect(update?.peers).toContain('peer-a')
        expect(update?.action).toBe('added')
        expect(update?.changedPeerId).toBe('peer-a')
      })

      it('should add multiple peers to same namespace', () => {
        registry.registerPeer('test-ns', 'peer-a')
        const update = registry.registerPeer('test-ns', 'peer-b')

        expect(update?.peers).toContain('peer-a')
        expect(update?.peers).toContain('peer-b')
        expect(update?.peers.length).toBe(2)
      })

      it('should return null when peer already registered', () => {
        registry.registerPeer('test-ns', 'peer-a')
        const update = registry.registerPeer('test-ns', 'peer-a')

        expect(update).toBeNull()
      })

      it('should emit namespace:updated event', () => {
        const handler = vi.fn()
        registry.on('namespace:updated', handler)

        registry.registerPeer('test-ns', 'peer-a')

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            namespace: 'test-ns',
            action: 'added',
          })
        )
      })
    })

    describe('unregisterPeer', () => {
      it('should unregister a peer from a namespace', () => {
        registry.registerPeer('test-ns', 'peer-a')
        const update = registry.unregisterPeer('test-ns', 'peer-a')

        expect(update).not.toBeNull()
        expect(update?.peers).not.toContain('peer-a')
        expect(update?.action).toBe('removed')
      })

      it('should return null when peer not registered', () => {
        const update = registry.unregisterPeer('test-ns', 'peer-a')
        expect(update).toBeNull()
      })

      it('should clean up empty namespaces', () => {
        registry.registerPeer('test-ns', 'peer-a')
        registry.unregisterPeer('test-ns', 'peer-a')

        expect(registry.getPeersForNamespace('test-ns')).toHaveLength(0)
      })
    })

    describe('unregisterPeerFromAll', () => {
      it('should unregister peer from all namespaces', () => {
        registry.registerPeer('ns-1', 'peer-a')
        registry.registerPeer('ns-2', 'peer-a')
        registry.registerPeer('ns-1', 'peer-b')

        const updates = registry.unregisterPeerFromAll('peer-a')

        expect(updates).toHaveLength(2)
        expect(registry.getPeersForNamespace('ns-1')).toEqual(['peer-b'])
        expect(registry.getPeersForNamespace('ns-2')).toHaveLength(0)
      })

      it('should return empty array when peer has no namespaces', () => {
        const updates = registry.unregisterPeerFromAll('peer-a')
        expect(updates).toHaveLength(0)
      })
    })

    describe('createSnapshot', () => {
      it('should create snapshot of all namespaces', () => {
        registry.registerPeer('ns-1', 'peer-a')
        registry.registerPeer('ns-1', 'peer-b')
        registry.registerPeer('ns-2', 'peer-c')

        const snapshot = registry.createSnapshot()

        expect(snapshot.type).toBe('namespace-snapshot')
        expect(snapshot.namespaces).toHaveLength(2)

        const ns1 = snapshot.namespaces.find((n) => n.namespace === 'ns-1')
        expect(ns1?.peers).toContain('peer-a')
        expect(ns1?.peers).toContain('peer-b')

        const ns2 = snapshot.namespaces.find((n) => n.namespace === 'ns-2')
        expect(ns2?.peers).toContain('peer-c')
      })

      it('should return empty namespaces when registry is empty', () => {
        const snapshot = registry.createSnapshot()
        expect(snapshot.namespaces).toHaveLength(0)
      })
    })
  })

  describe('Peer-side Operations', () => {
    describe('applyUpdate', () => {
      it('should apply namespace update', () => {
        registry.applyUpdate({
          type: 'namespace-update',
          namespace: 'test-ns',
          peers: ['peer-a', 'peer-b'],
          action: 'added',
          changedPeerId: 'peer-b',
        })

        expect(registry.getPeersForNamespace('test-ns')).toEqual([
          'peer-a',
          'peer-b',
        ])
      })

      it('should emit namespace:changed event', () => {
        const handler = vi.fn()
        registry.on('namespace:changed', handler)

        registry.applyUpdate({
          type: 'namespace-update',
          namespace: 'test-ns',
          peers: ['peer-a'],
          action: 'added',
          changedPeerId: 'peer-a',
        })

        expect(handler).toHaveBeenCalled()
      })

      it('should clean up empty namespaces on update', () => {
        registry.registerPeer('test-ns', 'peer-a')

        registry.applyUpdate({
          type: 'namespace-update',
          namespace: 'test-ns',
          peers: [],
          action: 'removed',
          changedPeerId: 'peer-a',
        })

        expect(registry.getAllNamespaces().size).toBe(0)
      })
    })

    describe('applySnapshot', () => {
      it('should replace all registry data with snapshot', () => {
        // Pre-existing data
        registry.registerPeer('old-ns', 'old-peer')

        registry.applySnapshot({
          type: 'namespace-snapshot',
          namespaces: [
            { namespace: 'ns-1', peers: ['peer-a', 'peer-b'] },
            { namespace: 'ns-2', peers: ['peer-c'] },
          ],
        })

        // Old data should be gone
        expect(registry.getPeersForNamespace('old-ns')).toHaveLength(0)

        // New data should be present
        expect(registry.getPeersForNamespace('ns-1')).toEqual(['peer-a', 'peer-b'])
        expect(registry.getPeersForNamespace('ns-2')).toEqual(['peer-c'])
      })

      it('should emit namespace:synced event', () => {
        const handler = vi.fn()
        registry.on('namespace:synced', handler)

        registry.applySnapshot({
          type: 'namespace-snapshot',
          namespaces: [],
        })

        expect(handler).toHaveBeenCalled()
      })
    })
  })

  describe('Query Operations', () => {
    beforeEach(() => {
      registry.registerPeer('ns-1', 'peer-a')
      registry.registerPeer('ns-1', 'peer-b')
      registry.registerPeer('ns-2', 'peer-a')
      registry.registerPeer('ns-3', 'peer-c')
    })

    describe('getPeersForNamespace', () => {
      it('should return peers for a namespace', () => {
        const peers = registry.getPeersForNamespace('ns-1')
        expect(peers).toContain('peer-a')
        expect(peers).toContain('peer-b')
        expect(peers).toHaveLength(2)
      })

      it('should return empty array for unknown namespace', () => {
        const peers = registry.getPeersForNamespace('unknown')
        expect(peers).toHaveLength(0)
      })
    })

    describe('getNamespacesForPeer', () => {
      it('should return namespaces for a peer', () => {
        const namespaces = registry.getNamespacesForPeer('peer-a')
        expect(namespaces).toContain('ns-1')
        expect(namespaces).toContain('ns-2')
        expect(namespaces).toHaveLength(2)
      })

      it('should return empty array for unknown peer', () => {
        const namespaces = registry.getNamespacesForPeer('unknown')
        expect(namespaces).toHaveLength(0)
      })
    })

    describe('getAllNamespaces', () => {
      it('should return all namespaces with their peers', () => {
        const all = registry.getAllNamespaces()

        expect(all.size).toBe(3)
        expect(all.get('ns-1')).toEqual(expect.arrayContaining(['peer-a', 'peer-b']))
        expect(all.get('ns-2')).toEqual(['peer-a'])
        expect(all.get('ns-3')).toEqual(['peer-c'])
      })
    })

    describe('isPeerInNamespace', () => {
      it('should return true when peer is in namespace', () => {
        expect(registry.isPeerInNamespace('ns-1', 'peer-a')).toBe(true)
      })

      it('should return false when peer is not in namespace', () => {
        expect(registry.isPeerInNamespace('ns-1', 'peer-c')).toBe(false)
      })

      it('should return false for unknown namespace', () => {
        expect(registry.isPeerInNamespace('unknown', 'peer-a')).toBe(false)
      })
    })
  })

  describe('clear', () => {
    it('should clear all registry data', () => {
      registry.registerPeer('ns-1', 'peer-a')
      registry.registerPeer('ns-2', 'peer-b')

      registry.clear()

      expect(registry.getAllNamespaces().size).toBe(0)
    })
  })
})
