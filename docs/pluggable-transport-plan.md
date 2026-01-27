# Pluggable Transport Layer Implementation Plan

This document outlines the implementation plan for adding pluggable transport support to agentic-mesh, enabling Nebula, Tailscale/Headscale, and future transports.

## Current State Analysis

### What's Already Transport-Agnostic (Good)

| Component | Why It Works |
|-----------|--------------|
| `MeshContext` interface | Defines peer/hub operations without transport details |
| `SyncProvider` abstract class | Uses `MeshContext`, not concrete mesh |
| `WireMessage` format | Transport-agnostic serialization |
| `OfflineQueue` | Generic message queuing |
| Serialization layer | Supports JSON/MessagePack negotiation |
| EventEmitter patterns | Loose coupling via events |

### What's Tightly Coupled (Problems)

| Component | Issue |
|-----------|-------|
| `MessageChannel` constructor | Takes `NebulaMesh` instead of interface |
| `PeerInfo.nebulaIp` | Transport-specific field in core type |
| `PeerConfig.nebulaIp` | Transport-specific in config |
| `NebulaMeshConfig` | Entire config is Nebula-specific |
| `NebulaMesh._sendToPeer()` etc. | Internal methods used by MessageChannel |
| Hub election | Assumes mesh connectivity model |
| Health monitoring | Uses TCP ping/pong |

### Methods MessageChannel Needs from Mesh

```typescript
// Currently called on NebulaMesh directly:
mesh._sendToPeer(peerId, channelName, message)   // Point-to-point
mesh._broadcast(channelName, message)            // Broadcast
mesh._sendRpc(peerId, channelName, message, type, requestId)  // RPC
mesh._getPeerId()                                // Local peer ID
mesh.on('peer:joined', handler)                  // Events
mesh.off('peer:joined', handler)
```

---

## Proposed Architecture

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Application Layer                          │
│         YjsSyncProvider  │  CrSqliteSyncProvider                │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                      MessageChannel                              │
│              (Uses MeshContext interface)                        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                   MeshContext Interface                          │
│   (Extended with createChannel + transport operations)           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                         Mesh Class                               │
│   (Orchestrates transport, hub election, health, discovery)      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                  TransportAdapter Interface                      │
│          (Abstract transport operations)                         │
└──────────┬──────────────────┼───────────────────┬───────────────┘
           │                  │                   │
    ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐
    │   Nebula    │    │  Tailscale  │    │  Headscale  │
    │  Transport  │    │  Transport  │    │  Transport  │
    └─────────────┘    └─────────────┘    └─────────────┘
```

---

## Interface Definitions

### 1. TransportAdapter Interface (New)

```typescript
// src/transports/types.ts

import { EventEmitter } from 'events';

/**
 * Transport-agnostic peer endpoint.
 * Each transport defines how to reach a peer.
 */
export interface PeerEndpoint {
  /** Peer identifier (transport-agnostic) */
  peerId: string;
  /** Transport-specific address (IP, URL, etc.) */
  address: string;
  /** Optional port (for TCP-based transports) */
  port?: number;
  /** Additional transport-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Connection state for a peer.
 */
export interface PeerConnection {
  peerId: string;
  connected: boolean;
  lastActivity: Date;
  /** Transport-specific connection handle */
  handle?: unknown;
}

/**
 * Transport adapter events.
 */
export interface TransportEvents {
  'peer:connected': (peerId: string) => void;
  'peer:disconnected': (peerId: string, reason?: string) => void;
  'message': (peerId: string, data: Uint8Array) => void;
  'error': (error: Error) => void;
}

/**
 * Abstract transport adapter interface.
 * Implementations provide the actual network connectivity.
 */
export interface TransportAdapter extends EventEmitter {
  /** Transport type identifier */
  readonly type: string;

  /** Whether the transport is currently active */
  readonly active: boolean;

  // ========== Lifecycle ==========

  /**
   * Start the transport (begin listening/connecting).
   */
  start(): Promise<void>;

  /**
   * Stop the transport (close all connections).
   */
  stop(): Promise<void>;

  // ========== Connection Management ==========

  /**
   * Connect to a specific peer.
   * @param endpoint Peer endpoint information
   * @returns true if connection established or already connected
   */
  connect(endpoint: PeerEndpoint): Promise<boolean>;

