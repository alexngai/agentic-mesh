/**
 * MAP Protocol Types for agentic-mesh
 *
 * Re-exports core MAP types from the multi-agent-protocol SDK and adds
 * agentic-mesh specific extensions for transport integration.
 */

// Re-export all MAP types from the protocol SDK
export * from '../../multi-agent-protocol/ts-sdk/src/types'

import type { TransportAdapter, PeerEndpoint } from '../transports/types'
import type {
  ParticipantId,
  AgentId,
  ScopeId,
  SessionId,
  ParticipantCapabilities,
  Agent,
  Scope,
  Event,
  Message,
  Address,
  SubscriptionFilter,
  SubscriptionOptions,
  DisconnectPolicy,
  FederationRoutingConfig,
  FederationBufferConfig,
} from '../../multi-agent-protocol/ts-sdk/src/types'

// =============================================================================
// Stream Types (for MAP over agentic-mesh transports)
// =============================================================================

/**
 * A MAP-compatible stream for sending/receiving JSON-RPC messages.
 * This wraps agentic-mesh transports to provide MAP protocol streaming.
 */
export interface MapStream {
  /** Write a message to the stream */
  write(message: MapFrame): Promise<void>

  /** Read messages from the stream */
  read(): AsyncIterable<MapFrame>

  /** Close the stream */
  close(): Promise<void>

  /** Whether the stream is open */
  readonly isOpen: boolean

  /** Stream metadata */
  readonly metadata?: Record<string, unknown>
}

/**
 * A MAP protocol frame - either a request, response, or notification.
 */
export type MapFrame =
  | MapRequestFrame
  | MapResponseFrame
  | MapNotificationFrame

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
    /** Enable federation support */
    enabled?: boolean
    /** Routing configuration */
    routing?: FederationRoutingConfig
    /** Buffer configuration for disconnections */
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
  /** Default permissions for agents without a role */
  defaultPermissions?: import('../../multi-agent-protocol/ts-sdk/src/types').AgentPermissions

  /** Role-based permission templates */
  rolePermissions?: Record<string, import('../../multi-agent-protocol/ts-sdk/src/types').AgentPermissions>
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
  /** Local peer ID */
  localPeerId: string

  /** Remote peer ID */
  remotePeerId: string

  /** Remote peer endpoint (for reconnection) */
  remoteEndpoint: PeerEndpoint

  /** Underlying transport adapter */
  transport: TransportAdapter

  /** Connection timeout in milliseconds */
  connectionTimeout?: number

  /** Automatic reconnection settings */
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
  'message': (message: Message) => void
  'event': (event: Event) => void
  'error': (error: Error) => void
  'reconnecting': (attempt: number) => void
  'reconnected': () => void
}

// =============================================================================
// Agent Connection Types
// =============================================================================

/**
 * Configuration for a local agent connection to the MAP server.
 */
export interface MapAgentConnectionConfig {
  /** Agent ID (generated if not provided) */
  agentId?: AgentId

  /** Agent name */
  name?: string

  /** Agent description */
  description?: string

  /** Agent role (affects permissions) */
  role?: string

  /** Parent agent ID (for hierarchical agents) */
  parent?: AgentId

  /** Initial scopes to join */
  scopes?: ScopeId[]

  /** Agent visibility */
  visibility?: 'public' | 'parent-only' | 'scope' | 'system'

  /** Agent capabilities */
  capabilities?: ParticipantCapabilities

  /** Custom metadata */
  metadata?: Record<string, unknown>

  /** Disconnect policy */
  disconnectPolicy?: DisconnectPolicy
}

/**
 * Events emitted by an agent connection.
 */
export interface MapAgentConnectionEvents {
  'registered': (agent: Agent) => void
  'unregistered': (agent: Agent) => void
  'state:changed': (state: import('../../multi-agent-protocol/ts-sdk/src/types').AgentState, previousState: import('../../multi-agent-protocol/ts-sdk/src/types').AgentState) => void
  'message': (message: Message) => void
  'scope:joined': (scope: Scope) => void
  'scope:left': (scope: Scope) => void
  'error': (error: Error) => void
}

