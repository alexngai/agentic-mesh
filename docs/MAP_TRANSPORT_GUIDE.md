# Implementation Guide: Agentic-Mesh Transport for MAP SDK

This guide describes how to implement agentic-mesh as a transport option for the Multi-Agent Protocol (MAP) TypeScript SDK.

## Overview

**Goal:** Allow MAP SDK clients to connect over agentic-mesh encrypted tunnels (Nebula/Tailscale/Headscale).

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                 multi-agent-protocol/ts-sdk                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐                                               │
│  │ MAPClient   │  Standard MAP SDK client                      │
│  └──────┬──────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Transport Layer (pluggable)                 │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ WebSocketTransport │ StdioTransport │ AgenticMeshTransport │
│  │                    │                │      (NEW)           │
│  └─────────────────────────────────────────────────────────┘   │
│                                              │                  │
└──────────────────────────────────────────────┼──────────────────┘
                                               │
                                               ▼
                              ┌────────────────────────────┐
                              │ agentic-mesh TransportAdapter │
                              │ (Nebula/Tailscale tunnels)   │
                              └────────────────────────────┘
```

---

## Step 1: Create Transport Interface

**File:** `multi-agent-protocol/ts-sdk/src/transports/types.ts`

Define the base transport interface that all transports implement:

```typescript
import type { MAPFrame } from '../types'

/**
 * Transport interface for MAP protocol communication.
 */
export interface Transport {
  /** Connect to the remote endpoint */
  connect(): Promise<void>

  /** Disconnect from the remote endpoint */
  disconnect(): Promise<void>

  /** Send a frame to the remote endpoint */
  send(frame: MAPFrame): Promise<void>

  /** Async iterator for receiving frames */
  receive(): AsyncIterable<MAPFrame>

  /** Whether currently connected */
  readonly isConnected: boolean
}

/**
 * Base transport configuration.
 */
export interface TransportConfig {
  /** Connection timeout in milliseconds */
  timeout?: number
}
```

---

## Step 2: Create Agentic-Mesh Transport

**File:** `multi-agent-protocol/ts-sdk/src/transports/agentic-mesh.ts`

### Reusable Components from agentic-mesh

| Component | Location | Purpose |
|-----------|----------|---------|
| `TunnelStream` | [`src/map/stream/tunnel-stream.ts:90`](../src/map/stream/tunnel-stream.ts#L90) | NDJSON framing over transport |
| `createNdjsonFramer` | [`src/map/stream/tunnel-stream.ts:16`](../src/map/stream/tunnel-stream.ts#L16) | JSON encode/decode utilities |
| `TransportAdapter` | [`src/transports/types.ts`](../src/transports/types.ts) | Nebula/Tailscale abstraction |
| `MapFrame` | [`src/map/types.ts:685`](../src/map/types.ts#L685) | Request/Response/Notification types |

### Implementation

```typescript
import type { Transport, TransportConfig } from './types'
import type { MAPFrame } from '../types'

// Import from agentic-mesh
import { TunnelStream } from 'agentic-mesh/map/stream'
import type { TransportAdapter, PeerEndpoint } from 'agentic-mesh/transports'

/**
 * Configuration for agentic-mesh transport.
 */
export interface AgenticMeshTransportConfig extends TransportConfig {
  /** The agentic-mesh transport adapter (Nebula, Tailscale, Headscale) */
  transport: TransportAdapter

  /** Remote peer to connect to */
  peer: PeerEndpoint

  /** Local peer ID for identification */
  localPeerId: string
}

/**
 * MAP transport over agentic-mesh encrypted tunnels.
 */
export class AgenticMeshTransport implements Transport {
  private stream: TunnelStream | null = null
  private readonly config: AgenticMeshTransportConfig

  constructor(config: AgenticMeshTransportConfig) {
    this.config = config
  }

  get isConnected(): boolean {
    return this.stream?.isOpen ?? false
  }

