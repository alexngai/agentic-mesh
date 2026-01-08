# CLAUDE.md - Agent Guide for agentic-mesh

This file provides context for AI agents working on the agentic-mesh codebase.

## Project Overview

agentic-mesh is a P2P CRDT synchronization library over Nebula mesh networks. It provides:
- Peer-to-peer connectivity over encrypted Nebula tunnels
- CRDT synchronization using Yjs (in-memory documents)
- SQLite CRDT synchronization using cr-sqlite (database replication)
- Typed message channels with offline queuing
- Certificate and lighthouse management

## Repository Structure

```
src/
├── index.ts                    # Main exports
├── cli.ts                      # CLI entry point (commander)
├── types/index.ts              # Shared type definitions
├── mesh/                       # Core networking
│   ├── nebula-mesh.ts          # Main mesh class - peer connections
│   ├── hub-election.ts         # Hub selection algorithm
│   ├── health-monitor.ts       # Peer health tracking
│   ├── peer-discovery.ts       # Lighthouse-based discovery
│   ├── namespace-registry.ts   # Namespace management for sync
│   ├── execution-router.ts     # Remote execution routing
│   ├── execution-stream.ts     # Streaming execution output
│   └── nebula-config-parser.ts # Parse Nebula YAML configs
├── channel/                    # Messaging
│   ├── message-channel.ts      # Pub/sub and RPC channels
│   ├── offline-queue.ts        # Queue for offline peers
│   └── serializers/            # JSON/msgpack serialization
├── sync/                       # CRDT sync
│   ├── provider.ts             # Base sync provider interface
│   ├── yjs-provider.ts         # Yjs sync implementation
│   └── cr-sqlite/              # SQLite CRDT sync
│       ├── provider.ts         # CrSqliteSyncProvider implementation
│       ├── extension-loader.ts # Platform-specific extension detection
│       ├── types.ts            # Config, messages, changesets
│       └── index.ts            # Module exports
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
└── mesh-integration.md         # Sudocode integration docs

examples/
├── basic-sync.ts               # Interactive sync demo
└── sudocode-loopback.ts        # Sudocode integration demo
```

## Key Classes

| Class | File | Purpose |
|-------|------|---------|
| `NebulaMesh` | `src/mesh/nebula-mesh.ts` | Core mesh connectivity, peer management |
| `MessageChannel` | `src/channel/message-channel.ts` | Typed pub/sub and RPC messaging |
| `YjsSyncProvider` | `src/sync/yjs-provider.ts` | Yjs CRDT sync over mesh |
| `CrSqliteSyncProvider` | `src/sync/cr-sqlite/provider.ts` | SQLite CRDT sync via cr-sqlite |
| `CertManager` | `src/certs/cert-manager.ts` | Certificate lifecycle management |
| `LighthouseManager` | `src/certs/lighthouse-manager.ts` | Lighthouse process control |
| `ConfigGenerator` | `src/certs/config-generator.ts` | Nebula YAML generation |
| `SudocodeMeshService` | `src/integrations/sudocode/service.ts` | Sudocode entity sync |

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
- `HubRole`, `HubConfig`, `HubState` - Hub system
- `NebulaMeshConfig` - Mesh configuration
- `MessageChannelConfig`, `QueuedMessage` - Messaging
- `SyncProviderConfig` - Sync configuration

Cert types in `src/certs/types.ts`:
- `CertificateInfo`, `CertManagerConfig` - Certificates
- `LighthouseInfo`, `LighthouseStatus` - Lighthouses
- `NebulaConfigOptions`, `FirewallRule` - Config generation

## Architecture Notes

### Hub System
- Priority-based hub election (lower priority = more preferred)
- Hub provides: authoritative state, offline message queuing, relay for NAT-blocked peers
- See `src/mesh/hub-election.ts` for algorithm

### Message Flow
```
Peer A -> MessageChannel -> NebulaMesh -> TCP/Nebula -> NebulaMesh -> MessageChannel -> Peer B
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
- Tables become "Conflict-free Replicated Relations" (CRRs)
- Changes tracked in `crsql_changes` virtual table
- Polling-based change detection with configurable interval

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

## Specs and Issues

Project uses sudocode for spec/issue tracking:
- `.sudocode/specs.jsonl` - Feature specifications
- `.sudocode/issues.jsonl` - Implementation tasks

Use the sudocode MCP tools to view/update specs and issues.

## Common Tasks

### Adding a new feature
1. Check existing specs in `.sudocode/`
2. Add types to appropriate `types.ts`
3. Implement in relevant module
4. Export from module's `index.ts`
5. Add to `src/index.ts` if public API
6. Write tests in `tests/unit/`

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
- `yjs` - CRDT implementation
- `y-protocols` - Yjs sync protocol
- `better-sqlite3` - SQLite bindings for cr-sqlite provider
- `commander` - CLI framework
- `@msgpack/msgpack` - Binary serialization
- `picomatch` - Glob pattern matching
- `lib0` - Yjs utilities

External requirements:
- `nebula` / `nebula-cert` - Must be installed on system
- `cr-sqlite` extension - Required for CrSqliteSyncProvider (auto-detected or via CRSQLITE_EXTENSION_PATH)
