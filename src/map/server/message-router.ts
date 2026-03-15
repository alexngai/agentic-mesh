/**
 * Message Router
 *
 * Routes messages to their destinations based on MAP addressing.
 */

import { EventEmitter } from 'events'
import type {
  Address,
  Message,
  MessageId,
  ParticipantId,
  AgentId,
  ScopeId,
  MessageMeta,
  MessagePriority,
} from '../types'
import {
  isDirectAddress,
  isScopeAddress,
  isBroadcastAddress,
  isHierarchicalAddress,
  isFederatedAddress,
  EVENT_TYPES,
} from '../types'
import type { ResolvedAddress, SendResult } from '../types'
import type { AgentRegistry } from './agent-registry'
import type { ScopeManager } from './scope-manager'
import type { EventBus } from './event-bus'

/**
 * Delivery handler for sending messages to targets.
 */
export interface DeliveryHandler {
  /** Deliver to a local agent */
  deliverToAgent(agentId: AgentId, message: Message): Promise<boolean>

  /** Forward to a remote peer */
  forwardToPeer(peerId: string, agentIds: AgentId[], message: Message): Promise<boolean>

  /** Route to a federated system */
  routeToFederation?(systemId: string, agentIds: AgentId[], message: Message): Promise<boolean>
}

/**
 * Configuration for the message router.
 */
export interface MessageRouterConfig {
  /** Local system ID */
  systemId: string

  /** Agent registry */
  agentRegistry: AgentRegistry

  /** Scope manager */
  scopeManager: ScopeManager

  /** Event bus */
  eventBus: EventBus

  /** Delivery handler */
  deliveryHandler: DeliveryHandler

  /** Map of agent IDs to peer IDs (for remote agents) */
  agentPeerMap?: Map<AgentId, string>
}

/**
 * Message Router - resolves addresses and routes messages.
 */
export class MessageRouter extends EventEmitter {
  private readonly systemId: string
  private readonly agentRegistry: AgentRegistry
  private readonly scopeManager: ScopeManager
  private readonly eventBus: EventBus
  private deliveryHandler: DeliveryHandler
  private readonly agentPeerMap: Map<AgentId, string>

  constructor(config: MessageRouterConfig) {
    super()
    this.systemId = config.systemId
    this.agentRegistry = config.agentRegistry
    this.scopeManager = config.scopeManager
    this.eventBus = config.eventBus
    this.deliveryHandler = config.deliveryHandler
    this.agentPeerMap = config.agentPeerMap ?? new Map()
  }

  /**
   * Replace the delivery handler.
   * Returns the previous handler so it can be used as a fallback.
   */
  setDeliveryHandler(handler: DeliveryHandler): DeliveryHandler {
    const previous = this.deliveryHandler
    this.deliveryHandler = handler
    return previous
  }