  async connect(): Promise<void> {
    // Start underlying transport if needed
    if (!this.config.transport.isRunning) {
      await this.config.transport.start()
    }

    // Create tunnel stream over the mesh transport
    this.stream = new TunnelStream({
      transport: this.config.transport,
      peerId: this.config.peer.id,
      streamId: `map-${this.config.localPeerId}-${Date.now()}`,
    })

    await this.stream.open()
  }

  async disconnect(): Promise<void> {
    if (this.stream) {
      await this.stream.close()
      this.stream = null
    }
  }

  async send(frame: MAPFrame): Promise<void> {
    if (!this.stream?.isOpen) {
      throw new Error('Transport not connected')
    }
    await this.stream.write(frame)
  }

  async *receive(): AsyncIterable<MAPFrame> {
    if (!this.stream) return

    for await (const frame of this.stream) {
      yield frame
    }
  }
}

/**
 * Create an agentic-mesh transport.
 */
export function createAgenticMeshTransport(
  config: AgenticMeshTransportConfig
): AgenticMeshTransport {
  return new AgenticMeshTransport(config)
}
```

---

## Step 3: Export Transport Module

**File:** `multi-agent-protocol/ts-sdk/src/transports/index.ts`

```typescript
export * from './types'
export * from './agentic-mesh'

// Re-export other transports
export * from './websocket'
export * from './stdio'
```

---

## Step 4: Wire into MAP Client

**File:** `multi-agent-protocol/ts-sdk/src/client.ts`

Modify the MAP client to accept a transport:

```typescript
import type { Transport } from './transports'
import type {
  ConnectParams,
  ConnectResult,
  MAPFrame,
  MAPRequestFrame,
  MAPResponseFrame,
} from './types'

export class MAPClient {
  private readonly transport: Transport
  private readonly pendingRequests = new Map<
    string | number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >()
  private nextRequestId = 1

  constructor(transport: Transport) {
    this.transport = transport
  }

  async connect(params: ConnectParams): Promise<ConnectResult> {
    // Connect transport
    await this.transport.connect()

    // Start receiving frames in background
    this.startReceiving()

    // Send MAP connect request
    return this.request('map/connect', params)
  }

  async disconnect(): Promise<void> {
    await this.request('map/disconnect', {})
    await this.transport.disconnect()
  }

  /**
   * Send a JSON-RPC request and wait for response.
   */
  async request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextRequestId++

    const frame: MAPRequestFrame = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as any, reject })
      this.transport.send(frame).catch(reject)
    })
  }

  /**
   * Start receiving frames from transport.
   */
  private async startReceiving(): Promise<void> {
    try {
      for await (const frame of this.transport.receive()) {
        this.handleFrame(frame)
      }
    } catch (error) {
      // Handle disconnect
      console.error('Transport error:', error)
    }
  }

  /**
   * Handle incoming frame.
   */
  private handleFrame(frame: MAPFrame): void {
    // Response frame
    if ('id' in frame && ('result' in frame || 'error' in frame)) {
      const pending = this.pendingRequests.get(frame.id)
      if (pending) {
        this.pendingRequests.delete(frame.id)
        if ('error' in frame) {
          pending.reject(new Error(frame.error.message))
        } else {
          pending.resolve(frame.result)
        }
      }
      return
    }

    // Notification frame
    if ('method' in frame && !('id' in frame)) {
      this.handleNotification(frame)
    }
  }

  private handleNotification(frame: MAPNotificationFrame): void {
    // Handle events, messages, etc.
    // Emit to subscribers
  }
}
```

---

## Step 5: Usage Example

```typescript
import { MAPClient } from '@anthropic/multi-agent-protocol'
import { AgenticMeshTransport } from '@anthropic/multi-agent-protocol/transports/agentic-mesh'
import { createNebulaTransport } from 'agentic-mesh'

