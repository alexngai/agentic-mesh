/**
 * MAP Protocol Module for agentic-mesh
 *
 * Full Multi-Agent Protocol (MAP) implementation over agentic-mesh transports.
 */

// Types
export * from './types'

// Stream adapters
export * from './stream'

// Connections
export * from './connection'

// Server components
export * from './server'

// Built-in agents
export * from './agents'

// Client bridge (external WebSocket access)
export * from './bridge'

// Federation (cross-mesh communication)
export * from './federation'

// Main entry point
export * from './mesh-peer'
