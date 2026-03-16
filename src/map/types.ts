/**
 * MAP Protocol Types for agentic-mesh
 *
 * Core Multi-Agent Protocol (MAP) type definitions.
 * These types are based on the MAP specification and extended
 * with agentic-mesh specific types for transport integration.
 */

import type { TransportAdapter, PeerEndpoint } from '../transports/types'

// =============================================================================
// Primitive Types & Identifiers
// =============================================================================

/** Unique identifier for any participant (agent, client, system, gateway) */
export type ParticipantId = string

/** Unique identifier for an agent */
export type AgentId = string

/** Unique identifier for a scope */
export type ScopeId = string

/** Unique identifier for a session */
export type SessionId = string

/** Unique identifier for a message */
export type MessageId = string

/** Unique identifier for a subscription */
export type SubscriptionId = string

/** Identifier for correlating related messages */
export type CorrelationId = string

/** JSON-RPC request ID */
export type RequestId = string | number

/** MAP protocol version */
export type ProtocolVersion = 1

/** Protocol version constant */
export const PROTOCOL_VERSION: ProtocolVersion = 1

/** Unix timestamp in milliseconds */
export type Timestamp = number

/** Vendor extension metadata */
export type Meta = Record<string, unknown>

// =============================================================================
// JSON-RPC Constants
// =============================================================================

/** JSON-RPC version constant */
export const JSONRPC_VERSION = '2.0' as const

/** JSON-RPC standard error codes */
export const PROTOCOL_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/** Authentication error codes */
export const AUTH_ERROR_CODES = {
  AUTH_REQUIRED: 1000,
  AUTH_FAILED: 1001,
  TOKEN_EXPIRED: 1002,
  PERMISSION_DENIED: 1003,
} as const

/** Routing error codes */
export const ROUTING_ERROR_CODES = {
  ADDRESS_NOT_FOUND: 2000,
  AGENT_NOT_FOUND: 2001,
  SCOPE_NOT_FOUND: 2002,
  DELIVERY_FAILED: 2003,
  ADDRESS_AMBIGUOUS: 2004,
} as const

/** Agent error codes */
export const AGENT_ERROR_CODES = {
  AGENT_EXISTS: 3000,
  STATE_INVALID: 3001,
  NOT_RESPONDING: 3002,
  TERMINATED: 3003,
  SPAWN_FAILED: 3004,
} as const

/** Resource error codes */
export const RESOURCE_ERROR_CODES = {
  EXHAUSTED: 4000,
  RATE_LIMITED: 4001,
  QUOTA_EXCEEDED: 4002,
} as const

/** Federation error codes */
export const FEDERATION_ERROR_CODES = {
  FEDERATION_UNAVAILABLE: 5000,
  FEDERATION_SYSTEM_NOT_FOUND: 5001,
  FEDERATION_AUTH_FAILED: 5002,
  FEDERATION_ROUTE_REJECTED: 5003,
  FEDERATION_LOOP_DETECTED: 5010,
  FEDERATION_MAX_HOPS_EXCEEDED: 5011,
} as const

/** All error codes */
export const ERROR_CODES = {
  ...PROTOCOL_ERROR_CODES,
  ...AUTH_ERROR_CODES,
  ...ROUTING_ERROR_CODES,
  ...AGENT_ERROR_CODES,
  ...RESOURCE_ERROR_CODES,
  ...FEDERATION_ERROR_CODES,
} as const

// =============================================================================
// Method Constants
// =============================================================================

/** Core protocol methods */
export const CORE_METHODS = {
  CONNECT: 'map/connect',
  DISCONNECT: 'map/disconnect',
  SEND: 'map/send',
  SUBSCRIBE: 'map/subscribe',
  UNSUBSCRIBE: 'map/unsubscribe',
} as const

/** Observation methods */
export const OBSERVATION_METHODS = {
  AGENTS_LIST: 'map/agents.list',
  AGENTS_GET: 'map/agents.get',
  SCOPES_LIST: 'map/scopes.list',
  SCOPES_GET: 'map/scopes.get',
  SCOPES_MEMBERS: 'map/scopes.members',
  STRUCTURE_GRAPH: 'map/structure.graph',
} as const

