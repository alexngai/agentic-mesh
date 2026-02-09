# agentic-mesh Usage Guide

This guide covers setup, configuration, and API usage for agentic-mesh.

## Table of Contents

- [Installation](#installation)
- [Nebula Setup](#nebula-setup)
- [Certificate Management](#certificate-management)
- [NebulaMesh API](#nebulamesh-api)
- [Transport Abstraction](#transport-abstraction)
- [Agent Control Protocol (ACP)](#agent-control-protocol-acp)
- [Multi-Agent Protocol (MAP)](#multi-agent-protocol-map)
- [Git Transport](#git-transport)
- [CRDT Synchronization](#crdt-synchronization)
- [SQLite CRDT Synchronization](#sqlite-crdt-synchronization)
- [Message Channels](#message-channels)
- [Hub System](#hub-system)
- [Lighthouse Management](#lighthouse-management)
- [Configuration Reference](#configuration-reference)
- [Integrations](#integrations)

---

## Installation

```bash
npm install agentic-mesh
```

**Requirements:**
- Node.js 18+
- Nebula (for network transport)
- nebula-cert (for certificate management)

---

## Nebula Setup

agentic-mesh uses [Nebula](https://github.com/slackhq/nebula) for encrypted peer-to-peer networking. Each peer needs:

1. A certificate signed by a shared CA
2. A Nebula configuration file
3. The Nebula process running

### Installing Nebula

```bash
# macOS
brew install nebula

# Linux (amd64)
curl -LO https://github.com/slackhq/nebula/releases/latest/download/nebula-linux-amd64.tar.gz
tar xzf nebula-linux-amd64.tar.gz
sudo mv nebula nebula-cert /usr/local/bin/

# Verify
nebula-cert -version
nebula -version
```

### Network Topology

A typical agentic-mesh deployment:

```
                    ┌─────────────────┐
                    │   Lighthouse    │
                    │  (public IP)    │
                    │  10.42.0.1      │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
     ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐
     │   Peer A    │  │   Peer B    │  │   Peer C    │
     │ 10.42.0.10  │  │ 10.42.0.11  │  │ 10.42.0.12  │
     │  (laptop)   │  │  (server)   │  │  (CI)       │
     └─────────────┘  └─────────────┘  └─────────────┘
```

- **Lighthouse**: Has a public IP, helps peers find each other
- **Peers**: Can be behind NAT, connect via lighthouse for discovery

### Running Nebula

```bash
# Start Nebula (requires root for TUN device)
sudo nebula -config /path/to/nebula.yaml

# Or as a systemd service
sudo systemctl start nebula
```

---

## Certificate Management

agentic-mesh includes a `CertManager` for Nebula certificate operations.

### CLI Commands

```bash
# Create root CA (do this once per mesh)
npx agentic-mesh cert create-ca \
  --name my-mesh \
  --duration 87600h \
  --groups admin,developer

# Create user sub-CA (optional, for delegated signing)
npx agentic-mesh cert create-user-ca \
  --name alice-ca \
  --root-ca my-mesh \
  --groups developer

# Sign server certificate
npx agentic-mesh cert sign \
  --name alice-laptop \
  --ca my-mesh \
  --ip 10.42.0.10/24 \
  --groups developer,executor

# List certificates
npx agentic-mesh cert list

# Verify certificate
npx agentic-mesh cert verify --name alice-laptop

# Renew certificate
npx agentic-mesh cert renew --name alice-laptop

# Revoke certificate
npx agentic-mesh cert revoke --name alice-laptop --reason "compromised"
```

### Programmatic Usage

```typescript
import { CertManager } from 'agentic-mesh'

const certManager = new CertManager({ certsDir: './certs' })
await certManager.initialize()

// Create root CA
const ca = await certManager.createRootCA({
  name: 'my-mesh',
  duration: '87600h',  // 10 years
  groups: ['admin'],
})

// Sign server certificate
const cert = await certManager.signServerCert({
  name: 'peer-1',
  caName: 'my-mesh',
  nebulaIp: '10.42.0.10/24',
  duration: '8760h',  // 1 year
  groups: ['developer', 'executor'],
})

console.log(`Certificate: ${cert.certPath}`)
console.log(`Key: ${cert.keyPath}`)
console.log(`Expires: ${cert.expiresAt}`)

// Verify certificate chain
const verification = await certManager.verifyCert('peer-1')
if (!verification.valid) {
  console.error('Errors:', verification.errors)
}

// List all certificates
const certs = certManager.listCertificates()
for (const c of certs) {
  console.log(`${c.name} (${c.type}) - expires ${c.expiresAt}`)
}

// Auto-renewal monitoring
certManager.on('cert:expiring', (event) => {
  console.log(`Certificate ${event.name} expires in ${event.daysUntilExpiry} days`)
})

await certManager.shutdown()
```

### Certificate Groups

Groups are embedded in certificates and used for:
- Nebula firewall rules (network-level access)
- Application permission checks

Common group patterns:
```
admin        - Full access
developer    - Read/write access
executor     - Can run remote executions
read-only    - Read-only access
hub          - Can be sync anchor
user:alice   - User identity
```

---

## NebulaMesh API

`NebulaMesh` handles peer connections over Nebula networks.

### Configuration

```typescript
import { NebulaMesh, HubRole } from 'agentic-mesh'

const mesh = new NebulaMesh({
  // Required
  peerId: 'alice',
  nebulaIp: '10.42.0.10',

  // Optional
  port: 7946,                          // TCP port for mesh protocol
  peers: [                             // Known peers
    { id: 'bob', nebulaIp: '10.42.0.11' },
    { id: 'charlie', nebulaIp: '10.42.0.12' },
  ],

  // Hub configuration (optional)
  hub: {
    role: HubRole.CANDIDATE,           // ADMIN, CANDIDATE, or OBSERVER
    priority: 10,                      // Lower = higher priority
  },
})
```

### Connection Lifecycle

```typescript
// Connect to mesh
await mesh.connect()

// Check connection status
console.log('Connected:', mesh.isConnected())

// Disconnect
await mesh.disconnect()
```

### Peer Management

```typescript
// Get all peers
const peers = mesh.getPeers()
for (const peer of peers) {
  console.log(`${peer.id}: ${peer.status}`)  // 'connected' | 'disconnected' | 'connecting'
}

// Get specific peer
const bob = mesh.getPeer('bob')
if (bob) {
  console.log(`Bob's IP: ${bob.nebulaIp}`)
  console.log(`Bob's groups: ${bob.groups}`)
}

// Get self info
const self = mesh.getSelfInfo()
console.log(`My ID: ${self.id}`)
```

### Events

```typescript
mesh.on('peer:joined', (peer) => {
  console.log(`Peer joined: ${peer.id}`)
})

mesh.on('peer:left', (peer) => {
  console.log(`Peer left: ${peer.id}`)
})

mesh.on('peer:status', (peer) => {
  console.log(`Peer ${peer.id} status: ${peer.status}`)
})

mesh.on('hub:changed', ({ previous, current }) => {
  console.log(`Hub changed: ${previous?.id} -> ${current?.id}`)
})

mesh.on('error', (error) => {
  console.error('Mesh error:', error)
})
```

---

## Transport Abstraction

agentic-mesh supports pluggable transports via the `TransportAdapter` interface. This enables switching between Nebula, Tailscale, and Headscale without changing application code.

### TransportAdapter Interface

All transports implement a common interface:

```typescript
import type { TransportAdapter, PeerEndpoint } from 'agentic-mesh'

interface TransportAdapter {
  readonly type: string
  readonly active: boolean

  start(): Promise<void>
  stop(): Promise<void>

  connect(endpoint: PeerEndpoint): Promise<boolean>
  disconnect(peerId: string): Promise<void>
  getConnectedPeers(): string[]
  isConnected(peerId: string): boolean

  send(peerId: string, data: Uint8Array): boolean
  broadcast(data: Uint8Array): void
  getLocalEndpoint(): PeerEndpoint
}
```

### Transport-Agnostic Peer Addressing

```typescript
interface PeerEndpoint {
  peerId: string
  address: string       // IP, URL, etc.
  port?: number
  metadata?: Record<string, unknown>
}
```

### Optional Features

Mesh features can be toggled via configuration:

```typescript
const mesh = new NebulaMesh({
  peerId: 'alice',
  nebulaIp: '10.42.0.10',
  features: {
    hubElection: true,           // Enable/disable hub selection
    healthMonitoring: true,      // true | false | 'transport'
    namespaceRegistry: true,     // Enable/disable namespace tracking
    hubRelay: true,              // Enable/disable hub relay
    offlineQueue: true,          // Enable/disable offline message queuing
  },
})
```

When `healthMonitoring` is set to `'transport'`, health checks are delegated to the transport implementation (e.g., Tailscale CLI for peer status).

### Pluggable Health Monitoring

```typescript
import { NoopHealthMonitor, HealthMonitor } from 'agentic-mesh'

// Default: TCP ping/pong
const monitor = new HealthMonitor(config)

// Disabled: all peers always considered healthy
const noop = new NoopHealthMonitor()

// Transport-delegated: uses transport's built-in health checks
// Configured via features.healthMonitoring = 'transport'
```

---

## Agent Control Protocol (ACP)

agentic-mesh integrates with the [Agent Control Protocol](https://github.com/anthropics/agent-control-protocol) via `AcpMeshAdapter` and `meshStream`, enabling ACP agents to communicate over encrypted mesh tunnels.

### AcpMeshAdapter

Bridges ACP JSON-RPC messages to mesh transport:

```typescript
import { NebulaMesh, AcpMeshAdapter } from 'agentic-mesh'

const mesh = new NebulaMesh({ /* config */ })
await mesh.connect()

const adapter = new AcpMeshAdapter(mesh)
await adapter.start()

// Handle incoming ACP requests from remote peers
adapter.onRequest(async (request, from, respond) => {
  console.log(`ACP request from ${from.id}: ${request.method}`)
  const response = await myAgent.handleRequest(request)
  respond(response)
})

// Handle all incoming messages (requests + notifications)
adapter.onMessage((message, from) => {
  console.log(`Message from ${from.id}`)
})

// Send ACP request to specific peer
const response = await adapter.request(peerId, acpRequest, timeout)

// Broadcast notification to all peers
adapter.broadcast(notification)

await adapter.stop()
```

### meshStream

Creates ACP SDK-compatible streams for use with `AgentSideConnection`:

```typescript
import { meshStream, createConnectedStreams } from 'agentic-mesh'
import { AgentSideConnection } from '@agentclientprotocol/sdk'

// Create a stream connected to a specific peer
const stream = meshStream(mesh, { peerId: 'client-peer' })

// Use with ACP SDK
const connection = new AgentSideConnection(
  (conn) => new MyAcpAgent(conn),
  stream
)

// For testing: create a pair of connected streams
const { clientStream, serverStream } = createConnectedStreams()
```

### Type Guards

```typescript
import {
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  isSessionObserveRequest,
  isSessionListRequest,
} from 'agentic-mesh'

if (isAcpRequest(message)) {
  // Handle request
} else if (isAcpNotification(message)) {
  // Handle notification
}
```

---

## Multi-Agent Protocol (MAP)

agentic-mesh includes a MAP server implementation for agent orchestration. The [multi-agent-protocol SDK](https://github.com/multi-agent-protocol/multi-agent-protocol) uses agentic-mesh as an optional peer dependency for mesh transport.

### MAP Server

```typescript
import { MapServer } from 'agentic-mesh'

const mapServer = new MapServer({
  systemId: 'my-system',
  federation: { enabled: true },
})
```

The MAP server provides:
- **AgentRegistry** — Agent lifecycle management
- **ScopeManager** — Scope creation and deletion
- **EventBus** — Event distribution to subscribers
- **MessageRouter** — Message routing between agents and peers

### How multi-agent-protocol Uses agentic-mesh

MAP clients and agents can connect over mesh using `connectMesh()`:

```typescript
import { ClientConnection } from '@multi-agent-protocol/sdk'

const client = await ClientConnection.connectMesh({
  transport,                                                    // agentic-mesh TransportAdapter
  peer: { peerId: 'server', address: '10.0.0.1', port: 4242 }, // Remote peer
  localPeerId: 'my-client',
  name: 'MeshClient',
  reconnection: true,
})

// Use MAP protocol normally
const agents = await client.listAgents()
const subscription = await client.subscribe({
  eventTypes: ['agent.registered', 'agent.state.changed'],
})
```

The SDK wraps agentic-mesh's `TunnelStream` into MAP-compatible `ReadableStream`/`WritableStream` via `agenticMeshStream()`.

---

## Git Transport

agentic-mesh provides a git remote helper for syncing repositories over encrypted mesh tunnels.

### Usage

```bash
# Clone a repository from a mesh peer
git clone git-remote-mesh://peer-id/repository

# Push to a mesh peer
git push git-remote-mesh://peer-id/repository main
```

### Components

- **`git-remote-mesh`** — Git remote helper binary (registered via package.json `bin`)
- **`GitTransportService`** — Service handling git protocol operations
- **`ProtocolHandler`** — Git protocol implementation
- **`PackStreamer`** — Streams pack files over encrypted tunnels
- **`GitSyncClient`** — Client for initiating git sync operations

---

## CRDT Synchronization

`YjsSyncProvider` synchronizes Yjs documents across peers.

### Basic Usage

```typescript
import { YjsSyncProvider } from 'agentic-mesh'

const provider = new YjsSyncProvider(mesh, {
  namespace: 'my-project',             // Unique namespace for this document
})

await provider.start()

// Get shared data structures
const map = provider.getMap<string>('settings')
const array = provider.getArray<number>('scores')
const text = provider.getText('notes')

// Modify data (syncs automatically)
map.set('theme', 'dark')
array.push([100, 95, 88])
text.insert(0, 'Hello, world!')

// Read data
console.log('Theme:', map.get('theme'))
console.log('Scores:', array.toArray())
console.log('Notes:', text.toString())
```

### Observing Changes

```typescript
// Observe map changes
map.observe((event) => {
  event.changes.keys.forEach((change, key) => {
    if (change.action === 'add') {
      console.log(`Added: ${key} = ${map.get(key)}`)
    } else if (change.action === 'update') {
      console.log(`Updated: ${key} = ${map.get(key)}`)
    } else if (change.action === 'delete') {
      console.log(`Deleted: ${key}`)
    }
  })
})

// Observe array changes
array.observe((event) => {
  console.log('Array changed:', array.toArray())
})

// Observe text changes
text.observe((event) => {
  console.log('Text changed:', text.toString())
})
```

### Sync Events

```typescript
provider.on('syncing', () => {
  console.log('Syncing with peers...')
})

provider.on('synced', () => {
  console.log('Sync complete')
})

provider.on('peer:synced', (peerId) => {
  console.log(`Synced with peer: ${peerId}`)
})
```

### Accessing the Underlying Y.Doc

```typescript
import * as Y from 'yjs'

const doc = provider.getDoc()

// Transact multiple operations atomically
doc.transact(() => {
  map.set('a', '1')
  map.set('b', '2')
  map.set('c', '3')
})

// Export document state
const state = Y.encodeStateAsUpdate(doc)

// Import document state
Y.applyUpdate(doc, state)
```

### Cleanup

```typescript
await provider.stop()
```

---

## SQLite CRDT Synchronization

`CrSqliteSyncProvider` synchronizes SQLite databases using [cr-sqlite](https://vlcn.io/docs/cr-sqlite), providing CRDT-based multi-writer replication.

### Prerequisites

Install the cr-sqlite extension:

```bash
# Option 1: npm package
npm install @aspect-build/aspect-rules-cr-sqlite

# Option 2: Manual download
curl -LO https://github.com/vlcn-io/cr-sqlite/releases/latest/download/crsqlite-darwin-aarch64.dylib
mkdir -p ~/.cr-sqlite
mv crsqlite-darwin-aarch64.dylib ~/.cr-sqlite/crsqlite.dylib

# Option 3: Environment variable
export CRSQLITE_EXTENSION_PATH=/path/to/crsqlite.dylib
```

### Basic Usage

```typescript
import { NebulaMesh, CrSqliteSyncProvider } from 'agentic-mesh'

const mesh = new NebulaMesh({
  peerId: 'alice',
  nebulaIp: '10.42.0.10',
  peers: [{ id: 'bob', nebulaIp: '10.42.0.11' }],
})
await mesh.connect()

const dbSync = new CrSqliteSyncProvider(mesh, {
  namespace: 'shared-db',
  dbPath: './data/shared.db',
  tables: ['tasks', 'users'],  // Tables to sync
})

await dbSync.start()

// Get the underlying SQLite database
const db = dbSync.getDb()

// Create tables (only first peer needs to do this)
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    created_at INTEGER
  )
`)

// Changes sync automatically to all peers
db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(
  'task-1', 'Implement feature', 'pending', Date.now()
)

// Query data (includes changes from other peers)
const tasks = db.prepare('SELECT * FROM tasks').all()
console.log('All tasks:', tasks)
```

### Configuration Options

```typescript
interface CrSqliteSyncConfig {
  namespace: string           // Unique namespace for this database
  dbPath: string              // Path to SQLite database file
  tables?: string[]           // Tables to sync (default: all CRR tables)
  pollInterval?: number       // Change detection interval in ms (default: 100)
  batchSize?: number          // Changesets per sync batch (default: 1000)
  extensionPath?: string      // Path to cr-sqlite extension (auto-detected)
  scope?: Record<string, unknown>  // Optional row filter (future)
}
```

### Sync Events

```typescript
// Sync lifecycle
dbSync.on('syncing', () => {
  console.log('Syncing with peers...')
})

dbSync.on('synced', () => {
  console.log('Initial sync complete')
})

// Change events
dbSync.on('change:applied', (table, pk) => {
  console.log(`Remote change applied: ${table}[${JSON.stringify(pk)}]`)
})

dbSync.on('change:sent', (table, count) => {
  console.log(`Sent ${count} changes for ${table}`)
})

// Hub snapshots
dbSync.on('snapshot:saved', (path) => {
  console.log(`Snapshot saved to ${path}`)
})

// Errors
dbSync.on('error', (error) => {
  console.error('Sync error:', error.code, error.message)
  if (error.recoverable) {
    console.log('Will retry...')
  }
})
```

### How It Works

1. **CRR Tables**: Tables are upgraded to "Conflict-free Replicated Relations" using cr-sqlite
2. **Change Tracking**: cr-sqlite tracks changes in a `crsql_changes` virtual table
3. **Polling**: Provider polls for local changes at `pollInterval`
4. **Broadcasting**: Changes are broadcast to all peers via MessageChannel
5. **Merging**: Incoming changes are applied via `crsql_changes` (CRDT merge)
6. **Version Tracking**: Each peer tracks local and remote versions

### API Reference

```typescript
// Get the underlying better-sqlite3 database
const db = dbSync.getDb()

// Get this peer's cr-sqlite site ID
const siteId = dbSync.getSiteId()

// Get current local version
const version = dbSync.getLocalVersion()

// Get map of peer versions
const peerVersions = dbSync.getPeerVersions()

// Force immediate sync check
await dbSync.sync()

// Stop syncing
await dbSync.stop()
```

### Hub Behavior

When the mesh node is a hub, the provider automatically:
- Saves periodic database snapshots (every 60 seconds)
- Serves as the primary sync target for new peers

### Installation Help

```typescript
import { getInstallInstructions } from 'agentic-mesh'

// Get platform-specific installation instructions
console.log(getInstallInstructions())
```

---

## Message Channels

`MessageChannel` provides typed pub/sub and RPC messaging.

### Creating a Channel

```typescript
// Define message types
interface TaskMessages {
  'task:create': { id: string; title: string }
  'task:update': { id: string; status: string }
  'task:delete': { id: string }
  'task:query': { filter: string }
}

const channel = mesh.createChannel<TaskMessages>('tasks')
```

### Sending Messages

```typescript
// Send to specific peer
await channel.send('bob', 'task:create', {
  id: 'task-1',
  title: 'Implement feature',
})

// Broadcast to all peers
channel.broadcast('task:update', {
  id: 'task-1',
  status: 'completed',
})
```

### Receiving Messages

```typescript
// Handle incoming messages
channel.on('task:create', (from, payload) => {
  console.log(`${from} created task: ${payload.title}`)
})

channel.on('task:update', (from, payload) => {
  console.log(`Task ${payload.id} updated to ${payload.status}`)
})
```

### Request/Response Pattern

```typescript
// Handle requests (return a response)
channel.handle('task:query', async (from, payload) => {
  const tasks = await db.query(payload.filter)
  return { tasks, count: tasks.length }
})

// Make request (await response)
const response = await channel.request('bob', 'task:query', {
  filter: 'status=pending',
}, {
  timeout: 5000,  // 5 second timeout
})

console.log(`Found ${response.count} tasks`)
```

### Offline Queue

Messages to offline peers are queued and delivered on reconnection:

```typescript
const channel = mesh.createChannel('tasks', {
  queue: {
    enabled: true,
    maxSize: 1000,           // Max queued messages
    ttl: 86400000,           // 24 hour TTL
  },
})

// Check queue status
const stats = channel.getQueueStats()
console.log(`Queued messages: ${stats.total}`)

// Listen for queue events
channel.on('queue:drained', (peerId, count) => {
  console.log(`Sent ${count} queued messages to ${peerId}`)
})
```

---

## Hub System

The hub is a sync anchor that provides authoritative state and offline message queuing.

### Hub Roles

```typescript
import { HubRole } from 'agentic-mesh'

// ADMIN - Always try to be hub (highest priority)
// CANDIDATE - Can become hub if higher-priority peers unavailable
// OBSERVER - Never becomes hub

const mesh = new NebulaMesh({
  peerId: 'server',
  nebulaIp: '10.42.0.5',
  hub: {
    role: HubRole.ADMIN,
    priority: 0,  // Highest priority
  },
})
```

### Hub Operations

```typescript
// Check if this node is the hub
if (mesh.isHub()) {
  console.log('This node is the hub')
}

// Get current hub
const hub = mesh.getHub()
if (hub) {
  console.log(`Current hub: ${hub.id}`)
}

// Listen for hub changes
mesh.on('hub:changed', ({ previous, current }) => {
  if (current) {
    console.log(`New hub: ${current.id}`)
  } else {
    console.log('No hub available')
  }
})
```

### Hub Features

When a node becomes hub:
- Stores authoritative CRDT state
- Queues messages for offline peers
- Relays messages between NAT-blocked peers

---

## Lighthouse Management

`LighthouseManager` manages Nebula lighthouse processes.

### CLI Commands

```bash
# Create lighthouse
npx agentic-mesh lighthouse create \
  --name lh1 \
  --ip 10.42.0.1/24 \
  --endpoint lighthouse.example.com:4242 \
  --ca-cert ./certs/my-mesh.crt \
  --cert ./certs/lh1.crt \
  --key ./certs/lh1.key

# Start lighthouse
npx agentic-mesh lighthouse start --name lh1

# Check status
npx agentic-mesh lighthouse status --name lh1

# List all lighthouses
npx agentic-mesh lighthouse list

# Stop lighthouse
npx agentic-mesh lighthouse stop --name lh1

# Remove lighthouse
npx agentic-mesh lighthouse remove --name lh1
```

### Programmatic Usage

```typescript
import { LighthouseManager } from 'agentic-mesh'

const manager = new LighthouseManager({
  lighthousesDir: './lighthouses',
})
await manager.initialize()

// Create lighthouse
const info = await manager.create({
  name: 'lh1',
  nebulaIp: '10.42.0.1/24',
  publicEndpoint: 'lighthouse.example.com:4242',
  caCertPath: './certs/my-mesh.crt',
  certPath: './certs/lh1.crt',
  keyPath: './certs/lh1.key',
  listenPort: 4242,
  dns: { enabled: true, port: 53 },  // Optional DNS server
})

// Start lighthouse
await manager.start('lh1')

// Check health
const health = await manager.health('lh1')
console.log(`Status: ${health.status}`)  // 'running' | 'stopped' | 'error'
console.log(`Healthy: ${health.healthy}`)
console.log(`PID: ${health.pid}`)

// List all lighthouses
const lighthouses = manager.list()

// Stop and remove
await manager.stop('lh1')
await manager.remove('lh1')

await manager.shutdown()
```

### Lighthouse Events

```typescript
manager.on('lighthouse:started', ({ name, pid }) => {
  console.log(`Lighthouse ${name} started (PID: ${pid})`)
})

manager.on('lighthouse:stopped', ({ name }) => {
  console.log(`Lighthouse ${name} stopped`)
})

manager.on('lighthouse:error', ({ name, error }) => {
  console.error(`Lighthouse ${name} error: ${error}`)
})

manager.on('lighthouse:health-changed', ({ name, healthy }) => {
  console.log(`Lighthouse ${name} health: ${healthy ? 'OK' : 'FAILING'}`)
})
```

---

## Configuration Reference

### NebulaMeshConfig

```typescript
interface NebulaMeshConfig {
  // Identity
  peerId: string                    // Unique peer identifier
  nebulaIp: string                  // Nebula IP address (e.g., '10.42.0.10')

  // Network
  port?: number                     // TCP port (default: 7946)
  peers?: PeerConfig[]              // Known peers

  // Hub
  hub?: {
    role: HubRole                   // ADMIN | CANDIDATE | OBSERVER
    priority?: number               // Lower = higher priority
  }
}
```

### YjsSyncConfig

```typescript
interface YjsSyncConfig {
  namespace: string                 // Document namespace
  throttleMs?: number               // Update throttle (default: 50)
}
```

### MessageChannelConfig

```typescript
interface MessageChannelConfig {
  queue?: {
    enabled?: boolean               // Enable offline queue
    maxSize?: number                // Max queued messages (default: 1000)
    ttl?: number                    // Message TTL in ms (default: 86400000)
  }
}
```

### CertManagerConfig

```typescript
interface CertManagerConfig {
  certsDir: string                  // Directory for certificates
  autoRenewal?: {
    enabled?: boolean               // Enable auto-renewal monitoring
    checkInterval?: number          // Check interval in ms
    renewBeforeDays?: number        // Renew this many days before expiry
  }
}
```

### LighthouseManagerConfig

```typescript
interface LighthouseManagerConfig {
  lighthousesDir: string            // Directory for lighthouse configs
  healthCheckInterval?: number      // Health check interval in ms
}
```

---

## Integrations

### SudocodeMeshService

agentic-mesh includes a pre-built integration for syncing sudocode entities:

```typescript
import { SudocodeMeshService } from 'agentic-mesh'

const service = new SudocodeMeshService({
  projectId: 'my-project',
  projectPath: './.sudocode',
  meshConfig: {
    peerId: 'alice',
    nebulaIp: '10.42.0.10',
    peers: [{ id: 'bob', nebulaIp: '10.42.0.11' }],
  },
})

await service.start()

// Entities sync automatically between peers
// specs.jsonl and issues.jsonl stay in sync

// Remote execution
await service.requestExecution('bob', {
  issueId: 'i-abc123',
  agentType: 'claude-code',
})

await service.stop()
```

See [mesh-integration.md](./mesh-integration.md) for detailed sudocode integration documentation.

---

## Troubleshooting

### Verify Setup

```bash
npx agentic-mesh doctor
```

This checks:
- Nebula binaries are installed
- Certificates directory is writable
- Existing certificates are valid

### Common Issues

**"nebula-cert not found"**
- Install Nebula: `brew install nebula` or download from GitHub releases

**"Connection refused"**
- Verify Nebula is running: `sudo nebula -config nebula.yaml`
- Check firewall allows UDP port 4242

**"Certificate expired"**
- Renew certificate: `npx agentic-mesh cert renew --name <name>`

**"Peers not syncing"**
- Verify all peers use certificates signed by the same CA
- Check namespace matches across all peers
- Verify Nebula connectivity: `ping <peer-nebula-ip>`

### Debug Logging

```typescript
// Enable debug output
process.env.DEBUG = 'agentic-mesh:*'
```
