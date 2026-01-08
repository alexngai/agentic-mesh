# agentic-mesh Usage Guide

This guide covers setup, configuration, and API usage for agentic-mesh.

## Table of Contents

- [Installation](#installation)
- [Nebula Setup](#nebula-setup)
- [Certificate Management](#certificate-management)
- [NebulaMesh API](#nebulamesh-api)
- [CRDT Synchronization](#crdt-synchronization)
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
