/**
 * Event Bus
 *
 * Manages event distribution and subscriptions in the MAP server.
 */

import { EventEmitter } from 'events'
import type {
  Event,
  EventType,
  SubscriptionFilter,
  SubscriptionOptions,
  SubscriptionId,
  ParticipantId,
  AgentId,
  ScopeId,
  Timestamp,
} from '../types'
import { createEvent, EVENT_TYPES } from '../types'
import type { EventSubscription } from '../types'

/**
 * Internal subscription record.
 */
interface SubscriptionRecord {
  id: SubscriptionId
  participantId: ParticipantId
  filter?: SubscriptionFilter
  options?: SubscriptionOptions
  createdAt: Timestamp
  eventQueue: Event[]
  waitingReaders: Array<{
    resolve: (value: IteratorResult<Event>) => void
    reject: (error: Error) => void
  }>
  closed: boolean
}

/**
 * Parameters for creating a subscription.
 */
export interface SubscriptionParams {
  participantId: ParticipantId
  filter?: SubscriptionFilter
  options?: SubscriptionOptions
}

/**
 * Event Bus - distributes events to subscribers.
 */
export class EventBus extends EventEmitter {
  private readonly subscriptions = new Map<SubscriptionId, SubscriptionRecord>()
  private readonly participantSubscriptions = new Map<ParticipantId, Set<SubscriptionId>>()
  private readonly eventHistory: Event[] = []
  private readonly maxHistorySize: number
  private readonly retentionMs: number

  constructor(options?: { maxHistorySize?: number; retentionMs?: number }) {
    super()
    this.maxHistorySize = options?.maxHistorySize ?? 10000
    this.retentionMs = options?.retentionMs ?? 3600000 // 1 hour
  }

  /**
   * Generate a unique subscription ID.
   */
  private generateSubscriptionId(): SubscriptionId {
    return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Create a subscription.
   */
  subscribe(params: SubscriptionParams): EventSubscription {
    const id = this.generateSubscriptionId()
    const now = Date.now()

    const record: SubscriptionRecord = {
      id,
      participantId: params.participantId,
      filter: params.filter,
      options: params.options,
      createdAt: now,
      eventQueue: [],
      waitingReaders: [],
      closed: false,
    }

    this.subscriptions.set(id, record)

    if (!this.participantSubscriptions.has(params.participantId)) {
      this.participantSubscriptions.set(params.participantId, new Set())
    }
    this.participantSubscriptions.get(params.participantId)!.add(id)

    const subscription: EventSubscription = {
      id,
      filter: params.filter,
      options: params.options,
      events: () => this.createEventIterator(id),
      unsubscribe: () => this.unsubscribe(id),
    }

    return subscription
  }

  /**
   * Unsubscribe.
   */
  unsubscribe(subscriptionId: SubscriptionId): void {
    const record = this.subscriptions.get(subscriptionId)
    if (!record) return

    record.closed = true

    // Signal end to any waiting readers
    for (const reader of record.waitingReaders) {
      reader.resolve({ value: undefined as unknown as Event, done: true })
    }
    record.waitingReaders = []

    this.participantSubscriptions.get(record.participantId)?.delete(subscriptionId)
    this.subscriptions.delete(subscriptionId)
  }

  /**
   * Unsubscribe all subscriptions for a participant.
   */
  unsubscribeAll(participantId: ParticipantId): void {
    const subscriptionIds = this.participantSubscriptions.get(participantId)
    if (!subscriptionIds) return

    for (const id of subscriptionIds) {
      this.unsubscribe(id)
    }

    this.participantSubscriptions.delete(participantId)
  }

  /**
   * Publish an event.
   */
  publish(event: Event): void {
    // Store in history
    this.eventHistory.push(event)
    this.pruneHistory()

    // Deliver to matching subscriptions
    for (const record of this.subscriptions.values()) {
      if (record.closed) continue
      if (!this.matchesFilter(event, record.filter, record.options, record.participantId)) continue

      this.deliverToSubscription(record, event)
    }

    // Emit for external listeners
    this.emit('event', event)
  }

  /**
   * Emit an event (convenience method that creates and publishes).
   */
  emitEvent(
    type: EventType,
    data?: Record<string, unknown>,
    source?: ParticipantId,
    causedBy?: string[]
  ): Event {
    const event = createEvent({ type, data, source, causedBy })
    this.publish(event)
    return event
  }

  /**
   * Check if an event matches a subscription filter.
   */
  private matchesFilter(
    event: Event,
    filter?: SubscriptionFilter,
    options?: SubscriptionOptions,
    participantId?: ParticipantId
  ): boolean {
    // Check excludeOwnEvents first (before any filter checks)
    if (options?.excludeOwnEvents && event.source === participantId) {
      return false
    }

    if (!filter) return true

    // Filter by event type
    if (filter.eventTypes && filter.eventTypes.length > 0) {
      if (!filter.eventTypes.includes(event.type)) {
        return false
      }
    }

    // Filter by source agents
    if (filter.fromAgents && filter.fromAgents.length > 0) {
      if (!event.source || !filter.fromAgents.includes(event.source)) {
        return false
      }
    }

    // Filter by agents (legacy - related agents)
    if (filter.agents && filter.agents.length > 0) {
      const relatedAgentId = (event.data as Record<string, unknown>)?.agentId as string | undefined
      if (!relatedAgentId || !filter.agents.includes(relatedAgentId)) {
        return false
      }
    }

    // Filter by scopes
    if (filter.scopes && filter.scopes.length > 0) {
      const scopeId = (event.data as Record<string, unknown>)?.scopeId as string | undefined
      if (!scopeId || !filter.scopes.includes(scopeId)) {
        return false
      }
    }

    // Filter by roles
    if (filter.roles && filter.roles.length > 0) {
      const role = (event.data as Record<string, unknown>)?.role as string | undefined
      if (!role || !filter.roles.includes(role)) {
        return false
      }
    }

    // Filter by source roles
    if (filter.fromRoles && filter.fromRoles.length > 0) {
      const sourceRole = (event.data as Record<string, unknown>)?.sourceRole as string | undefined
      if (!sourceRole || !filter.fromRoles.includes(sourceRole)) {
        return false
      }
    }

    // Filter by correlation IDs
    if (filter.correlationIds && filter.correlationIds.length > 0) {
      const correlationId = (event.data as Record<string, unknown>)?.correlationId as string | undefined
      if (!correlationId || !filter.correlationIds.includes(correlationId)) {
        return false
      }
    }

    // Filter by priorities (for message events)
    if (filter.priorities && filter.priorities.length > 0) {
      const priority = (event.data as Record<string, unknown>)?.priority as string | undefined
      if (!priority || !filter.priorities.includes(priority as never)) {
        return false
      }
    }

    // Filter by metadata match
    if (filter.metadataMatch) {
      const metadata = (event.data as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined
      if (!metadata) return false

      for (const [key, value] of Object.entries(filter.metadataMatch)) {
        if (metadata[key] !== value) return false
      }
    }

    return true
  }

  /**
   * Deliver an event to a subscription.
   */
  private deliverToSubscription(record: SubscriptionRecord, event: Event): void {
    if (record.waitingReaders.length > 0) {
      const reader = record.waitingReaders.shift()!
      reader.resolve({ value: event, done: false })
    } else {
      record.eventQueue.push(event)
    }
  }

  /**
   * Create an async iterator for a subscription.
   */
  private createEventIterator(subscriptionId: SubscriptionId): AsyncIterable<Event> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<Event> {
        return {
          async next(): Promise<IteratorResult<Event>> {
            const record = self.subscriptions.get(subscriptionId)
            if (!record || record.closed) {
              return { value: undefined as unknown as Event, done: true }
            }

            // Return queued events first
            if (record.eventQueue.length > 0) {
              return { value: record.eventQueue.shift()!, done: false }
            }

            // Wait for next event
            return new Promise((resolve, reject) => {
              record.waitingReaders.push({ resolve, reject })
            })
          },
        }
      },
    }
  }

