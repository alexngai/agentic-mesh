// ACP message types for mesh transport
// Implements: s-4hjr

// =============================================================================
// Core ACP Types (from ACP specification)
// =============================================================================

/**
 * ACP JSON-RPC request
 */
export interface AcpRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

/**
 * ACP JSON-RPC response
 */
export interface AcpResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: AcpError
}

/**
 * ACP JSON-RPC notification (no id, no response expected)
 */
export interface AcpNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/**
 * ACP error object
 */
export interface AcpError {
  code: number
  message: string
  data?: unknown
}

/**
 * Union of all ACP message types
 */
export type AcpMessage = AcpRequest | AcpResponse | AcpNotification

// =============================================================================
// Mesh Envelope Types
// =============================================================================

/**
 * Envelope for ACP messages sent over mesh
 */
export interface AcpMeshEnvelope {
  type: 'acp:message'
  message: AcpMessage
  /** Target groups for filtered broadcast (optional) */
  targetGroups?: string[]
}

/**
 * Broadcast target options
 */
export type BroadcastTarget =
  | { kind: 'all' }
  | { kind: 'group'; groups: string[] }

// =============================================================================
// Adapter Configuration
// =============================================================================

/**
 * Configuration for AcpMeshAdapter
 */
export interface AcpMeshAdapterConfig {
  /** Channel name for ACP messages (default: 'acp') */
  channel?: string
  /** Default timeout for requests in ms (default: 30000) */
  timeout?: number
  /** Allow access from any group (default: false - require shared group) */
  allowAllGroups?: boolean
}

// =============================================================================
// Session Observation Types (Phase 3)
// =============================================================================

/**
 * Session metadata returned by list operations
 */
export interface SessionInfo {
  sessionId: string
  mode: string
  createdAt: string // ISO 8601
  active: boolean
  /** Optional: current activity description */
  activity?: string
}

/**
 * Request to observe a session on a remote peer
 */
export interface SessionObserveRequest extends AcpRequest {
  method: 'session/observe'
  params: {
    sessionId: string
  }
}

/**
 * Response to session/observe request
 */
export interface SessionObserveResponse extends AcpResponse {
  result?: {
    success: boolean
    /** Error message if not successful */
    error?: string
  }
}

/**
 * Request to stop observing a session
 */
export interface SessionUnobserveRequest extends AcpRequest {
  method: 'session/unobserve'
  params: {
    sessionId: string
  }
}

/**
 * Request to list sessions on a peer
 */
export interface SessionListRequest extends AcpRequest {
  method: 'session/list'
  params: {
    /** Include inactive/ended sessions (default: false) */
    includeInactive?: boolean
  }
}

/**
 * Response with session list
 */
export interface SessionListResponse extends AcpResponse {
  result?: {
    sessions: SessionInfo[]
  }
}

/**
 * Notification when a session ends
 */
export interface SessionEndedNotification extends AcpNotification {
  method: 'session/ended'
  params: {
    sessionId: string
    reason: 'completed' | 'cancelled' | 'error' | 'timeout'
  }
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a message is an ACP request
 */
export function isAcpRequest(message: AcpMessage): message is AcpRequest {
  return 'id' in message && 'method' in message
}

/**
 * Check if a message is an ACP response
 */
export function isAcpResponse(message: AcpMessage): message is AcpResponse {
  return 'id' in message && !('method' in message)
}

/**
 * Check if a message is an ACP notification
 */
export function isAcpNotification(message: AcpMessage): message is AcpNotification {
  return 'method' in message && !('id' in message)
}

// =============================================================================
// Session Observation Type Guards (Phase 3)
// =============================================================================

/**
 * Check if a message is a session/observe request
 */
export function isSessionObserveRequest(message: AcpMessage): message is SessionObserveRequest {
  return isAcpRequest(message) && message.method === 'session/observe'
}

/**
 * Check if a message is a session/unobserve request
 */
export function isSessionUnobserveRequest(message: AcpMessage): message is SessionUnobserveRequest {
  return isAcpRequest(message) && message.method === 'session/unobserve'
}

/**
 * Check if a message is a session/list request
 */
export function isSessionListRequest(message: AcpMessage): message is SessionListRequest {
  return isAcpRequest(message) && message.method === 'session/list'
}

/**
 * Check if a message is a session/ended notification
 */
export function isSessionEndedNotification(message: AcpMessage): message is SessionEndedNotification {
  return isAcpNotification(message) && message.method === 'session/ended'
}
