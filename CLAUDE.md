# CLAUDE.md - Agent Guide for agentic-mesh

This file provides context for AI agents working on the agentic-mesh codebase.

## Project Overview

agentic-mesh is a **transport coordination and configuration layer for multi-agent systems**. It provides encrypted peer-to-peer connectivity, pluggable transport backends, agent protocol integration, and CRDT synchronization over mesh networks.

While agentic-mesh started as a CRDT sync library, it has evolved into foundational infrastructure used by projects like [multi-agent-protocol](https://github.com/multi-agent-protocol/multi-agent-protocol) to provide:

- **Pluggable encrypted transports** (Nebula, Tailscale, Headscale) with a unified `TransportAdapter` interface
- **Multi-Agent Protocol (MAP) server** for agent orchestration, scoping, and federated message routing
- **Agent Control Protocol (ACP) integration** bridging the ACP SDK to mesh transport via `AcpMeshAdapter` and `meshStream`
- **Git transport** over mesh networks (`git-remote-mesh://` protocol)
- **CRDT synchronization** using Yjs (in-memory) and cr-sqlite (SQLite replication)
- **Typed message channels** with offline queuing and RPC patterns
- **Certificate and lighthouse management** for Nebula PKI

### How Other Projects Use agentic-mesh

The [multi-agent-protocol/ts-sdk](https://github.com/multi-agent-protocol/multi-agent-protocol) depends on agentic-mesh (optional peer dependency) for:

1. **Stream transport** — `agenticMeshStream()` wraps agentic-mesh's `TunnelStream` into MAP-compatible `ReadableStream`/`WritableStream`
2. **Mesh peer coordination** — `MAPMeshPeer` wraps `createMeshPeer` for decentralized agent discovery and message routing
3. **Connection factory** — `ClientConnection.connectMesh()` and `AgentConnection.connectMesh()` establish MAP JSON-RPC connections over encrypted mesh tunnels

## Repository Structure

```
src/
├── index.ts                    # Main exports
├── cli.ts                      # CLI entry point (commander)
├── types/index.ts              # Shared type definitions
├── transports/                 # Pluggable transport abstraction
│   ├── types.ts                # TransportAdapter interface, PeerEndpoint, configs
│   ├── nebula/transport.ts     # Nebula transport implementation
│   ├── tailscale/transport.ts  # Tailscale transport implementation
│   └── headscale/transport.ts  # Headscale transport implementation
├── mesh/                       # Core networking
│   ├── nebula-mesh.ts          # Main mesh class - peer connections
│   ├── hub-election.ts         # Hub selection algorithm
│   ├── health-monitor.ts       # Peer health tracking
│   ├── health-adapter.ts       # Pluggable health monitor interface
│   ├── peer-discovery.ts       # Lighthouse-based discovery
│   ├── namespace-registry.ts   # Namespace management for sync
│   ├── execution-router.ts     # Remote execution routing
│   ├── execution-stream.ts     # Streaming execution output
│   └── nebula-config-parser.ts # Parse Nebula YAML configs
├── acp/                        # Agent Control Protocol integration
│   ├── adapter.ts              # AcpMeshAdapter - bridges ACP to mesh
│   ├── mesh-stream.ts          # meshStream / createConnectedStreams
│   ├── types.ts                # ACP message types, session observation
│   └── index.ts                # Module exports and type guards
├── map/                        # Multi-Agent Protocol server
│   ├── types.ts                # MAP types (Agent, Scope, Message, Event)
│   ├── server/map-server.ts    # Core MAP server (registry, scope, events, routing)
│   ├── agents/                 # Base and sync agent implementations
│   ├── bridge/                 # Client bridge for connections
│   ├── connection/             # Connection types (agent, peer, base)
│   ├── federation/             # Gateway for federated systems
│   └── stream/                 # Tunnel stream implementation
├── git/                        # Git transport over mesh
│   ├── git-remote-mesh.ts      # Git remote helper
│   ├── transport-service.ts    # Git transport service
│   ├── protocol-handler.ts     # Git protocol implementation
│   ├── pack-streamer.ts        # Pack file streaming
│   └── sync-client.ts          # Git sync client
├── channel/                    # Messaging
│   ├── message-channel.ts      # Pub/sub and RPC channels
│   ├── offline-queue.ts        # Queue for offline peers
│   └── serializers/            # JSON/msgpack serialization
├── sync/                       # CRDT sync
│   ├── provider.ts             # Base sync provider interface
│   ├── yjs-provider.ts         # Yjs sync implementation
│   └── cr-sqlite/              # SQLite CRDT sync
│       ├── provider.ts         # CrSqliteSyncProvider
│       ├── extension-loader.ts # Platform-specific extension detection
│       └── types.ts            # Config, messages, changesets
├── certs/                      # Certificate management
│   ├── cert-manager.ts         # Certificate lifecycle
│   ├── config-generator.ts     # Nebula config generation
│   ├── group-permissions.ts    # Permission checking
│   ├── lighthouse-manager.ts   # Lighthouse process management
│   └── types.ts                # Cert-specific types
└── integrations/
    └── sudocode/               # Sudocode integration
        ├── service.ts          # SudocodeMeshService
        ├── mapper.ts           # CRDT <-> JSONL mapping
        ├── jsonl-bridge.ts     # File I/O for JSONL
        ├── git-reconciler.ts   # Git wins reconciliation
        ├── sync-filter.ts      # Selective sync filtering
        ├── partition-manager.ts # Namespace partitioning
        └── types.ts            # Sudocode-specific types

tests/
├── unit/                       # Unit tests (vitest)
└── integration/                # Integration tests

docs/
├── USAGE.md                    # Detailed usage guide
├── agentic-mesh.md             # Architecture documentation
├── mesh-integration.md         # Sudocode integration docs
├── pluggable-transport-plan.md # Transport abstraction design
├── tailscale-headscale-evaluation.md # Transport comparison
└── mesh-design-decisions.md    # Design rationale

examples/
├── basic-sync.ts               # Interactive Yjs sync demo
├── cr-sqlite-sync.ts           # SQLite CRDT sync example
├── acp-server.ts               # ACP agent implementation
├── acp-mesh-demo.ts            # ACP + mesh integration demo
└── sudocode-loopback.ts        # Sudocode integration demo
```

## Key Classes

| Class | File | Purpose |
|-------|------|---------|
| `NebulaMesh` | `src/mesh/nebula-mesh.ts` | Core mesh connectivity, peer management |
| `AcpMeshAdapter` | `src/acp/adapter.ts` | Bridges Agent Control Protocol to mesh transport |
| `MapServer` | `src/map/server/map-server.ts` | Multi-Agent Protocol server (agents, scopes, events, routing) |
| `MessageChannel` | `src/channel/message-channel.ts` | Typed pub/sub and RPC messaging |
| `YjsSyncProvider` | `src/sync/yjs-provider.ts` | Yjs CRDT sync over mesh |
| `CrSqliteSyncProvider` | `src/sync/cr-sqlite/provider.ts` | SQLite CRDT sync via cr-sqlite |
| `CertManager` | `src/certs/cert-manager.ts` | Certificate lifecycle management |
| `LighthouseManager` | `src/certs/lighthouse-manager.ts` | Lighthouse process control |
| `ConfigGenerator` | `src/certs/config-generator.ts` | Nebula YAML generation |
| `SudocodeMeshService` | `src/integrations/sudocode/service.ts` | Sudocode entity sync |

### Transport Layer

| Class/Interface | File | Purpose |
|-----------------|------|---------|
| `TransportAdapter` | `src/transports/types.ts` | Abstract interface for all transports |
| `PeerEndpoint` | `src/transports/types.ts` | Transport-agnostic peer addressing |
| `NebulaTransport` | `src/transports/nebula/transport.ts` | Nebula transport implementation |
| `TailscaleTransport` | `src/transports/tailscale/transport.ts` | Tailscale transport implementation |
| `HeadscaleTransport` | `src/transports/headscale/transport.ts` | Headscale transport implementation |

### Agent Protocol Layer

| Export | File | Purpose |
|--------|------|---------|
| `meshStream` | `src/acp/mesh-stream.ts` | Create ACP-compatible stream over mesh |
| `createConnectedStreams` | `src/acp/mesh-stream.ts` | Create paired streams for testing |
| `TunnelStream` | `src/map/stream/` | NDJSON stream over encrypted transport |
| `isAcpRequest` / `isAcpResponse` | `src/acp/types.ts` | Type guards for ACP messages |

## Commands

```bash
npm run build          # Build with tsup (cjs + esm + types)
npm run test           # Run vitest tests
npm run lint           # TypeScript type checking
npm run dev            # Watch mode build
npm run demo           # Run basic-sync example
```

## Testing

Tests use vitest. Run specific tests:
```bash
npm run test                           # All tests
npm run test -- hub-election           # Tests matching pattern
npm run test -- --watch                # Watch mode
```

Test files follow pattern: `tests/unit/<feature>.test.ts`

## Conventions

### Code Style
- TypeScript strict mode
- No default exports (use named exports)
- Interfaces for public APIs, types for internal
- Events use `EventEmitter` pattern with typed events

### Naming
- Classes: PascalCase (`NebulaMesh`, `CertManager`)
- Files: kebab-case (`nebula-mesh.ts`, `cert-manager.ts`)
- Types: PascalCase with descriptive suffixes (`MeshConfig`, `PeerInfo`, `CertCreatedEvent`)

### Exports
- Each module has `index.ts` that re-exports public API
- Main `src/index.ts` exports everything consumers need
- Internal utilities not exported

## Type System

Core types in `src/types/index.ts`:
- `PeerInfo`, `PeerStatus`, `PeerConfig` - Peer representation
- `PeerEndpoint` - Transport-agnostic peer addressing
- `HubRole`, `HubConfig`, `HubState` - Hub system
- `NebulaMeshConfig`, `MeshContext` - Mesh configuration and interface
- `OptionalFeaturesConfig` - Toggleable features (hub election, health monitoring, etc.)
- `MessageChannelConfig`, `QueuedMessage` - Messaging
- `SyncProviderConfig` - Sync configuration

Transport types in `src/transports/types.ts`:
- `TransportAdapter` - Abstract transport interface
- `NebulaTransportConfig`, `TailscaleTransportConfig`, `HeadscaleTransportConfig`
- `TransportConfig` - Union of all transport configs

ACP types in `src/acp/types.ts`:
- `AcpRequest`, `AcpResponse`, `AcpNotification`, `AcpError` - Protocol messages
- `AcpMeshAdapterConfig`, `MeshStreamConfig` - Integration config
- `SessionInfo`, `SessionObserveRequest` - Session observation

MAP types in `src/map/types.ts`:
- `Agent`, `Scope`, `Message`, `Event` - Protocol entities
- MAP server, federation, and connection types

Cert types in `src/certs/types.ts`:
- `CertificateInfo`, `CertManagerConfig` - Certificates
- `LighthouseInfo`, `LighthouseStatus` - Lighthouses
- `NebulaConfigOptions`, `FirewallRule` - Config generation

## Architecture Notes

### Transport Abstraction

agentic-mesh supports pluggable transports via the `TransportAdapter` interface:

```
Application (MAP, ACP, Sync, Channels)
         │
    MeshContext Interface
         │
    TransportAdapter
    ┌────┼────────┬──────────┐
  Nebula  Tailscale  Headscale
```

Features can be toggled via `OptionalFeaturesConfig`:
- `hubElection` - Enable/disable hub selection
- `healthMonitoring` - true | false | 'transport' (delegate to transport)
- `namespaceRegistry` - Enable/disable namespace tracking
- `hubRelay` - Enable/disable hub relay for NAT-blocked peers
- `offlineQueue` - Enable/disable offline message queuing

### Agent Protocol Integration

**ACP (Agent Control Protocol):**
```
ACP Client → meshStream() → TunnelStream → NebulaMesh → encrypted transport → peer
```
- `AcpMeshAdapter` bridges ACP JSON-RPC messages to mesh channels
- `meshStream` creates ACP SDK-compatible streams over mesh connections

**MAP (Multi-Agent Protocol):**
```
MAP Client → agenticMeshStream() → TunnelStream → TransportAdapter → peer
```
- `MapServer` orchestrates agents, scopes, events, and message routing
- Used by multi-agent-protocol SDK as the P2P transport layer
- Supports federation via gateway

### Hub System
- Priority-based hub election (lower priority = more preferred)
- Hub provides: authoritative state, offline message queuing, relay for NAT-blocked peers
- See `src/mesh/hub-election.ts` for algorithm

### Message Flow
```
Peer A -> MessageChannel -> NebulaMesh -> TransportAdapter -> encrypted tunnel -> Peer B
```

### CRDT Sync

Two sync providers available:

**YjsSyncProvider** (in-memory):
- Uses Yjs for CRDT operations
- Best for: real-time collaborative editing, ephemeral state
- Broadcasts updates via `MessageChannel`
- State vectors exchanged on peer connection for efficient sync

**CrSqliteSyncProvider** (SQLite):
- Uses cr-sqlite for CRDT-based SQLite replication
- Best for: persistent structured data, relational queries
- Polling-based change detection with configurable interval

### Git Transport

`git-remote-mesh` enables git operations over mesh networks:
```bash
git clone git-remote-mesh://peer-id/repository
```
- Implements the git remote helper protocol
- Streams pack files over encrypted tunnels
- Used by MAP for repository synchronization

### Certificate Chain
```
Root CA -> User CA (optional) -> Server Certificates
```
Each peer needs a server cert signed by the mesh CA.

## Sudocode Integration

The `SudocodeMeshService` syncs sudocode entities (specs, issues, relationships, feedback) across peers:

1. CRDT layer (real-time sync via Yjs)
2. JSONL layer (persistent storage)
3. Git layer (distributed version control)

"Git wins" - on git pull, JSONL is rebuilt from files and CRDT state is reset.

## Common Tasks

### Adding a new feature
1. Check existing specs in `.sudocode/`
2. Add types to appropriate `types.ts`
3. Implement in relevant module
4. Export from module's `index.ts`
5. Add to `src/index.ts` if public API
6. Write tests in `tests/unit/`

### Adding a new transport
1. Create directory in `src/transports/<name>/`
2. Implement `TransportAdapter` interface in `transport.ts`
3. Add config type to `src/transports/types.ts`
4. Export from `src/transports/index.ts`
5. Add tests in `tests/unit/`

### Adding CLI command
1. Edit `src/cli.ts`
2. Follow existing command patterns
3. Use commander options/arguments

### Debugging
```typescript
// Enable debug logging
process.env.DEBUG = 'agentic-mesh:*'
```

## Dependencies

Key dependencies:
- `@agentclientprotocol/sdk` - ACP SDK integration
- `yjs` - CRDT implementation
- `y-protocols` - Yjs sync protocol
- `better-sqlite3` - SQLite bindings for cr-sqlite provider
- `ws` - WebSocket transport
- `commander` - CLI framework
- `@msgpack/msgpack` - Binary serialization
- `picomatch` - Glob pattern matching
- `lib0` - Yjs utilities

External requirements:
- `nebula` / `nebula-cert` - Required for Nebula transport (must be installed on system)
- `cr-sqlite` extension - Required for CrSqliteSyncProvider (auto-detected or via CRSQLITE_EXTENSION_PATH)