/** Lifecycle methods */
export const LIFECYCLE_METHODS = {
  AGENTS_REGISTER: 'map/agents.register',
  AGENTS_UNREGISTER: 'map/agents.unregister',
  AGENTS_SPAWN: 'map/agents.spawn',
} as const

/** State methods */
export const STATE_METHODS = {
  AGENTS_UPDATE: 'map/agents.update',
  SCOPES_CREATE: 'map/scopes.create',
  SCOPES_DELETE: 'map/scopes.delete',
  SCOPES_JOIN: 'map/scopes.join',
  SCOPES_LEAVE: 'map/scopes.leave',
} as const

/** Federation methods */
export const FEDERATION_METHODS = {
  ROUTE: 'map/federation.route',
  ANNOUNCE: 'map/federation.announce',
  CONNECT: 'map/federation.connect',
  DISCONNECT: 'map/federation.disconnect',
  FEDERATION_CONNECT: 'map/federation.connect',
  FEDERATION_ROUTE: 'map/federation.route',
} as const

/** Notification methods */
export const NOTIFICATION_METHODS = {
  EVENT: 'map/event',
  MESSAGE: 'map/message',
  SUBSCRIPTION_ACK: 'map/subscribe.ack',
  REPLAY: 'map/events.replay',
} as const

/** All MAP methods */
export const MAP_METHODS = {
  ...CORE_METHODS,
  ...OBSERVATION_METHODS,
  ...LIFECYCLE_METHODS,
  ...STATE_METHODS,
  ...FEDERATION_METHODS,
  ...NOTIFICATION_METHODS,
} as const

// =============================================================================
// Channel Naming Convention
// =============================================================================

/**
 * Channel name prefixes for avoiding collisions on shared meshes.
 *
 * Protocol/infrastructure channels use "proto:" prefix.
 * Application channels use no prefix.
 *
 * @example
 * ```typescript
 * const channelName = `${CHANNEL_PREFIXES.PROTOCOL}agent-inbox`; // "proto:agent-inbox"
 * ```
 */
export const CHANNEL_PREFIXES = {
  /** Prefix for protocol/infrastructure channels */
  PROTOCOL: 'proto:',
} as const

// =============================================================================
// Error Types
// =============================================================================

/** Category of error for handling decisions */
export type ErrorCategory =
  | 'protocol'
  | 'auth'
  | 'routing'
  | 'agent'
  | 'resource'
  | 'federation'
  | 'internal'

/** Structured error data */
export interface MAPErrorData {
  category?: ErrorCategory
  retryable?: boolean
  retryAfterMs?: number
  details?: Record<string, unknown>
  _meta?: Meta
}

/** JSON-RPC 2.0 error object */
export interface MAPError {
  code: number
  message: string
  data?: MAPErrorData | Record<string, unknown>
}

// =============================================================================
// Participant Types
// =============================================================================

/** Type of participant in the protocol */
export type ParticipantType = 'agent' | 'client' | 'system' | 'gateway'

/** Transport binding type */
export type TransportType = 'websocket' | 'stdio' | 'inprocess' | 'http-sse'

/** Streaming capabilities for backpressure and flow control */
export interface StreamingCapabilities {
  supportsAck?: boolean
  supportsFlowControl?: boolean
  supportsPause?: boolean
}

/** Capabilities of a participant */
export interface ParticipantCapabilities {
  observation?: {
    canObserve?: boolean
    canQuery?: boolean
  }
  messaging?: {
    canSend?: boolean
    canReceive?: boolean
    canBroadcast?: boolean
  }
  lifecycle?: {
    canSpawn?: boolean
    canRegister?: boolean
    canUnregister?: boolean
    canSteer?: boolean
    canStop?: boolean
  }
  scopes?: {
    canCreateScopes?: boolean
    canManageScopes?: boolean
  }
  federation?: {
    canFederate?: boolean
  }
  streaming?: StreamingCapabilities
  _meta?: Meta
}