async function main() {
  // 1. Create the encrypted mesh transport
  const nebulaTransport = createNebulaTransport({
    configPath: '/etc/nebula/config.yml',
    certPath: '/etc/nebula/host.crt',
    keyPath: '/etc/nebula/host.key',
  })

  // 2. Create MAP transport wrapper
  const transport = new AgenticMeshTransport({
    transport: nebulaTransport,
    peer: {
      id: 'map-server',
      nebulaIp: '10.0.0.1',
      port: 4242
    },
    localPeerId: 'my-client',
  })

  // 3. Create MAP client with transport
  const client = new MAPClient(transport)

  // 4. Connect using standard MAP protocol
  const session = await client.connect({
    participantType: 'client',
    name: 'My Dashboard',
    capabilities: {
      observation: { canObserve: true, canQuery: true },
    },
  })

  console.log('Connected:', session.sessionId)

  // 5. Use MAP SDK normally
  const agents = await client.request('map/agents.list', {})
  console.log('Agents:', agents)

  // 6. Subscribe to events
  const subscription = await client.request('map/subscribe', {
    filter: { eventTypes: ['agent_registered', 'agent_state_changed'] },
  })

  // 7. Disconnect when done
  await client.disconnect()
}

main().catch(console.error)
```

---

## Key Code Pointers

### agentic-mesh Source Files

| What | File | Line |
|------|------|------|
| NDJSON framing | [`src/map/stream/tunnel-stream.ts`](../src/map/stream/tunnel-stream.ts) | 16-67 |
| TunnelStream class | [`src/map/stream/tunnel-stream.ts`](../src/map/stream/tunnel-stream.ts) | 90-200 |
| MapFrame types | [`src/map/types.ts`](../src/map/types.ts) | 682-702 |
| JSON-RPC handling | [`src/map/connection/base.ts`](../src/map/connection/base.ts) | 1-150 |
| TransportAdapter interface | [`src/transports/types.ts`](../src/transports/types.ts) | 1-50 |
| Nebula transport | [`src/transports/nebula-transport.ts`](../src/transports/nebula-transport.ts) | - |
| Tailscale transport | [`src/transports/tailscale-transport.ts`](../src/transports/tailscale-transport.ts) | - |
| PeerConnection (reference) | [`src/map/connection/peer.ts`](../src/map/connection/peer.ts) | - |

### Existing Exports

agentic-mesh already exports what's needed:

```typescript
// src/map/index.ts
export * from './stream'      // TunnelStream, createNdjsonFramer
export * from './types'       // MapFrame, all MAP types
export * from './connection'  // BaseConnection

// src/index.ts
export * from './map'         // All MAP exports
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `ts-sdk/src/transports/types.ts` | Transport interface definition |
| `ts-sdk/src/transports/agentic-mesh.ts` | Agentic-mesh transport implementation |
| `ts-sdk/src/transports/index.ts` | Export all transports |

## Files to Modify

| File | Change |
|------|--------|
| `ts-sdk/src/client.ts` | Accept transport in constructor |
| `ts-sdk/package.json` | Add `agentic-mesh` as optional peer dependency |

---

## Testing

Create tests for the transport:

```typescript
// ts-sdk/tests/transports/agentic-mesh.test.ts

import { describe, it, expect, vi } from 'vitest'
import { AgenticMeshTransport } from '../../src/transports/agentic-mesh'

describe('AgenticMeshTransport', () => {
  it('should connect via tunnel stream', async () => {
    const mockTransport = {
      isRunning: false,
      start: vi.fn(),
      connect: vi.fn(),
    }

    const transport = new AgenticMeshTransport({
      transport: mockTransport as any,
      peer: { id: 'test-peer', nebulaIp: '10.0.0.1', port: 4242 },
      localPeerId: 'local',
    })

    await transport.connect()
    expect(mockTransport.start).toHaveBeenCalled()
  })

  it('should send frames via stream', async () => {
    // Test frame sending
  })

  it('should receive frames via async iterator', async () => {
    // Test frame receiving
  })
})
```

---

## Summary

1. **Define transport interface** - Standard interface for all MAP transports
2. **Implement AgenticMeshTransport** - Wraps TunnelStream for MAP frames
3. **Export from ts-sdk** - Make transport available to SDK users
4. **Wire into MAPClient** - Accept transport in constructor
5. **Use normally** - Standard MAP SDK API over encrypted mesh tunnels