  /**
   * Disconnect from a specific peer.
   */
  disconnect(peerId: string): Promise<void>;

  /**
   * Get all currently connected peer IDs.
   */
  getConnectedPeers(): string[];

  /**
   * Check if a peer is connected.
   */
  isConnected(peerId: string): boolean;

  // ========== Messaging ==========

  /**
   * Send data to a specific peer.
   * @param peerId Target peer
   * @param data Serialized message data
   * @returns true if sent successfully
   */
  send(peerId: string, data: Uint8Array): boolean;

  /**
   * Send data to all connected peers.
   * @param data Serialized message data
   */
  broadcast(data: Uint8Array): void;

  // ========== Identity ==========

  /**
   * Get the local peer's endpoint info.
   */
  getLocalEndpoint(): PeerEndpoint;
}
```

### 2. Extended MeshContext Interface

```typescript
// src/types/index.ts (updated)

import { MessageChannel } from '../channel/message-channel';

export interface MeshContext {
  // ========== Existing (unchanged) ==========
  getActiveHub(): PeerInfo | null;
  isHub(): boolean;
  getPeers(): PeerInfo[];
  getSelf(): PeerInfo;

  // ========== Namespace Registry (optional feature) ==========
  registerNamespace?(namespace: string): Promise<void>;
  unregisterNamespace?(namespace: string): Promise<void>;
  getActiveNamespaces?(): Map<string, string[]>;

  // ========== NEW: Channel Factory ==========
  createChannel<T>(name: string, config?: MessageChannelConfig): MessageChannel<T>;

  // ========== NEW: Transport Operations ==========
  /** @internal Send to specific peer */
  _sendToPeer(peerId: string, channel: string, message: unknown): boolean;
  /** @internal Broadcast to all peers */
  _broadcast(channel: string, message: unknown): void;
  /** @internal Send RPC message */
  _sendRpc(
    peerId: string,
    channel: string,
    message: unknown,
    type: 'request' | 'response',
    requestId: string
  ): boolean;
  /** @internal Get local peer ID */
  _getPeerId(): string;

  // ========== Events ==========
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  off(event: string | symbol, listener: (...args: unknown[]) => void): this;
}
```

### 3. Updated PeerInfo (Transport-Agnostic)

```typescript
// src/types/index.ts (updated)

export interface PeerInfo {
  id: string;
  name?: string;
  status: PeerStatus;
  lastSeen: Date;
  groups: string[];
  activeNamespaces: string[];
  isHub: boolean;
  hubRole?: HubRole;
  hubPriority?: number;

  // NEW: Transport-agnostic endpoint
  // Replaces nebulaIp + port
  endpoint?: PeerEndpoint;
}

// For backward compatibility during migration
export interface PeerInfoLegacy extends PeerInfo {
  /** @deprecated Use endpoint.address instead */
  nebulaIp: string;
  /** @deprecated Use endpoint.port instead */
  port?: number;
}
```

### 4. Transport-Specific Configurations

```typescript
// src/transports/nebula/types.ts

export interface NebulaTransportConfig {
  type: 'nebula';
  /** Nebula tunnel IP address */
  nebulaIp: string;
  /** Port for mesh communication (default: 7946) */
  port?: number;
  /** Path to Nebula config file (for auto-discovery) */
  configPath?: string;
  /** Path to nebula-cert binary */
  nebulaCertPath?: string;
}

// src/transports/tailscale/types.ts

export interface TailscaleTransportConfig {
  type: 'tailscale';
  /** Tailscale auth key (for new nodes) */
  authKey?: string;
  /** Hostname to register with */
  hostname?: string;
  /** Control server URL (for Headscale) */
  controlUrl?: string;
  /** State directory */
  stateDir?: string;
  /** Port for mesh communication (default: 7946) */
  port?: number;
}

export interface HeadscaleTransportConfig {
  type: 'headscale';
  /** Headscale server URL */
  serverUrl: string;
  /** API key for server operations */
  apiKey?: string;
  /** Pre-auth key for node registration */
  preAuthKey?: string;
  /** Hostname to register with */
  hostname?: string;
  /** Port for mesh communication (default: 7946) */
  port?: number;
}

// src/transports/types.ts

export type TransportConfig =
  | NebulaTransportConfig
  | TailscaleTransportConfig
  | HeadscaleTransportConfig;
```

### 5. Unified Mesh Configuration

```typescript
// src/types/index.ts (new)

export interface MeshConfig {
  /** Unique peer identifier */
  peerId: string;
  /** Human-readable peer name */
  peerName?: string;