/** A participant in the MAP protocol */
export interface Participant {
  id: ParticipantId
  type: ParticipantType
  name?: string
  capabilities?: ParticipantCapabilities
  transport?: TransportType
  sessionId?: SessionId
  metadata?: Record<string, unknown>
  _meta?: Meta
}

// =============================================================================
// Agent Types
// =============================================================================

/** State of an agent */
export type AgentState =
  | 'registered'
  | 'active'
  | 'busy'
  | 'idle'
  | 'suspended'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'orphaned'
  | `x-${string}`

/** Type of relationship between agents */
export type AgentRelationshipType = 'peer' | 'supervisor' | 'supervised' | 'collaborator'

/** A relationship between agents */
export interface AgentRelationship {
  type: AgentRelationshipType
  agentId: AgentId
  metadata?: Record<string, unknown>
  _meta?: Meta
}

/** Lifecycle metadata for an agent */
export interface AgentLifecycle {
  createdAt?: Timestamp
  startedAt?: Timestamp
  stoppedAt?: Timestamp
  lastActiveAt?: Timestamp
  orphanedAt?: Timestamp
  exitCode?: number
  exitReason?: string
  _meta?: Meta
}

/** Who can see this agent */
export type AgentVisibility = 'public' | 'parent-only' | 'scope' | 'system'

/** Rule for which agents this agent can see */
export type AgentVisibilityRule =
  | 'all'
  | 'hierarchy'
  | 'scoped'
  | 'direct'
  | { include: AgentId[] }

/** Rule for which scopes this agent can see */
export type ScopeVisibilityRule = 'all' | 'member' | { include: ScopeId[] }

/** Rule for how much agent hierarchy structure this agent can see */
export type StructureVisibilityRule = 'full' | 'local' | 'none'

/** Rule for which agents this agent can send messages to */
export type AgentMessagingRule = 'all' | 'hierarchy' | 'scoped' | { include: AgentId[] }

/** Rule for which scopes this agent can send messages to */
export type ScopeMessagingRule = 'all' | 'member' | { include: ScopeId[] }

/** Rule for which agents this agent accepts messages from */
export type AgentAcceptanceRule = 'all' | 'hierarchy' | 'scoped' | { include: AgentId[] }

/** Rule for which clients this agent accepts messages from */
export type ClientAcceptanceRule = 'all' | 'none' | { include: ParticipantId[] }

/** Rule for which federated systems this agent accepts messages from */
export type SystemAcceptanceRule = 'all' | 'none' | { include: string[] }

/** Permission configuration for an agent */
export interface AgentPermissions {
  canSee?: {
    agents?: AgentVisibilityRule
    scopes?: ScopeVisibilityRule
    structure?: StructureVisibilityRule
  }
  canMessage?: {
    agents?: AgentMessagingRule
    scopes?: ScopeMessagingRule
  }
  acceptsFrom?: {
    agents?: AgentAcceptanceRule
    clients?: ClientAcceptanceRule
    systems?: SystemAcceptanceRule
  }
}

/** An agent in the multi-agent system */
export interface Agent {
  id: AgentId
  ownerId: ParticipantId | null
  name?: string
  description?: string
  parent?: AgentId
  children?: AgentId[]
  relationships?: AgentRelationship[]
  state: AgentState
  role?: string
  scopes?: ScopeId[]
  visibility?: AgentVisibility
  permissionOverrides?: Partial<AgentPermissions>
  lifecycle?: AgentLifecycle
  capabilities?: ParticipantCapabilities
  metadata?: Record<string, unknown>
  _meta?: Meta
}

// =============================================================================
// Addressing Types
// =============================================================================

/** Address a single agent directly */
export interface DirectAddress {
  agent: AgentId
}

/** Address multiple agents */
export interface MultiAddress {
  agents: AgentId[]
}

/** Address all agents in a scope */
export interface ScopeAddress {
  scope: ScopeId
}