  /**
   * Generate a unique message ID.
   */
  private generateMessageId(): MessageId {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Send a message.
   */
  async send(
    from: ParticipantId,
    to: Address,
    payload: unknown,
    meta?: MessageMeta
  ): Promise<SendResult> {
    const messageId = this.generateMessageId()
    const now = Date.now()

    const message: Message = {
      id: messageId,
      from,
      to,
      timestamp: now,
      payload,
      meta: {
        ...meta,
        timestamp: now,
      },
      _meta: meta?._meta,
    }

    // Resolve the address to actual targets
    const resolved = this.resolveAddress(to, from)

    // Deliver to all targets
    const delivered: ParticipantId[] = []
    const failed: Array<{ participantId: ParticipantId; reason: string }> = []

    // Deliver to local agents
    for (const agentId of resolved.localAgents) {
      try {
        const success = await this.deliveryHandler.deliverToAgent(agentId, message)
        if (success) {
          delivered.push(agentId)
        } else {
          failed.push({ participantId: agentId, reason: 'Delivery failed' })
        }
      } catch (err) {
        failed.push({ participantId: agentId, reason: (err as Error).message })
      }
    }

    // Forward to remote peers
    for (const { peerId, agentIds } of resolved.remotePeers) {
      try {
        const success = await this.deliveryHandler.forwardToPeer(peerId, agentIds, message)
        if (success) {
          delivered.push(...agentIds)
        } else {
          for (const agentId of agentIds) {
            failed.push({ participantId: agentId, reason: 'Forward to peer failed' })
          }
        }
      } catch (err) {
        for (const agentId of agentIds) {
          failed.push({ participantId: agentId, reason: (err as Error).message })
        }
      }
    }

    // Route to federated systems
    if (resolved.federatedSystems && this.deliveryHandler.routeToFederation) {
      for (const { systemId, agentIds } of resolved.federatedSystems) {
        try {
          const success = await this.deliveryHandler.routeToFederation(systemId, agentIds, message)
          if (success) {
            delivered.push(...agentIds)
          } else {
            for (const agentId of agentIds) {
              failed.push({ participantId: agentId, reason: 'Federation routing failed' })
            }
          }
        } catch (err) {
          for (const agentId of agentIds) {
            failed.push({ participantId: agentId, reason: (err as Error).message })
          }
        }
      }
    }

    // Emit events
    this.eventBus.emitEvent(EVENT_TYPES.MESSAGE_SENT, {
      messageId,
      from,
      to,
      timestamp: now,
      correlationId: meta?.correlationId,
      priority: meta?.priority,
    }, from)

    if (delivered.length > 0) {
      this.eventBus.emitEvent(EVENT_TYPES.MESSAGE_DELIVERED, {
        messageId,
        from,
        deliveredTo: delivered,
        timestamp: Date.now(),
        correlationId: meta?.correlationId,
      }, from)
    }

    if (failed.length > 0) {
      this.eventBus.emitEvent(EVENT_TYPES.MESSAGE_FAILED, {
        messageId,
        from,
        to,
        reason: `Failed to deliver to ${failed.length} recipients`,
        failedRecipients: failed,
      }, from)
    }

    return {
      messageId,
      delivered,
      failed: failed.length > 0 ? failed : undefined,
    }
  }

  /**
   * Resolve an address to actual targets.
   */
  resolveAddress(address: Address, senderId?: ParticipantId): ResolvedAddress {
    const localAgents: AgentId[] = []
    const remotePeers: Array<{ peerId: string; agentIds: AgentId[] }> = []
    const federatedSystems: Array<{ systemId: string; agentIds: AgentId[] }> = []

    // String shorthand = direct agent address
    if (typeof address === 'string') {
      this.addToResolution(address, localAgents, remotePeers)
      return { localAgents, remotePeers, federatedSystems }
    }

    // Direct address
    if (isDirectAddress(address)) {
      this.addToResolution(address.agent, localAgents, remotePeers)
      return { localAgents, remotePeers, federatedSystems }
    }

    // Multi address
    if ('agents' in address && Array.isArray((address as { agents: AgentId[] }).agents)) {
      for (const agentId of (address as { agents: AgentId[] }).agents) {
        this.addToResolution(agentId, localAgents, remotePeers)
      }
      return { localAgents, remotePeers, federatedSystems }
    }

    // Scope address
    if (isScopeAddress(address)) {
      const members = this.scopeManager.getMembers(address.scope)
      for (const agentId of members) {
        this.addToResolution(agentId, localAgents, remotePeers)
      }
      return { localAgents, remotePeers, federatedSystems }
    }

    // Role address
    if ('role' in address && typeof (address as { role: string }).role === 'string') {
      const roleAddress = address as { role: string; within?: ScopeId }
      let agents = this.agentRegistry.getByRole(roleAddress.role)

      // Filter by scope if specified
      if (roleAddress.within) {
        const scopeMembers = new Set(this.scopeManager.getMembers(roleAddress.within))
        agents = agents.filter((a) => scopeMembers.has(a.id))
      }

      for (const agent of agents) {
        this.addToResolution(agent.id, localAgents, remotePeers)
      }
      return { localAgents, remotePeers, federatedSystems }
    }

    // Hierarchical address
    if (isHierarchicalAddress(address) && senderId) {
      const senderAgent = this.agentRegistry.get(senderId)
      if (!senderAgent) {
        return { localAgents, remotePeers, federatedSystems }
      }

      if (address.parent) {
        const parent = this.agentRegistry.getParent(senderId)
        if (parent) {
          this.addToResolution(parent.id, localAgents, remotePeers)
        }
      }

      if (address.children) {
        const children = this.agentRegistry.getChildren(senderId)
        for (const child of children) {
          this.addToResolution(child.id, localAgents, remotePeers)
        }
      }

      if (address.ancestors) {
        const ancestors = this.agentRegistry.getAncestors(senderId, address.depth)
        for (const ancestor of ancestors) {
          this.addToResolution(ancestor.id, localAgents, remotePeers)
        }
      }

      if (address.descendants) {
        const descendants = this.agentRegistry.getDescendants(senderId, address.depth)
        for (const descendant of descendants) {
          this.addToResolution(descendant.id, localAgents, remotePeers)
        }
      }

      if (address.siblings) {
        const siblings = this.agentRegistry.getSiblings(senderId)
        for (const sibling of siblings) {
          this.addToResolution(sibling.id, localAgents, remotePeers)
        }
      }

      return { localAgents, remotePeers, federatedSystems }
    }

    // Broadcast address
    if (isBroadcastAddress(address)) {
      for (const agent of this.agentRegistry.list()) {
        this.addToResolution(agent.id, localAgents, remotePeers)
      }
      return { localAgents, remotePeers, federatedSystems }
    }

    // System address - message to the system itself
    if ('system' in address && (address as { system: true }).system === true) {
      // System messages are handled by the server, not routed to agents
      return { localAgents, remotePeers, federatedSystems }
    }

    // Participant address
    if ('participant' in address || 'participants' in address) {
      const participantAddress = address as { participant?: ParticipantId; participants?: 'all' | 'agents' | 'clients' }

      if (participantAddress.participant) {
        // Single participant - check if it's a known agent
        this.addToResolution(participantAddress.participant, localAgents, remotePeers)
      } else if (participantAddress.participants === 'agents') {
        for (const agent of this.agentRegistry.list()) {
          this.addToResolution(agent.id, localAgents, remotePeers)
        }
      }
      // Note: 'clients' and 'all' participants are handled at a higher level

      return { localAgents, remotePeers, federatedSystems }
    }

    // Federated address
    if (isFederatedAddress(address)) {
      federatedSystems.push({
        systemId: address.system,
        agentIds: [address.agent],
      })
      return { localAgents, remotePeers, federatedSystems }
    }

    return { localAgents, remotePeers, federatedSystems }
  }

  /**
   * Add an agent to the appropriate resolution bucket.
   */
  private addToResolution(
    agentId: AgentId,
    localAgents: AgentId[],
    remotePeers: Array<{ peerId: string; agentIds: AgentId[] }>
  ): void {
    // Check if agent is local
    if (this.agentRegistry.has(agentId)) {
      localAgents.push(agentId)
      return
    }

    // Check if agent is on a known remote peer
    const peerId = this.agentPeerMap.get(agentId)
    if (peerId) {
      let peerEntry = remotePeers.find((p) => p.peerId === peerId)
      if (!peerEntry) {
        peerEntry = { peerId, agentIds: [] }
        remotePeers.push(peerEntry)
      }
      peerEntry.agentIds.push(agentId)
    }
  }

  /**
   * Register a remote agent's location.
   */
  registerRemoteAgent(agentId: AgentId, peerId: string): void {
    this.agentPeerMap.set(agentId, peerId)
  }

  /**
   * Unregister a remote agent.
   */
  unregisterRemoteAgent(agentId: AgentId): void {
    this.agentPeerMap.delete(agentId)
  }

  /**
   * Unregister all agents on a peer.
   */
  unregisterPeerAgents(peerId: string): void {
    for (const [agentId, pId] of this.agentPeerMap) {
      if (pId === peerId) {
        this.agentPeerMap.delete(agentId)
      }
    }
  }

  /**
   * Get the peer ID for a remote agent.
   */
  getAgentPeer(agentId: AgentId): string | undefined {
    return this.agentPeerMap.get(agentId)
  }
}
