import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventBus } from '../../src/map/server/event-bus'
import { EVENT_TYPES, createEvent } from '../../src/map/types'
import type { Event, SubscriptionFilter } from '../../src/map/types'

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus({ maxHistorySize: 100, retentionMs: 3600000 })
  })

  afterEach(() => {
    bus.clear()
  })

  describe('Subscription', () => {
    it('should create a subscription', () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
      })

      expect(subscription.id).toBeDefined()
      expect(bus.subscriptionCount).toBe(1)
    })

    it('should unsubscribe', () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
      })

      subscription.unsubscribe()

      expect(bus.subscriptionCount).toBe(0)
    })

    it('should unsubscribe all for a participant', () => {
      bus.subscribe({ participantId: 'participant-1' })
      bus.subscribe({ participantId: 'participant-1' })
      bus.subscribe({ participantId: 'participant-2' })

      bus.unsubscribeAll('participant-1')

      expect(bus.subscriptionCount).toBe(1)
    })
  })

  describe('Event Publishing', () => {
    it('should publish events to subscribers', async () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
      })

      const event = createEvent({
        type: EVENT_TYPES.AGENT_REGISTERED,
        data: { agentId: 'agent-1' },
      })

      bus.publish(event)

      const events: Event[] = []
      const iterator = subscription.events()[Symbol.asyncIterator]()
      const result = await iterator.next()

      expect(result.done).toBe(false)
      expect(result.value.type).toBe(EVENT_TYPES.AGENT_REGISTERED)
    })

    it('should emit event using convenience method', () => {
      const handler = vi.fn()
      bus.on('event', handler)

      const event = bus.emitEvent(
        EVENT_TYPES.AGENT_STATE_CHANGED,
        { agentId: 'agent-1', newState: 'active' },
        'source-1'
      )

      expect(event.type).toBe(EVENT_TYPES.AGENT_STATE_CHANGED)
      expect(event.source).toBe('source-1')
      expect(handler).toHaveBeenCalledWith(event)
    })

    it('should store events in history', () => {
      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-2' })

      expect(bus.historySize).toBe(2)
    })
  })

  describe('Filtering', () => {
    it('should filter by event type', async () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
        filter: {
          eventTypes: [EVENT_TYPES.AGENT_REGISTERED],
        },
      })

      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_STATE_CHANGED, { agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-2' })

      const events: Event[] = []
      const iterator = subscription.events()[Symbol.asyncIterator]()

      // Should receive 2 events (only AGENT_REGISTERED)
      const result1 = await iterator.next()
      const result2 = await iterator.next()

      expect(result1.value.type).toBe(EVENT_TYPES.AGENT_REGISTERED)
      expect(result2.value.type).toBe(EVENT_TYPES.AGENT_REGISTERED)
    })

    it('should filter by source agent', async () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
        filter: {
          fromAgents: ['agent-1'],
        },
      })

      bus.emitEvent(EVENT_TYPES.MESSAGE_SENT, { messageId: 'msg-1' }, 'agent-1')
      bus.emitEvent(EVENT_TYPES.MESSAGE_SENT, { messageId: 'msg-2' }, 'agent-2')

      const iterator = subscription.events()[Symbol.asyncIterator]()
      const result = await iterator.next()

      expect(result.value.source).toBe('agent-1')
    })

    it('should filter by scope', async () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
        filter: {
          scopes: ['scope-1'],
        },
      })

      bus.emitEvent(EVENT_TYPES.SCOPE_MEMBER_JOINED, { scopeId: 'scope-1', agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.SCOPE_MEMBER_JOINED, { scopeId: 'scope-2', agentId: 'agent-2' })

      const iterator = subscription.events()[Symbol.asyncIterator]()
      const result = await iterator.next()

      expect((result.value.data as { scopeId: string }).scopeId).toBe('scope-1')
    })

    it('should exclude own events when option is set', async () => {
      const subscription = bus.subscribe({
        participantId: 'agent-1',
        options: {
          excludeOwnEvents: true,
        },
      })

      bus.emitEvent(EVENT_TYPES.MESSAGE_SENT, { messageId: 'msg-1' }, 'agent-1')
      bus.emitEvent(EVENT_TYPES.MESSAGE_SENT, { messageId: 'msg-2' }, 'agent-2')

      const iterator = subscription.events()[Symbol.asyncIterator]()
      const result = await iterator.next()

      expect(result.value.source).toBe('agent-2')
    })

    it('should match multiple event types with OR', async () => {
      const subscription = bus.subscribe({
        participantId: 'participant-1',
        filter: {
          eventTypes: [EVENT_TYPES.AGENT_REGISTERED, EVENT_TYPES.AGENT_UNREGISTERED],
        },
      })

      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_STATE_CHANGED, { agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_UNREGISTERED, { agentId: 'agent-1' })

      const iterator = subscription.events()[Symbol.asyncIterator]()

      const result1 = await iterator.next()
      const result2 = await iterator.next()

      expect([result1.value.type, result2.value.type].sort()).toEqual([
        EVENT_TYPES.AGENT_REGISTERED,
        EVENT_TYPES.AGENT_UNREGISTERED,
      ])
    })
  })

  describe('Replay', () => {
    beforeEach(() => {
      // Emit some events
      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_STATE_CHANGED, { agentId: 'agent-1', newState: 'active' })
      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-2' })
    })

    it('should replay all events', () => {
      const result = bus.replay({})
      expect(result.events).toHaveLength(3)
    })

    it('should replay with limit', () => {
      const result = bus.replay({ limit: 2 })
      expect(result.events).toHaveLength(2)
      expect(result.hasMore).toBe(true)
    })

    it('should replay with filter', () => {
      const result = bus.replay({
        filter: {
          eventTypes: [EVENT_TYPES.AGENT_REGISTERED],
        },
      })
      expect(result.events).toHaveLength(2)
    })

    it('should replay after event ID', () => {
      const allEvents = bus.replay({})
      const firstEventId = allEvents.events[0].id

      const result = bus.replay({ afterEventId: firstEventId })
      expect(result.events).toHaveLength(2)
      expect(result.events[0].id).not.toBe(firstEventId)
    })

    it('should replay from timestamp', () => {
      const futureTimestamp = Date.now() + 1000

      const result = bus.replay({ fromTimestamp: futureTimestamp })
      expect(result.events).toHaveLength(0)
    })
  })

  describe('History Management', () => {
    it('should enforce max history size', () => {
      const smallBus = new EventBus({ maxHistorySize: 3, retentionMs: 3600000 })

      for (let i = 0; i < 5; i++) {
        smallBus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: `agent-${i}` })
      }

      expect(smallBus.historySize).toBe(3)
    })
  })

  describe('Clear', () => {
    it('should clear all subscriptions and history', () => {
      bus.subscribe({ participantId: 'participant-1' })
      bus.emitEvent(EVENT_TYPES.AGENT_REGISTERED, { agentId: 'agent-1' })

      bus.clear()

      expect(bus.subscriptionCount).toBe(0)
      expect(bus.historySize).toBe(0)
    })
  })
})