  /**
   * Prune old events from history.
   */
  private pruneHistory(): void {
    const cutoff = Date.now() - this.retentionMs

    // Remove old events
    while (this.eventHistory.length > 0 && this.eventHistory[0].timestamp < cutoff) {
      this.eventHistory.shift()
    }

    // Enforce max size
    while (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift()
    }
  }

  /**
   * Replay events from history.
   */
  replay(params: {
    afterEventId?: string
    fromTimestamp?: Timestamp
    toTimestamp?: Timestamp
    filter?: SubscriptionFilter
    limit?: number
  }): { events: Event[]; hasMore: boolean } {
    let events = [...this.eventHistory]
    const limit = params.limit ?? 100

    // Filter by time range
    if (params.fromTimestamp !== undefined) {
      events = events.filter((e) => e.timestamp >= params.fromTimestamp!)
    }

    if (params.toTimestamp !== undefined) {
      events = events.filter((e) => e.timestamp <= params.toTimestamp!)
    }

    // Filter by event ID (find events after this one)
    if (params.afterEventId !== undefined) {
      const index = events.findIndex((e) => e.id === params.afterEventId)
      if (index !== -1) {
        events = events.slice(index + 1)
      }
    }

    // Apply subscription filter
    if (params.filter) {
      events = events.filter((e) => this.matchesFilter(e, params.filter))
    }

    const hasMore = events.length > limit
    if (hasMore) {
      events = events.slice(0, limit)
    }

    return { events, hasMore }
  }

  /**
   * Get subscription count.
   */
  get subscriptionCount(): number {
    return this.subscriptions.size
  }

  /**
   * Get event history size.
   */
  get historySize(): number {
    return this.eventHistory.length
  }

  /**
   * Clear all subscriptions and history.
   */
  clear(): void {
    for (const id of this.subscriptions.keys()) {
      this.unsubscribe(id)
    }
    this.eventHistory.length = 0
  }
}