// =============================================================================
// Client Bridge Types
// =============================================================================

/**
 * Configuration for the client bridge that exposes MAP to external observers.
 */
export interface MapClientBridgeConfig {
  /** Port for WebSocket server (0 for auto) */
  port?: number

  /** Host to bind to */
  host?: string

  /** Enable TLS */
  tls?: {
    cert: string
    key: string
    ca?: string
  }

  /** Authentication configuration */
  auth?: {
    /** Require authentication */
    required?: boolean
    /** Valid API keys */
    apiKeys?: string[]
    /** JWT verification settings */
    jwt?: {
      secret: string
      issuer?: string
      audience?: string
    }
  }

  /** Rate limiting */
  rateLimit?: {
    /** Maximum requests per minute */
    maxRequestsPerMinute?: number
    /** Maximum subscriptions per client */
    maxSubscriptionsPerClient?: number
  }
}

// =============================================================================
// Gateway Types
// =============================================================================

/**
 * Configuration for a federation gateway.
 */
export interface MapGatewayConfig {
  /** Local system ID */
  localSystemId: string

  /** Remote system endpoint */
  remoteEndpoint: string

  /** Remote system ID */
  remoteSystemId: string

  /** Authentication */
  auth?: {
    method: 'bearer' | 'api-key' | 'mtls'
    credentials?: string
  }

  /** Routing configuration */
  routing?: FederationRoutingConfig

  /** Buffer configuration */
  buffer?: FederationBufferConfig

  /** Reconnection settings */
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
  states?: import('../../multi-agent-protocol/ts-sdk/src/types').AgentState[]
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
  visibility?: import('../../multi-agent-protocol/ts-sdk/src/types').ScopeVisibility
}

// =============================================================================
// Event Bus Types
// =============================================================================

/**
 * Subscription handle returned by the event bus.
 */
export interface EventSubscription {
  /** Subscription ID */
  id: string

  /** Subscription filter */
  filter?: SubscriptionFilter

  /** Subscription options */
  options?: SubscriptionOptions

  /** Async iterator for events */
  events(): AsyncIterable<Event>

  /** Unsubscribe */
  unsubscribe(): void
}

// =============================================================================
// Message Router Types
// =============================================================================

/**
 * Result of sending a message.
 */
export interface SendResult {
  /** Message ID */
  messageId: string

  /** Participants that received the message */
  delivered: ParticipantId[]

  /** Participants that failed to receive */
  failed?: Array<{
    participantId: ParticipantId
    reason: string
  }>
}

/**
 * Resolved address - the actual targets for a message.
 */
export interface ResolvedAddress {
  /** Local agents to deliver to */
  localAgents: AgentId[]

  /** Remote peers to forward to */
  remotePeers: Array<{
    peerId: string
    agentIds: AgentId[]
  }>

  /** Federated systems to route to */
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
  /** Peer ID */
  peerId: string

  /** Peer name */
  peerName?: string

  /** Transport configuration */
  transport: {
    type: 'nebula' | 'tailscale' | 'headscale'
    config: import('../transports/types').TransportConfig
  }

  /** MAP server configuration */
  map?: Omit<MapServerConfig, 'systemId'>

  /** Client bridge configuration (for external access) */
  clientBridge?: MapClientBridgeConfig

  /** Initial peers to connect to */
  peers?: PeerEndpoint[]

  /** Certificate/authentication */
  auth?: {
    /** Path to certificate */
    certPath?: string
    /** Path to private key */
    keyPath?: string
    /** Groups from certificate */
    groups?: string[]
  }
}

/**
 * Events emitted by a mesh peer.
 */
export interface MeshPeerEvents {
  'started': () => void
  'stopped': () => void
  'peer:connected': (peerId: string, endpoint: PeerEndpoint) => void
  'peer:disconnected': (peerId: string, reason?: string) => void
  'agent:registered': (agent: Agent) => void
  'agent:unregistered': (agent: Agent) => void
  'scope:created': (scope: Scope) => void
  'scope:deleted': (scope: Scope) => void
  'federation:connected': (systemId: string) => void
  'federation:disconnected': (systemId: string) => void
  'error': (error: Error) => void
}
