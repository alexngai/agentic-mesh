# agentic-mesh: P2P CRDT Sync Library

## Overview

`agentic-mesh` is a standalone TypeScript library for peer-to-peer CRDT synchronization over Nebula mesh networks. It provides networking infrastructure for distributed applications that need real-time state synchronization without a central server.

| | |
|---|---|
| **Package** | `agentic-mesh` |
| **License** | MIT |
| **Runtime** | Node.js 18+ |
| **Dependencies** | Nebula (external binary), Yjs (bundled) |

## Use Cases

1. **Resource scaling** - Single user distributing workloads across multiple machines (laptop, cloud VMs, CI runners)
2. **Team collaboration** - Multiple users synchronizing shared state with access control
3. **Offline-first apps** - Applications that work offline and sync when connectivity returns
4. **Edge computing** - Distributed nodes that need to share state without central coordination

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              agentic-mesh                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌─────────────┐  │
│  │  CertManager  │  │  NebulaMesh   │  │ SyncProvider  │  │  Channel    │  │
│  │               │  │               │  │    (Yjs)      │  │             │  │
│  │ • CA creation │  │ • Peer mgmt   │  │ • Doc sync    │  │ • Messages  │  │
│  │ • Cert signing│  │ • Connection  │  │ • Snapshots   │  │ • RPC       │  │
│  │ • Config gen  │  │ • Health      │  │ • Conflicts   │  │ • Queue     │  │
│  │ • Revocation  │  │ • Hub logic   │  │               │  │             │  │
│  └───────────────┘  └───────────────┘  └───────────────┘  └─────────────┘  │
│          │                  │                  │                 │          │
│          └──────────────────┴──────────────────┴─────────────────┘          │
│                                     │                                       │
│                          ┌──────────┴──────────┐                            │
│                          │   Transport Layer   │                            │
│                          │  (Nebula tunnels)   │                            │
│                          └──────────┬──────────┘                            │
│                                     │                                       │
└─────────────────────────────────────┼───────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Nebula (external)                                 │
│                                                                             │
│  • Encrypted P2P tunnels (Noise Protocol + AES-256-GCM)                     │
│  • UDP hole punching for NAT traversal                                      │
│  • Certificate-based mutual authentication                                  │
│  • Lighthouse for peer discovery                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Design Decisions

### Core Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Nebula (hard dependency) | Proven at scale (Slack 50k+ hosts), strong security, NAT traversal |
| CRDT | Yjs (hard dependency) | Best-in-class performance, mature ecosystem, good TypeScript support |
| Certificate model | Hierarchical PKI | Enables user sub-CAs, natural permission mapping |
| Hub model | Priority-based sync anchor | Deterministic failover, no election complexity |
| Offline handling | Persistent queue | Operations survive restarts, drain on reconnect |
| Permissions | Certificate groups (static) | Simple, verifiable, no runtime ACL state |

### What agentic-mesh Does NOT Do

- **Application schemas** - Consumer defines their own Yjs document structure
- **Persistence format** - Consumer decides how to persist (JSONL, SQLite, etc.)
- **Business logic** - No domain-specific operations (tasks, execution, etc.)
- **End-user CLI** - Only library helpers; consumer builds their own CLI
- **Nebula process management** - User installs and runs Nebula separately

---

## Certificate Hierarchy

agentic-mesh uses a three-tier PKI model:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Root CA (Organization/Mesh)                         │
│                                                                             │
│  • Created once per mesh                                                    │
│  • Long-lived (10 years default)                                            │
│  • Private key stored offline/secure                                        │
│  • Signs user sub-CAs                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
          ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
          │   User: Alice   │ │   User: Bob     │ │   Bot: CI       │
          │    (Sub-CA)     │ │    (Sub-CA)     │ │    (Sub-CA)     │
          │                 │ │                 │ │                 │
          │ • 1 year expiry │ │ • 1 year expiry │ │ • 1 year expiry │
          │ • Signs servers │ │ • Signs servers │ │ • Signs servers │
          │ • Groups: admin │ │ • Groups: dev   │ │ • Groups: bot   │
          └─────────────────┘ └─────────────────┘ └─────────────────┘
                    │                 │                 │
            ┌───────┴───────┐         │         ┌───────┴───────┐
            ▼               ▼         ▼         ▼               ▼
       ┌─────────┐    ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
       │ laptop  │    │  cloud  │ │ desktop │ │ runner1 │ │ runner2 │
       │ 30 days │    │ 30 days │ │ 30 days │ │ 30 days │ │ 30 days │
       └─────────┘    └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

