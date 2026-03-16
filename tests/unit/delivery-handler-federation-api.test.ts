/**
 * Phase 2 Integration API Tests
 *
 * Regression tests for the Phase 2 API changes:
 * - API-1: MapServer.setDeliveryHandler()
 * - API-2: MeshPeer federation lifecycle (federateWith, getFederationGateway, etc.)
 * - API-3: Channel naming convention (CHANNEL_PREFIXES)
 * - Finding-1: parseFederatedId utility
 * - Finding-2: _meta passthrough through delivery pipeline
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MapServer } from '../../src/map/server/map-server'
import type { DeliveryHandler } from '../../src/map/server/message-router'
import { MeshPeer } from '../../src/map/mesh-peer'
import {
  parseFederatedId,
  CHANNEL_PREFIXES,
  type Message,
} from '../../src/map/types'

// =============================================================================
// API-1: MapServer.setDeliveryHandler()
// =============================================================================

describe('API-1: MapServer.setDeliveryHandler()', () => {
  let server: MapServer

  beforeEach(async () => {
    server = new MapServer({
      systemId: 'test-system',
      systemName: 'Test System',
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should return the previous delivery handler', () => {
    const customHandler: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    const previous = server.setDeliveryHandler(customHandler)

    expect(previous).toBeDefined()
    expect(typeof previous.deliverToAgent).toBe('function')
    expect(typeof previous.forwardToPeer).toBe('function')
  })

  it('should use custom handler for message delivery', async () => {
    const customDeliver = vi.fn().mockResolvedValue(true)
    const customHandler: DeliveryHandler = {
      deliverToAgent: customDeliver,
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    server.setDeliveryHandler(customHandler)

    // Register an agent and send a message
    server.registerAgent({ agentId: 'bob', ownerId: 'owner-1' })
    await server.send('alice', 'bob', { text: 'hello' })

    expect(customDeliver).toHaveBeenCalledWith(
      'bob',
      expect.objectContaining({
        from: 'alice',
        payload: { text: 'hello' },
      })
    )
  })

  it('should allow chaining to previous handler as fallback', async () => {
    const customHandler: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(false),
    }

    const previous = server.setDeliveryHandler(customHandler)

    // previous handler should still be callable
    const result = await previous.forwardToPeer('peer-1', ['agent-1'], {} as Message)
    expect(result).toBe(false) // default returns false
  })

  it('should support routeToFederation as optional', () => {
    const handlerWithoutFederation: DeliveryHandler = {
      deliverToAgent: vi.fn().mockResolvedValue(true),
      forwardToPeer: vi.fn().mockResolvedValue(true),
      // routeToFederation intentionally omitted
    }

    const previous = server.setDeliveryHandler(handlerWithoutFederation)
    expect(previous).toBeDefined()
  })
})

// =============================================================================
// API-2: MeshPeer Federation Lifecycle
// =============================================================================

describe('API-2: MeshPeer Federation Lifecycle', () => {
  let peer: MeshPeer

  beforeEach(async () => {
    peer = MeshPeer.createEmbedded({ peerId: 'system-a' })
    await peer.start()
  })

  afterEach(async () => {
    await peer.stop()
  })

  it('should create a federation gateway via federateWith()', async () => {
    const gateway = await peer.federateWith('system-b')

    expect(gateway).toBeDefined()
    expect(gateway.localSystemId).toBe('system-a')
    expect(gateway.remoteSystemId).toBe('system-b')
  })

  it('should return existing gateway on repeated federateWith()', async () => {
    const gw1 = await peer.federateWith('system-b')
    const gw2 = await peer.federateWith('system-b')

    expect(gw1).toBe(gw2)
  })

  it('should accept FederateConfig with buffer and routing', async () => {
    const gateway = await peer.federateWith('system-b', {
      buffer: { enabled: true, maxMessages: 500 },
      routing: { maxHops: 3, trackPath: true },
    })

    expect(gateway).toBeDefined()
    expect(gateway.remoteSystemId).toBe('system-b')
  })

  it('should retrieve gateway via getFederationGateway()', async () => {
    await peer.federateWith('system-b')

    const retrieved = peer.getFederationGateway('system-b')
    expect(retrieved).toBeDefined()
    expect(retrieved!.remoteSystemId).toBe('system-b')
  })

  it('should return undefined for unknown system in getFederationGateway()', () => {
    const retrieved = peer.getFederationGateway('nonexistent')
    expect(retrieved).toBeUndefined()
  })

  it('should list all gateways via getFederationGateways()', async () => {
    await peer.federateWith('system-b')
    await peer.federateWith('system-c')

    const gateways = peer.getFederationGateways()
    expect(gateways).toHaveLength(2)

    const systemIds = gateways.map((g) => g.remoteSystemId)
    expect(systemIds).toContain('system-b')
    expect(systemIds).toContain('system-c')
  })

  it('should remove gateway via defederate()', async () => {
    await peer.federateWith('system-b')
    expect(peer.getFederationGateway('system-b')).toBeDefined()

    await peer.defederate('system-b', 'test cleanup')
    expect(peer.getFederationGateway('system-b')).toBeUndefined()
  })

  it('should handle defederate for unknown system gracefully', async () => {
    // Should not throw
    await peer.defederate('nonexistent')
  })

  it('should expose server for setDeliveryHandler access', () => {
    expect(peer.server).toBeDefined()
    expect(typeof peer.server.setDeliveryHandler).toBe('function')
  })
})

// =============================================================================
// API-3: Channel Naming Convention
// =============================================================================

describe('API-3: Channel Naming Convention', () => {
  it('should export CHANNEL_PREFIXES with PROTOCOL prefix', () => {
    expect(CHANNEL_PREFIXES).toBeDefined()
    expect(CHANNEL_PREFIXES.PROTOCOL).toBe('proto:')
  })

  it('should produce correct channel names', () => {
    const channelName = `${CHANNEL_PREFIXES.PROTOCOL}agent-inbox`
    expect(channelName).toBe('proto:agent-inbox')
  })
})

// =============================================================================
// Finding-1: parseFederatedId
// =============================================================================

describe('Finding-1: parseFederatedId', () => {
  it('should parse federation-prefixed ID', () => {
    const result = parseFederatedId('system-a:alice')
    expect(result).toEqual({ system: 'system-a', agent: 'alice' })
  })

  it('should handle plain agent ID without prefix', () => {
    const result = parseFederatedId('alice')
    expect(result).toEqual({ agent: 'alice' })
  })

  it('should handle complex system IDs', () => {
    const result = parseFederatedId('org-1-system:agent-42')
    expect(result).toEqual({ system: 'org-1-system', agent: 'agent-42' })
  })

  it('should handle empty string', () => {
    const result = parseFederatedId('')
    expect(result).toEqual({ agent: '' })
  })

  it('should not split on leading colon', () => {
    const result = parseFederatedId(':agent')
    expect(result).toEqual({ agent: ':agent' })
  })

  it('should not split on trailing colon', () => {
    const result = parseFederatedId('system:')
    expect(result).toEqual({ agent: 'system:' })
  })
})

// =============================================================================
// Finding-2: _meta passthrough through delivery pipeline
// =============================================================================

describe('Finding-2: _meta passthrough', () => {
  let server: MapServer

  beforeEach(async () => {
    server = new MapServer({
      systemId: 'test-system',
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should preserve _meta through message delivery', async () => {
    const receivedMessages: Message[] = []
    const customHandler: DeliveryHandler = {
      deliverToAgent: async (_agentId, message) => {
        receivedMessages.push(message)
        return true
      },
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    server.setDeliveryHandler(customHandler)
    server.registerAgent({ agentId: 'bob', ownerId: 'owner-1' })

    await server.send('alice', 'bob', { text: 'hello' }, {
      priority: 'high',
      correlationId: 'thread-42',
      _meta: {
        subject: 'Code review',
        threadTag: 'pr-42',
        inReplyTo: 'prev-msg-id',
        conversationId: 'conv-1',
        inboxMessageId: '01ARZ',
        recipientKind: 'cc',
        customField: 'custom-value',
      },
    })

    expect(receivedMessages).toHaveLength(1)
    const msg = receivedMessages[0]

    // Verify _meta fields survive delivery
    expect(msg._meta).toBeDefined()
    expect(msg._meta!.subject).toBe('Code review')
    expect(msg._meta!.threadTag).toBe('pr-42')
    expect(msg._meta!.inReplyTo).toBe('prev-msg-id')
    expect(msg._meta!.conversationId).toBe('conv-1')
    expect(msg._meta!.inboxMessageId).toBe('01ARZ')
    expect(msg._meta!.recipientKind).toBe('cc')
    expect(msg._meta!.customField).toBe('custom-value')
  })

  it('should preserve meta.priority and meta.correlationId', async () => {
    const receivedMessages: Message[] = []
    const customHandler: DeliveryHandler = {
      deliverToAgent: async (_agentId, message) => {
        receivedMessages.push(message)
        return true
      },
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    server.setDeliveryHandler(customHandler)
    server.registerAgent({ agentId: 'bob', ownerId: 'owner-1' })

    await server.send('alice', 'bob', 'payload', {
      priority: 'urgent',
      correlationId: 'corr-123',
    })

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0].meta?.priority).toBe('urgent')
    expect(receivedMessages[0].meta?.correlationId).toBe('corr-123')
  })

  it('should handle messages without _meta', async () => {
    const receivedMessages: Message[] = []
    const customHandler: DeliveryHandler = {
      deliverToAgent: async (_agentId, message) => {
        receivedMessages.push(message)
        return true
      },
      forwardToPeer: vi.fn().mockResolvedValue(true),
    }

    server.setDeliveryHandler(customHandler)
    server.registerAgent({ agentId: 'bob', ownerId: 'owner-1' })

    await server.send('alice', 'bob', 'simple payload')

    expect(receivedMessages).toHaveLength(1)
    // Should not have _meta
    expect(receivedMessages[0]._meta).toBeUndefined()
  })
})