/** Address agents by role, optionally within a scope */
export interface RoleAddress {
  role: string
  within?: ScopeId
}

/** Address relative to sender in hierarchy */
export interface HierarchicalAddress {
  parent?: true
  children?: true
  ancestors?: true
  descendants?: true
  siblings?: true
  depth?: number
}

/** Address all agents in the system */
export interface BroadcastAddress {
  broadcast: true
}

/** Address the system/router itself */
export interface SystemAddress {
  system: true
}

/** Address any participant by ID or category */
export interface ParticipantAddress {
  participant?: ParticipantId
  participants?: 'all' | 'agents' | 'clients'
}

/** Address an agent in a federated system */
export interface FederatedAddress {
  system: string
  agent: AgentId
}

/** Flexible addressing for any topology */
export type Address =
  | string
  | DirectAddress
  | MultiAddress
  | ScopeAddress
  | RoleAddress
  | HierarchicalAddress
  | BroadcastAddress
  | SystemAddress
  | ParticipantAddress
  | FederatedAddress

// =============================================================================
// Address Type Guards
// =============================================================================

/** Check if address is a direct agent address */
export function isDirectAddress(address: Address): address is DirectAddress {
  return typeof address === 'object' && 'agent' in address && !('system' in address)
}

/** Check if address is a multi-agent address */
export function isMultiAddress(address: Address): address is MultiAddress {
  return typeof address === 'object' && 'agents' in address
}

/** Check if address is a scope address */
export function isScopeAddress(address: Address): address is ScopeAddress {
  return typeof address === 'object' && 'scope' in address
}

/** Check if address is a role address */
export function isRoleAddress(address: Address): address is RoleAddress {
  return typeof address === 'object' && 'role' in address
}

/** Check if address is a hierarchical address */
export function isHierarchicalAddress(address: Address): address is HierarchicalAddress {
  return (
    typeof address === 'object' &&
    ('parent' in address ||
      'children' in address ||
      'ancestors' in address ||
      'descendants' in address ||
      'siblings' in address)
  )
}

/** Check if address is a broadcast address */
export function isBroadcastAddress(address: Address): address is BroadcastAddress {
  return typeof address === 'object' && 'broadcast' in address
}

/** Check if address is a system address */
export function isSystemAddress(address: Address): address is SystemAddress {
  return typeof address === 'object' && 'system' in address && address.system === true
}

/** Check if address is a participant address */
export function isParticipantAddress(address: Address): address is ParticipantAddress {
  return typeof address === 'object' && ('participant' in address || 'participants' in address)
}

/** Check if address is a federated address */
export function isFederatedAddress(address: Address): address is FederatedAddress {
  return typeof address === 'object' && 'system' in address && typeof address.system === 'string'
}

// =============================================================================
// Federation ID Utilities
// =============================================================================

/**
 * Parsed result of a federation-prefixed sender ID.
 *
 * When a message crosses a FederationGateway, the sender ID is prefixed
 * with the source system ID: "system-a:alice" instead of "alice".
 * This provides unambiguous cross-system identity.
 */
export interface ParsedFederatedId {
  /** The source system ID, if the ID is federation-prefixed */
  system?: string
  /** The agent ID (without system prefix) */
  agent: string
}

/**
 * Parse a potentially federation-prefixed sender ID.
 *
 * FederationGateway prefixes sender IDs with the source system to provide
 * unambiguous cross-system identity: "system-a:alice" instead of "alice".
 *
 * @param id - The sender ID, potentially prefixed with "system:"
 * @returns Parsed system and agent components
 *
 * @example
 * ```typescript
 * parseFederatedId("system-a:alice")  // { system: "system-a", agent: "alice" }
 * parseFederatedId("alice")           // { agent: "alice" }
 * ```
 */
export function parseFederatedId(id: string): ParsedFederatedId {
  const colonIndex = id.indexOf(':')
  if (colonIndex > 0 && colonIndex < id.length - 1) {
    return {
      system: id.slice(0, colonIndex),
      agent: id.slice(colonIndex + 1),
    }
  }
  return { agent: id }
}