### IP Address Allocation

```
10.42.0.0/16 - Mesh address space

10.42.0.x    - Infrastructure (lighthouses, hubs)
10.42.1.x    - User 1's servers
10.42.2.x    - User 2's servers
...
10.42.100.x  - CI/Bot servers
```

### Certificate Groups

Groups are embedded in certificates and used for:
- Nebula firewall rules (network layer)
- Application permission checks (app layer)

```yaml
# Example groups
Groups:
  - "admin"           # Permission tier
  - "developer"       # Permission tier
  - "read-only"       # Permission tier
  - "user:alice"      # User identity
  - "server:laptop"   # Server identity
  - "hub"             # Can be sync anchor
```

---

## Hub System

### What is a Hub?

A hub is a **sync anchor** - a peer with elevated responsibility for state consistency. Hubs are NOT traffic routers; peers still connect directly when possible.

### Hub Responsibilities

```typescript
interface HubBehavior {
  // Always active when hub
  syncAnchor: {
    authoritativeState: true      // Hub's CRDT state wins ties
    persistSnapshots: true        // Stores snapshots for faster bootstrap
    snapshotIntervalMs: 60_000
    offlineMessageQueue: true     // Holds messages for offline peers
    queueTtlMs: 86_400_000        // 24 hours
  }

  // Optional (configurable)
  relay: {
    forwardCrdtUpdates: boolean   // Help NAT-blocked peers
    proxyMessages: boolean        // Forward P2P messages
  }
}
```

### Priority-Based Selection

Hubs are selected deterministically based on a priority list:

```
Priority 0: dedicated-server  ──► Online? Act as hub
                                  Offline? ↓
Priority 1: alice-cloud       ──► Online? Act as hub
                                  Offline? ↓
Priority 2: ci-runner         ──► Online? Act as hub
                                  Offline? ↓
                              ──► No hub (degraded mode)
```

### Hub Transitions

```typescript
// Set priority (from any peer)
await mesh.setHubPriority('dedicated-server', 0)
await mesh.setHubPriority('alice-cloud', 1)

// Graceful transfer
await mesh.transferHub('new-server')
// 1. Current hub syncs state to new hub
// 2. Broadcasts hub change
// 3. Demotes itself

// Forced takeover (if current hub unresponsive)
await mesh.setHubPriority('new-server', 0, { force: true })
// Uses monotonic epoch to prevent split-brain
```

---

## CRDT Synchronization

### Yjs Integration

agentic-mesh provides a custom Yjs sync provider that operates over Nebula tunnels:

```typescript
import { NebulaSyncProvider } from 'agentic-mesh'
import * as Y from 'yjs'

const doc = new Y.Doc()
const provider = new NebulaSyncProvider(doc, mesh, {
  namespace: 'my-project',
  snapshotPath: './snapshots/',
  snapshotInterval: 60_000,
  throttleMs: 100,
})
```