  /** Transport configuration */
  transport: TransportConfig;

  /** Initial peer list (transport-agnostic) */
  peers?: Array<{
    id: string;
    name?: string;
    endpoint?: PeerEndpoint;
  }>;

  /** Groups/tags for this peer */
  groups?: string[];

  /** Hub election configuration */
  hub?: HubConfig;

  /** Connection timeout (ms) */
  connectionTimeout?: number;

  /** Health check interval (ms) */
  healthCheckInterval?: number;

  /** Serialization format */
  serialization?: 'json' | 'binary' | 'auto';

  /** Enable compression for binary format */
  compressionEnabled?: boolean;
}
```

---

## Implementation Phases

### Phase 1: Extract Transport Interface (Non-Breaking)

**Goal**: Create abstraction layer without breaking existing code.

**Tasks**:

1. **Create transport types** (`src/transports/types.ts`)
   - `TransportAdapter` interface
   - `PeerEndpoint` type
   - `TransportConfig` union type

2. **Create NebulaTransport adapter** (`src/transports/nebula/transport.ts`)
   - Extract socket/connection logic from `NebulaMesh`
   - Implement `TransportAdapter` interface
   - Keep same TCP behavior

3. **Add endpoint field to PeerInfo**
   - Add `endpoint?: PeerEndpoint` alongside existing `nebulaIp`
   - Populate both during migration period

4. **Add `createChannel` to MeshContext**
   - Already exists on `NebulaMesh`, just add to interface

5. **Update MessageChannel**
   - Change constructor from `NebulaMesh` to `MeshContext`
   - No behavior change needed

**Estimated effort**: 3-4 days

**Files changed**:
- `src/types/index.ts` (add types)
- `src/transports/` (new directory)
- `src/channel/message-channel.ts` (type change)
- `src/mesh/nebula-mesh.ts` (extract transport)

### Phase 2: Refactor NebulaMesh to Use Transport

**Goal**: NebulaMesh delegates to NebulaTransport.

**Tasks**:

1. **Inject transport into NebulaMesh**
   ```typescript
   class NebulaMesh {
     constructor(config: MeshConfig, transport?: TransportAdapter) {
       this.transport = transport ?? createTransport(config.transport);
     }
   }
   ```

2. **Route send/receive through transport**
   - `_sendToPeer()` → `transport.send()`
   - `_broadcast()` → `transport.broadcast()`
   - Listen to `transport.on('message')` for incoming

3. **Keep backward-compatible constructors**
   - `NebulaMesh.fromNebulaConfig()` still works
   - Old `NebulaMeshConfig` maps to new `MeshConfig`

4. **Update peer discovery**
   - `PeerDiscovery` uses transport for connectivity
   - Works with any transport that supports connect/disconnect

**Estimated effort**: 3-4 days

**Files changed**:
- `src/mesh/nebula-mesh.ts` (major refactor)
- `src/mesh/peer-discovery.ts` (minor changes)
- `src/transports/nebula/transport.ts` (complete implementation)

### Phase 3: Implement TailscaleTransport

**Goal**: Add Tailscale as alternative transport.

**Tasks**:

1. **Create TailscaleTransport** (`src/transports/tailscale/transport.ts`)
   - Use `tailscale` CLI for status/connect
   - TCP over Tailscale IPs (similar to Nebula)
   - Handle auth key registration

2. **Create Tailscale API client** (`src/transports/tailscale/api-client.ts`)
   - REST calls to `api.tailscale.com`
   - Device listing, auth key management
   - ACL policy queries

3. **Implement peer discovery for Tailscale**
   - Query Tailscale for peer list
   - Map Tailscale devices to `PeerEndpoint`

4. **Add integration tests**
   - Mock Tailscale CLI/API for unit tests
   - Manual integration test guide

**Estimated effort**: 4-5 days

**New files**:
- `src/transports/tailscale/transport.ts`
- `src/transports/tailscale/api-client.ts`
- `src/transports/tailscale/discovery.ts`
- `src/transports/tailscale/types.ts`
- `tests/unit/tailscale-transport.test.ts`

### Phase 4: Implement HeadscaleTransport

**Goal**: Add Headscale (self-hosted) as transport option.

**Tasks**:

1. **Create HeadscaleTransport** (extends TailscaleTransport)
   - Override control URL to point to Headscale
   - Use Headscale gRPC/REST API for management

2. **Create Headscale API client**
   - REST calls to `/api/v1/*`
   - User/node/preauth key management
   - Policy queries

3. **Handle DERP configuration**
   - Self-hosted DERP servers
   - Custom DERP map

**Estimated effort**: 2-3 days

**New files**:
- `src/transports/headscale/transport.ts`
- `src/transports/headscale/api-client.ts`
- `tests/unit/headscale-transport.test.ts`

### Phase 5: Optional Enhancements ✅ COMPLETED

**Goal**: Make transport-specific features pluggable.

**Tasks**:

1. **Make hub election optional** ✅
   - Added `features.hubElection` configuration flag
   - When disabled, no hub is elected and hub-specific features are skipped
   - `getActiveHub()` returns null, `isHub()` returns false

2. **Make health monitoring pluggable** ✅
   - Created `HealthMonitorAdapter` interface
   - `HealthMonitor`: Default TCP ping/pong implementation
   - `NoopHealthMonitor`: Disabled health monitoring (all peers always healthy)
   - `TailscaleHealthMonitor`: Uses Tailscale CLI for peer status
   - Configure via `features.healthMonitoring: true | false | 'transport'`

3. **Make namespace registry optional** ✅
   - Added `features.namespaceRegistry` configuration flag
   - When disabled, namespace registration messages are not sent/processed
   - Local namespace tracking still works

4. **Additional optional features** ✅
   - `features.hubRelay`: Enable/disable hub relay for unreachable peers
   - `features.offlineQueue`: Enable/disable offline message queuing

5. **Remove legacy `nebulaIp` fields** (PLANNED - Major version)
   - See Migration Guide below
   - Will be removed in v1.0.0

**Estimated effort**: 2-3 days

---

## Legacy `nebulaIp` Deprecation Guide

The `nebulaIp` and `port` fields on `PeerInfo` and `PeerConfig` are deprecated in favor of the transport-agnostic `endpoint` field.

### Current State (v0.x)

Both old and new fields are available:

```typescript
interface PeerInfo {
  id: string

  // DEPRECATED - use endpoint.address instead
  nebulaIp: string
  // DEPRECATED - use endpoint.port instead
  port?: number

  // NEW - transport-agnostic endpoint
  endpoint?: PeerEndpoint
}
```

### Migration Path

#### For Library Consumers

**Step 1: Update reads (now)**
```typescript
// Old way (deprecated)
const ip = peer.nebulaIp
const port = peer.port ?? 7946

// New way (recommended)
const ip = peer.endpoint?.address ?? peer.nebulaIp
const port = peer.endpoint?.port ?? peer.port ?? 7946
```

**Step 2: Update writes (now)**
```typescript
// Old way (deprecated)
const config: PeerConfig = {
  id: 'peer-1',
  nebulaIp: '10.0.0.1',
  port: 7946,
}

// New way (recommended) - works now, required in v1.0
const config: PeerConfig = {
  id: 'peer-1',
  nebulaIp: '10.0.0.1', // Still required for now
  port: 7946,
  endpoint: {
    peerId: 'peer-1',
    address: '10.0.0.1',
    port: 7946,
  },
}
```

#### For Internal Development

The `nebulaIp` field will be removed in v1.0.0:
1. `PeerInfo.nebulaIp` → `PeerInfo.endpoint.address`
2. `PeerInfo.port` → `PeerInfo.endpoint.port`
3. `PeerConfig.nebulaIp` → `PeerConfig.endpoint.address`
4. `NebulaMeshConfig.nebulaIp` → Keep as Nebula-specific

### Timeline

| Version | Status |
|---------|--------|
| v0.0.x | Both fields available, new code should use `endpoint` |
| v0.1.x | TypeScript deprecation warnings on `nebulaIp` fields |
| v1.0.0 | `nebulaIp` and `port` fields removed from `PeerInfo` |

### Breaking Changes in v1.0.0

1. `PeerInfo.nebulaIp` removed - use `PeerInfo.endpoint.address`
2. `PeerInfo.port` removed - use `PeerInfo.endpoint.port`
3. `PeerConfig.nebulaIp` may become optional if `endpoint` is provided

---

## Migration Path

### For Existing Users (Nebula)

```typescript
// Before (still works)
const mesh = await NebulaMesh.fromNebulaConfig('/etc/nebula/config.yml', {
  peerId: 'peer-1',
});

// After (new API)
const mesh = await createMesh({
  peerId: 'peer-1',
  transport: {
    type: 'nebula',
    configPath: '/etc/nebula/config.yml',
  },
});
```

### For New Users (Tailscale)

```typescript
// Hosted Tailscale
const mesh = await createMesh({
  peerId: 'peer-1',
  transport: {
    type: 'tailscale',
    authKey: process.env.TAILSCALE_AUTH_KEY,
    hostname: 'agent-node-1',
  },
});

// Self-hosted Headscale
const mesh = await createMesh({
  peerId: 'peer-1',
  transport: {
    type: 'headscale',
    serverUrl: 'https://headscale.example.com',
    preAuthKey: process.env.HEADSCALE_PREAUTH_KEY,
    hostname: 'agent-node-1',
  },
});
```

---

## File Structure After Implementation

```
src/
├── transports/
│   ├── index.ts                    # Factory: createTransport()
│   ├── types.ts                    # TransportAdapter, PeerEndpoint
│   ├── nebula/
│   │   ├── index.ts
│   │   ├── transport.ts            # NebulaTransport
│   │   ├── config-parser.ts        # Moved from mesh/
│   │   └── types.ts                # NebulaTransportConfig
│   ├── tailscale/
│   │   ├── index.ts
│   │   ├── transport.ts            # TailscaleTransport
│   │   ├── api-client.ts           # Tailscale API client
│   │   ├── discovery.ts            # Peer discovery
│   │   └── types.ts                # TailscaleTransportConfig
│   └── headscale/
│       ├── index.ts
│       ├── transport.ts            # HeadscaleTransport
│       ├── api-client.ts           # Headscale API client
│       └── types.ts                # HeadscaleTransportConfig
├── mesh/
│   ├── mesh.ts                     # Generic Mesh class (renamed from nebula-mesh)
│   ├── hub-election.ts             # Unchanged
│   ├── health-monitor.ts           # Unchanged
│   ├── peer-discovery.ts           # Updated for transport abstraction
│   └── namespace-registry.ts       # Unchanged
├── channel/
│   └── message-channel.ts          # Updated: MeshContext instead of NebulaMesh
└── types/
    └── index.ts                    # Updated with new types
```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking existing Nebula users | High | Phase 1 maintains full backward compatibility |
| Tailscale memory issues | Medium | Document, add memory monitoring, optional feature |
| Headscale API changes | Low | Version-lock API client, add fallbacks |
| Hub election incompatibility | Medium | Make hub election optional per transport |
| Performance regression | Medium | Benchmark before/after, optimize hot paths |

---

## Success Criteria

1. **Backward compatible**: Existing `NebulaMesh.fromNebulaConfig()` works unchanged
2. **Transport-agnostic**: `MessageChannel` and sync providers work with any transport
3. **Tailscale works**: Can connect peers via hosted Tailscale
4. **Headscale works**: Can connect peers via self-hosted Headscale
5. **Tests pass**: All existing tests pass, new transport tests added
6. **Documentation**: Updated docs with transport selection guide

---

## Summary

The current architecture has good foundations (`MeshContext`, `SyncProvider`) but `NebulaMesh` is monolithic. The plan:

1. **Phase 1**: Extract `TransportAdapter` interface (non-breaking)
2. **Phase 2**: Refactor `NebulaMesh` to use transport abstraction
3. **Phase 3**: Add `TailscaleTransport` for hosted flow
4. **Phase 4**: Add `HeadscaleTransport` for self-hosted alternative
5. **Phase 5**: Clean up legacy code, make features pluggable

Total estimated effort: **14-19 days** across all phases.

The key insight is that `MeshContext` is already a good abstraction point - we just need to:
1. Add `createChannel()` to the interface
2. Make the internal `_send*` methods part of the contract
3. Extract actual network I/O into `TransportAdapter` implementations