// =============================================================================
// Message Types
// =============================================================================

/** Message priority */
export type MessagePriority = 'urgent' | 'high' | 'normal' | 'low'

/** Message delivery guarantees */
export type DeliverySemantics = 'fire-and-forget' | 'acknowledged' | 'guaranteed'

/** Relationship context for the message */
export type MessageRelationship = 'parent-to-child' | 'child-to-parent' | 'peer' | 'broadcast'

/** Metadata for a message */
export interface MessageMeta {
  timestamp?: Timestamp
  relationship?: MessageRelationship
  expectsResponse?: boolean
  correlationId?: CorrelationId
  isResult?: boolean
  priority?: MessagePriority
  delivery?: DeliverySemantics
  ttlMs?: number
  _meta?: Meta
}

/** A message in the multi-agent system */
export interface Message<T = unknown> {
  id: MessageId
  from: ParticipantId
  to: Address
  timestamp: Timestamp
  payload?: T
  meta?: MessageMeta
  _meta?: Meta
}

// =============================================================================
// Scope Types
// =============================================================================

/** Policy for joining a scope */
export type JoinPolicy = 'open' | 'invite' | 'role' | 'system'

/** Who can see the scope exists and its members */
export type ScopeVisibility = 'public' | 'members' | 'system'

/** Who can see messages sent to this scope */
export type MessageVisibility = 'public' | 'members' | 'system'

/** Who can send messages to this scope */
export type SendPolicy = 'members' | 'any'

/** A scope for grouping agents */
export interface Scope {
  id: ScopeId
  name?: string
  description?: string
  parent?: ScopeId
  joinPolicy?: JoinPolicy
  autoJoinRoles?: string[]
  visibility?: ScopeVisibility
  messageVisibility?: MessageVisibility
  sendPolicy?: SendPolicy
  persistent?: boolean
  autoDelete?: boolean
  metadata?: Record<string, unknown>
  _meta?: Meta
}

// =============================================================================
// Event Types
// =============================================================================

/** Event type constants */
export const EVENT_TYPES = {
  // Agent lifecycle events
  AGENT_REGISTERED: 'agent_registered',
  AGENT_UNREGISTERED: 'agent_unregistered',
  AGENT_STATE_CHANGED: 'agent_state_changed',
  AGENT_ORPHANED: 'agent_orphaned',

  // Participant lifecycle events
  PARTICIPANT_CONNECTED: 'participant_connected',
  PARTICIPANT_DISCONNECTED: 'participant_disconnected',

  // Message events
  MESSAGE_SENT: 'message_sent',
  MESSAGE_DELIVERED: 'message_delivered',
  MESSAGE_FAILED: 'message_failed',

  // Scope events
  SCOPE_CREATED: 'scope_created',
  SCOPE_DELETED: 'scope_deleted',
  SCOPE_MEMBER_JOINED: 'scope_member_joined',
  SCOPE_MEMBER_LEFT: 'scope_member_left',

  // Federation events
  FEDERATION_CONNECTED: 'federation_connected',
  FEDERATION_DISCONNECTED: 'federation_disconnected',

  // System events
  SYSTEM_ERROR: 'system_error',
} as const

/** Type of system event */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

/** Input for creating events */
export interface EventInput {
  type: EventType
  timestamp?: Timestamp
  source?: ParticipantId
  data?: Record<string, unknown>
  causedBy?: string[]
  _meta?: Meta
}

/** Wire event as sent to clients */
export interface Event {
  id: string
  type: EventType
  timestamp: Timestamp
  source?: ParticipantId
  data?: Record<string, unknown>
  causedBy?: string[]
  _meta?: Meta
}

/** Helper to create events with auto-generated id and timestamp */
export function createEvent(input: EventInput): Event {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: input.timestamp ?? Date.now(),
    type: input.type,
    source: input.source,
    data: input.data,
    causedBy: input.causedBy,
    _meta: input._meta,
  }
}

// =============================================================================
// Subscription Types
// =============================================================================