### Sync Protocol

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Initial Sync                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. New peer connects                                                       │
│  2. Exchange state vectors (what updates each peer has)                     │
│  3. Calculate diff (what's missing on each side)                            │
│  4. Send missing updates bidirectionally                                    │
│  5. Emit 'synced' event when complete                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           Ongoing Sync                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Local change applied to Y.Doc                                           │
│  2. Provider captures update (Uint8Array)                                   │
│  3. Broadcast to all connected peers (throttled)                            │
│  4. Peers apply update to their Y.Doc                                       │
│  5. CRDT semantics ensure eventual consistency                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Conflict Resolution

Yjs uses CRDTs which are conflict-free by design:

| Scenario | Resolution |
|----------|------------|
| Same field edited concurrently | Last-writer-wins (by Lamport timestamp) |
| Concurrent array insertions | Deterministic ordering (by client ID) |
| Delete + edit conflict | Edit wins (resurrection) |
| Concurrent map operations | Per-key last-writer-wins |

### Snapshots

For faster sync, hubs periodically save snapshots:

```typescript
// Snapshot is full Y.Doc state
const snapshot = Y.encodeStateAsUpdate(doc)
await fs.writeFile('snapshot.bin', snapshot)

// New peer can bootstrap from snapshot
const snapshot = await fs.readFile('snapshot.bin')
Y.applyUpdate(doc, snapshot)
// Then sync only updates since snapshot
```

---

## P2P Messaging

### MessageChannel API

```typescript
// Define message types
interface MyMessages {
  'task:request': { taskId: string, config: any }
  'task:status': { taskId: string, status: string }
  'task:complete': { taskId: string, result: any }
}

// Create typed channel
const channel = mesh.createChannel<MyMessages>('my-app')

// Fire-and-forget send
await channel.send('peer-id', 'task:request', { taskId: '123', config: {} })

// Broadcast to all peers
channel.broadcast('task:status', { taskId: '123', status: 'running' })

// Request/response pattern
const result = await channel.request('peer-id', 'task:request', payload, {
  timeout: 30_000
})

// Handle incoming messages
channel.on('task:request', (from, payload) => {
  console.log(`Received from ${from}:`, payload)
})

// Handle requests that expect response
channel.handle('task:request', async (from, payload) => {
  // Process and return response
  return { accepted: true, queuePosition: 5 }
})
```

### Offline Queue

Messages to offline peers are queued and delivered on reconnection:

```typescript
interface QueuedMessage {
  id: string
  targetPeer: string
  type: string
  payload: any
  queuedAt: Date
  expiresAt?: Date
  retryCount: number
  maxRetries: number
  priority: 'high' | 'normal' | 'low'
}

// Queue configuration
const channel = mesh.createChannel('my-app', {
  queuePath: './queue.json',     // Persistence path
  queueMaxSize: 1000,            // Max queued messages
  defaultTtl: 86_400_000,        // 24 hour default TTL
})

// Inspect queue
const pending = channel.queue.getPending()
const forPeer = channel.queue.getForPeer('peer-id')

// Queue events
channel.on('queue:drained', (peerId, count) => {
  console.log(`Sent ${count} queued messages to ${peerId}`)
})
```

---

## Connection Lifecycle

### Peer States

```
                    ┌─────────────┐
                    │   UNKNOWN   │ (never seen)
                    └──────┬──────┘
                           │ discovery
                           ▼
┌─────────┐ timeout  ┌─────────────┐  handshake   ┌─────────────┐
│  STALE  │◄─────────│ DISCOVERED  │─────────────►│ CONNECTING  │
└─────────┘          └─────────────┘              └──────┬──────┘
     │                      ▲                            │
     │ re-discovery         │ disconnect                 │ success
     └──────────────────────┼────────────────────────────┘
                            │                            │
                    ┌───────┴───────┐                    │
                    │               │                    ▼
              ┌─────────────┐  ┌─────────────┐    ┌─────────────┐
              │   OFFLINE   │  │ UNREACHABLE │◄───│   ONLINE    │
              │  (clean)    │  │  (timeout)  │    │             │
              └─────────────┘  └─────────────┘    └─────────────┘
                    │                │                    ▲
                    └────────────────┴────────────────────┘
                              reconnect
```

### Health Monitoring

```typescript
interface PeerHealth {
  state: PeerState
  lastSeen: Date
  lastHeartbeat: Date
  latencyMs: number
  connectionUptime: number
}

// Thresholds
const HEARTBEAT_INTERVAL = 10_000    // 10s between pings
const UNREACHABLE_THRESHOLD = 30_000 // 30s no response
const STALE_THRESHOLD = 300_000      // 5min no discovery
```

### Reconnection Protocol

```
1. Peer comes online
2. Exchange CRDT state vectors
3. Sync missing updates bidirectionally
4. Drain offline message queue
5. Emit 'peer:reconnected' event
```

---

## API Reference

### NebulaMesh

```typescript
import { NebulaMesh, MeshConfig } from 'agentic-mesh'

interface MeshConfig {
  // Identity
  name: string
  certPath: string
  keyPath: string
  caPath: string

  // Discovery
  lighthouse: string[]      // e.g., ['lighthouse.example.com:4242']
  listenPort?: number       // default: 4242

  // Hub
  hub?: {
    priorityList: string[]
    relay?: {
      forwardUpdates?: boolean
      proxyMessages?: boolean
    }
  }

  // Access control
  permissionChecker?: (peer: PeerInfo, action: string) => boolean
}

class NebulaMesh {
  constructor(config: MeshConfig)

  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>

  // Peers
  getPeers(): PeerInfo[]
  getPeer(id: string): PeerInfo | null
  getSelfInfo(): PeerInfo

  // Hub
  getActiveHub(): PeerInfo | null
  getHubPriorityList(): string[]
  setHubPriority(peerId: string, priority: number, options?: { force?: boolean }): Promise<void>
  removeHubCandidate(peerId: string): Promise<void>
  transferHub(newHubId: string): Promise<void>

  // Channels
  createChannel<T>(namespace: string, config?: ChannelConfig): MessageChannel<T>

  // Events
  on(event: 'peer:connected', handler: (peer: PeerInfo) => void): void
  on(event: 'peer:disconnected', handler: (peer: PeerInfo) => void): void
  on(event: 'peer:unreachable', handler: (peer: PeerInfo) => void): void
  on(event: 'peer:reconnected', handler: (peer: PeerInfo) => void): void
  on(event: 'hub:changed', handler: (newHub: PeerInfo | null, oldHub: PeerInfo | null) => void): void
}
```

### NebulaSyncProvider

```typescript
import { NebulaSyncProvider } from 'agentic-mesh'
import * as Y from 'yjs'

interface SyncProviderConfig {
  namespace: string
  snapshotPath?: string
  snapshotInterval?: number  // default: 60000
  throttleMs?: number        // default: 100
}

class NebulaSyncProvider {
  constructor(doc: Y.Doc, mesh: NebulaMesh, config: SyncProviderConfig)

  // State
  readonly synced: boolean
  readonly connecting: boolean

  // Operations
  sync(): Promise<void>
  saveSnapshot(): Promise<void>
  loadSnapshot(): Promise<boolean>
  destroy(): void

  // Events
  on(event: 'synced', handler: () => void): void
  on(event: 'sync-error', handler: (error: Error) => void): void
  on(event: 'update', handler: (origin: string) => void): void
}
```

### MessageChannel

```typescript
interface ChannelConfig {
  queuePath?: string
  queueMaxSize?: number      // default: 1000
  defaultTtl?: number        // default: 86400000 (24h)
}

class MessageChannel<T extends Record<string, any>> {
  // Send
  send<K extends keyof T>(peerId: string, type: K, payload: T[K]): Promise<void>
  broadcast<K extends keyof T>(type: K, payload: T[K]): void

  // Request/Response
  request<K extends keyof T, R = any>(
    peerId: string,
    type: K,
    payload: T[K],
    options?: { timeout?: number }
  ): Promise<R>

  // Receive
  on<K extends keyof T>(type: K, handler: (from: string, payload: T[K]) => void): void
  handle<K extends keyof T, R = any>(type: K, handler: (from: string, payload: T[K]) => Promise<R>): void

  // Queue
  readonly queue: OfflineQueue

  // Events
  on(event: 'queue:drained', handler: (peerId: string, count: number) => void): void
  on(event: 'queue:full', handler: () => void): void
}
```

### CertManager

```typescript
import { CertManager } from 'agentic-mesh'

interface CertManagerConfig {
  caPath: string
  caKeyPath?: string
  userCertPath?: string
  userKeyPath?: string
}

class CertManager {
  constructor(config: CertManagerConfig)

  // CA operations
  initCA(options: {
    name: string
    duration?: string  // default: '87600h'
  }): Promise<void>

  createUserCA(options: {
    name: string
    groups: string[]
    duration?: string  // default: '8760h'
    outCert: string
    outKey: string
  }): Promise<void>

  // Server certificates
  signServerCert(options: {
    name: string
    ip: string
    groups: string[]
    duration?: string  // default: '720h'
    outCert: string
    outKey: string
  }): Promise<void>

  // Nebula config
  generateNebulaConfig(options: {
    certPath: string
    keyPath: string
    lighthouse: string[]
    lighthouseHosts: string[]
    listenPort?: number
    firewallRules?: FirewallRule[]
  }): string  // YAML content

  // Utilities
  parseCert(certPath: string): CertInfo
  verifyCert(certPath: string): boolean
  getCertExpiry(certPath: string): Date
}
```

### CLI Helpers

```typescript
import { createCLI } from 'agentic-mesh/cli'

const cli = createCLI({
  name: 'myapp-mesh',
  version: '1.0.0',
  configDir: '~/.config/myapp/mesh',
  projectDir: '.myapp/mesh',
})

cli.run(process.argv)

// Built-in commands:
// myapp-mesh init [--name <name>]
// myapp-mesh join [--name <name>] [--from <peer>]
// myapp-mesh peers
// myapp-mesh status
// myapp-mesh hub set-priority <peer> <priority>
// myapp-mesh hub status
// myapp-mesh cert sign <name> --ip <ip> --groups <groups>
```

Or use individual commands:

```typescript
import { commands } from 'agentic-mesh/cli'

// Add to your own CLI
program.command('mesh')
  .addCommand(commands.init(options))
  .addCommand(commands.join(options))
  .addCommand(commands.peers(options))
```

---

## Error Handling

```typescript
import {
  MeshError,
  ConnectionError,
  CertificateError,
  SyncError,
  PermissionError,
  TimeoutError,
} from 'agentic-mesh'

// All errors extend MeshError
class MeshError extends Error {
  code: string
  recoverable: boolean
}

// Specific error types
class ConnectionError extends MeshError {
  peerId?: string
}

class CertificateError extends MeshError {
  certPath?: string
  reason: 'expired' | 'invalid' | 'untrusted' | 'missing'
}

class SyncError extends MeshError {
  namespace?: string
}

class PermissionError extends MeshError {
  action: string
  peerId: string
}

class TimeoutError extends MeshError {
  operation: string
  timeoutMs: number
}
```

---

## Storage Layout

agentic-mesh manages these files (paths provided by consumer):

```
<configDir>/                    # User-level (e.g., ~/.config/myapp/mesh/)
├── ca.crt                      # Root CA cert (read by agentic-mesh)
├── user.crt                    # User sub-CA cert (optional)
├── user.key                    # User sub-CA key (optional)
└── known_peers.json            # Peer cache (managed by agentic-mesh)

<projectDir>/                   # Project-level (e.g., .myapp/mesh/)
├── server.crt                  # Server certificate
├── server.key                  # Server private key
├── nebula.yaml                 # Generated Nebula config
├── snapshots/                  # CRDT snapshots (managed)
│   └── <namespace>.snapshot
└── queue.json                  # Offline queue (managed)
```

---

## Nebula Requirement

agentic-mesh requires Nebula to be installed separately:

```bash
# macOS
brew install nebula

# Linux (Debian/Ubuntu)
curl -LO https://github.com/slackhq/nebula/releases/download/v1.9.0/nebula-linux-amd64.tar.gz
tar xzf nebula-linux-amd64.tar.gz
sudo mv nebula nebula-cert /usr/local/bin/

# Verify
nebula -version
nebula-cert -version
```

User is responsible for running Nebula:

```bash
# Start nebula with generated config
sudo nebula -config .myapp/mesh/nebula.yaml

# Or via systemd/launchd for persistent operation
```

---

## Future Considerations

### Planned

- Pluggable transport (Tailscale, ZeroTier, WireGuard)
- Alternative CRDTs (Automerge)
- Awareness/presence layer
- Certificate auto-renewal

### Non-Goals

- Application-specific logic
- Database/persistence
- End-user CLI
- Nebula process management
- Binary distribution
