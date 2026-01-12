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