/** Filter for event subscriptions */
export interface SubscriptionFilter {
  agents?: AgentId[]
  roles?: string[]
  scopes?: ScopeId[]
  eventTypes?: EventType[]
  priorities?: MessagePriority[]
  correlationIds?: CorrelationId[]
  fromAgents?: AgentId[]
  fromRoles?: string[]
  metadataMatch?: Record<string, unknown>
  _meta?: Meta
}

/** Options for subscriptions */
export interface SubscriptionOptions {
  includeMessagePayloads?: boolean
  excludeOwnEvents?: boolean
}

/** An active event subscription */
export interface Subscription {
  id: SubscriptionId
  filter?: SubscriptionFilter
  options?: SubscriptionOptions
  createdAt?: Timestamp
  replayFrom?: Timestamp | string
  _meta?: Meta
}

// =============================================================================
// Session & Auth Types
// =============================================================================

export interface SessionInfo {
  id: SessionId
  createdAt: Timestamp
  lastActiveAt?: Timestamp
  closedAt?: Timestamp
}

export type AuthMethod = 'bearer' | 'api-key' | 'mtls' | 'none'

export interface AuthParams {
  method: AuthMethod
  token?: string
}

export interface FederationAuth {
  method: 'bearer' | 'api-key' | 'mtls'
  credentials?: string
}

// =============================================================================
// Disconnect & Connect Types
// =============================================================================

/** Policy for handling unexpected disconnection */
export interface DisconnectPolicy {
  agentBehavior: 'unregister' | 'orphan' | 'grace-period'
  gracePeriodMs?: number
  notifySubscribers?: boolean
}

/** Result from connect request */
export interface ConnectResponseResult {
  protocolVersion: ProtocolVersion
  sessionId: SessionId
  participantId: ParticipantId
  capabilities: ParticipantCapabilities
  systemInfo?: {
    name?: string
    version?: string
    metadata?: Record<string, unknown>
  }
  resumeToken?: string
  reclaimedAgents?: AgentId[]
}

/** Result from agents.list request */
export interface AgentsListResponseResult {
  agents: Agent[]
}

// =============================================================================
// Federation Types
// =============================================================================

/** Routing configuration for federation */
export interface FederationRoutingConfig {
  allowIncoming?: boolean
  allowOutgoing?: boolean
  routeAll?: boolean
  agentFilter?: AgentId[]
  scopeFilter?: ScopeId[]
  maxHops?: number
  trackPath?: boolean
  allowedSources?: string[]
}

/** Buffer configuration for federation during disconnections */
export interface FederationBufferConfig {
  enabled?: boolean
  maxSize?: number
  maxAgeMs?: number
  maxMessages?: number
  maxBytes?: number
  retentionMs?: number
  overflowStrategy?: 'drop-oldest' | 'drop-newest' | 'reject'
}

/** Metadata for a federated message */
export interface FederationMetadata {
  sourceSystem: string
  targetSystem: string
  hopCount: number
  maxHops?: number
  path?: string[]
  timestamp?: Timestamp
  originTimestamp?: Timestamp
  ttl?: number
  correlationId?: CorrelationId
}

/** Envelope for a federated message */
export interface FederationEnvelope<T = unknown> {
  payload: T
  federation: FederationMetadata
}

/** Event for gateway reconnection */
export interface GatewayReconnectionEvent {
  type?:
    | 'connected'
    | 'disconnected'
    | 'reconnecting'
    | 'reconnected'
    | 'failed'
    | 'reconnect_failed'
    | 'buffer_overflow'
  systemId: string
  timestamp?: Timestamp
  attempt?: number
  delayMs?: number
  bufferedCount?: number
}

// =============================================================================
// Stream Types (for MAP over agentic-mesh transports)
// =============================================================================

/**
 * A MAP protocol frame - either a request, response, or notification.
 */
export type MapFrame = MapRequestFrame | MapResponseFrame | MapNotificationFrame

export interface MapRequestFrame {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

export interface MapResponseFrame {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface MapNotificationFrame {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

// =============================================================================
// MAP Server Configuration
// =============================================================================

/**
 * Configuration for a MAP server running on a mesh peer.
 */
export interface MapServerConfig {
  /** Unique identifier for this peer/system */
  systemId: string

  /** Human-readable name for this system */
  systemName?: string

  /** System version */
  systemVersion?: string

  /** Default capabilities granted to connecting agents */
  defaultAgentCapabilities?: ParticipantCapabilities

  /** Default capabilities granted to connecting clients */
  defaultClientCapabilities?: ParticipantCapabilities

  /** Permission configuration for agents */
  permissionConfig?: MapPermissionConfig

  /** Federation configuration */
  federation?: {
    enabled?: boolean
    routing?: FederationRoutingConfig
    buffer?: FederationBufferConfig
  }

  /** Event retention for replay (milliseconds) */
  eventRetentionMs?: number

  /** Maximum events to retain */
  maxRetainedEvents?: number
}

/**
 * Permission configuration for the MAP server.
 */
export interface MapPermissionConfig {
  defaultPermissions?: AgentPermissions
  rolePermissions?: Record<string, AgentPermissions>
}

// =============================================================================
// Peer Connection Types
// =============================================================================

/**
 * State of a MAP connection.
 */
export type MapConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error'

/**
 * Configuration for a peer-to-peer MAP connection over agentic-mesh transport.
 */
export interface MapPeerConnectionConfig {
  localPeerId: string
  remotePeerId: string
  remoteEndpoint: PeerEndpoint
  transport: TransportAdapter
  connectionTimeout?: number
  reconnection?: {
    enabled?: boolean
    maxRetries?: number
    initialDelayMs?: number
    maxDelayMs?: number
    backoffMultiplier?: number
  }
}

/**
 * Events emitted by a MAP peer connection.
 */
export interface MapPeerConnectionEvents {
  'state:changed': (state: MapConnectionState, previousState: MapConnectionState) => void
  message: (message: Message) => void
  event: (event: Event) => void
  error: (error: Error) => void
  reconnecting: (attempt: number) => void
  reconnected: () => void
}

// =============================================================================
// Agent Connection Types
// =============================================================================

/**
 * Configuration for a local agent connection to the MAP server.
 */
export interface MapAgentConnectionConfig {
  agentId?: AgentId
  name?: string
  description?: string
  role?: string
  parent?: AgentId
  scopes?: ScopeId[]
  visibility?: 'public' | 'parent-only' | 'scope' | 'system'
  capabilities?: ParticipantCapabilities
  metadata?: Record<string, unknown>
  disconnectPolicy?: DisconnectPolicy
}

/**
 * Events emitted by an agent connection.
 */
export interface MapAgentConnectionEvents {
  registered: (agent: Agent) => void
  unregistered: (agent: Agent) => void
  'state:changed': (state: AgentState, previousState: AgentState) => void
  message: (message: Message) => void
  'scope:joined': (scope: Scope) => void
  'scope:left': (scope: Scope) => void
  error: (error: Error) => void
}

// =============================================================================
// Client Bridge Types
// =============================================================================

/**
 * Configuration for the client bridge that exposes MAP to external observers.
 */
export interface MapClientBridgeConfig {
  port?: number
  host?: string
  tls?: {
    cert: string
    key: string
    ca?: string
  }
  auth?: {
    required?: boolean
    apiKeys?: string[]
    jwt?: {
      secret: string
      issuer?: string
      audience?: string
    }
  }
  rateLimit?: {
    maxRequestsPerMinute?: number
    maxSubscriptionsPerClient?: number
  }
}

// =============================================================================
// Gateway Types
// =============================================================================

/**
 * Simplified configuration for `MeshPeer.federateWith()`.
 *
 * Provides a consumer-friendly subset of gateway options. Internally
 * mapped to `MapGatewayConfig` by MeshPeer.
 */
export interface FederateConfig {
  /** Override the local system ID (defaults to MeshPeer.peerId) */
  localSystemId?: string

  /** The remote system ID (typically matches remoteSystemId param) */
  remoteSystemId?: string

  /** Message buffering for offline peers */
  buffer?: {
    enabled: boolean
    maxMessages?: number   // Default: 1000
  }

  /** Routing safety */
  routing?: {
    maxHops?: number       // Default: 5
    trackPath?: boolean    // Default: true
  }
}

/**
 * Configuration for a federation gateway.
 */
export interface MapGatewayConfig {
  localSystemId: string
  remoteEndpoint: string
  remoteSystemId: string
  auth?: {
    method: 'bearer' | 'api-key' | 'mtls'
    credentials?: string
  }
  routing?: FederationRoutingConfig
  buffer?: FederationBufferConfig
  reconnection?: {
    enabled?: boolean
    maxRetries?: number
    initialDelayMs?: number
    maxDelayMs?: number
  }
}

// =============================================================================
// Registry Types
// =============================================================================

/**
 * Filter for listing agents.
 */
export interface AgentFilter {
  states?: AgentState[]
  roles?: string[]
  scopes?: ScopeId[]
  parent?: AgentId
  hasChildren?: boolean
  ownerId?: ParticipantId
}

/**
 * Filter for listing scopes.
 */
export interface ScopeFilter {
  parent?: ScopeId
  visibility?: ScopeVisibility
}

// =============================================================================
// Event Bus Types
// =============================================================================

/**
 * Subscription handle returned by the event bus.
 */
export interface EventSubscription {
  id: string
  filter?: SubscriptionFilter
  options?: SubscriptionOptions
  events(): AsyncIterable<Event>
  unsubscribe(): void
}

// =============================================================================
// Message Router Types
// =============================================================================

/**
 * Result of sending a message.
 */
export interface SendResult {
  messageId: string
  delivered: ParticipantId[]
  failed?: Array<{
    participantId: ParticipantId
    reason: string
  }>
}

/**
 * Resolved address - the actual targets for a message.
 */
export interface ResolvedAddress {
  localAgents: AgentId[]
  remotePeers: Array<{
    peerId: string
    agentIds: AgentId[]
  }>
  federatedSystems?: Array<{
    systemId: string
    agentIds: AgentId[]
  }>
}

// =============================================================================
// Mesh Peer Types
// =============================================================================

/**
 * Configuration for a mesh peer with MAP support.
 */
export interface MeshPeerConfig {
  peerId: string
  peerName?: string
  /**
   * When true, the peer runs in-process without binding a server port.
   * Transport is optional in embedded mode — the MAP server, agent registration,
   * and local message routing all work without a transport.
   * Transport can still be provided for P2P connectivity.
   */
  embedded?: boolean
  transport?: {
    type: 'nebula' | 'tailscale' | 'headscale'
    config: import('../transports/types').TransportConfig
  }
  map?: Omit<MapServerConfig, 'systemId'>
  clientBridge?: MapClientBridgeConfig
  peers?: PeerEndpoint[]
  auth?: {
    certPath?: string
    keyPath?: string
    groups?: string[]
  }
  /** Git transport configuration */
  git?: {
    /** Enable git transport (default: false) */
    enabled?: boolean
    /** HTTP port for git-remote-mesh helper (default: 3456) */
    httpPort?: number
    /** HTTP host (default: 127.0.0.1) */
    httpHost?: string
    /** Repository path (default: cwd) */
    repoPath?: string
    /** Git transport options */
    options?: import('../git/types').GitTransportConfig
  }
}

/**
 * Events emitted by a mesh peer.
 */
export interface MeshPeerEvents {
  started: () => void
  stopped: () => void
  'peer:connected': (peerId: string, endpoint: PeerEndpoint) => void
  'peer:disconnected': (peerId: string, reason?: string) => void
  'agent:registered': (agent: Agent) => void
  'agent:unregistered': (agent: Agent) => void
  'scope:created': (scope: Scope) => void
  'scope:deleted': (scope: Scope) => void
  'federation:connected': (systemId: string) => void
  'federation:disconnected': (systemId: string) => void
  error: (error: Error) => void
}
