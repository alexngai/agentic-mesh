# agentic-mesh

P2P CRDT synchronization library over Nebula mesh networks.

## Overview

agentic-mesh provides infrastructure for peer-to-peer state synchronization using CRDTs (Conflict-free Replicated Data Types) over encrypted Nebula tunnels. It handles peer discovery, connection management, real-time sync, and offline message queuing.

**Key components:**

- **NebulaMesh** - Peer connectivity and connection management over Nebula networks
- **YjsSyncProvider** - CRDT synchronization using Yjs
- **MessageChannel** - Typed pub/sub and RPC messaging between peers
- **CertManager** - Nebula certificate lifecycle management
- **LighthouseManager** - Nebula lighthouse process management

## Prerequisites

agentic-mesh requires [Nebula](https://github.com/slackhq/nebula) to be installed:

```bash
# macOS
brew install nebula

# Linux
curl -LO https://github.com/slackhq/nebula/releases/latest/download/nebula-linux-amd64.tar.gz
tar xzf nebula-linux-amd64.tar.gz
sudo mv nebula nebula-cert /usr/local/bin/

# Verify installation
nebula-cert -version
```

## Installation

```bash
npm install agentic-mesh
```

## Quick Start

### 1. Create certificates

```bash
# Create a root CA
npx agentic-mesh cert create-ca --name my-mesh

# Sign certificates for each peer
npx agentic-mesh cert sign --name alice --ca my-mesh --ip 10.42.0.10/24
npx agentic-mesh cert sign --name bob --ca my-mesh --ip 10.42.0.11/24
```

### 2. Generate Nebula configs

```bash
# Generate peer config
npx agentic-mesh config generate \
  --ca-cert ./certs/my-mesh.crt \
  --cert ./certs/alice.crt \
  --key ./certs/alice.key \
  --lighthouses "10.42.0.1=lighthouse.example.com:4242" \
  --output nebula.yaml
```

### 3. Connect and sync

```typescript
import { NebulaMesh, YjsSyncProvider } from 'agentic-mesh'

// Create mesh connection
const mesh = new NebulaMesh({
  peerId: 'alice',
  nebulaIp: '10.42.0.10',
  port: 7946,
  peers: [{ id: 'bob', nebulaIp: '10.42.0.11' }],
})

await mesh.connect()

// Create sync provider
const provider = new YjsSyncProvider(mesh, { namespace: 'my-project' })
await provider.start()

// Get a shared map (syncs automatically)
const shared = provider.getMap<string>('config')
shared.set('version', '1.0.0')

// Listen for changes from other peers
shared.observe((event) => {
  console.log('Data changed:', Object.fromEntries(shared.entries()))
})
```

### 4. Send messages between peers

```typescript
import { MessageChannel } from 'agentic-mesh'

// Create typed channel
interface MyMessages {
  'task:run': { taskId: string }
  'task:result': { taskId: string; output: string }
}

const channel = mesh.createChannel<MyMessages>('tasks')

// Send message
await channel.send('bob', 'task:run', { taskId: '123' })

// Handle incoming messages
channel.on('task:run', (from, payload) => {
  console.log(`Task ${payload.taskId} requested by ${from}`)
})

// Request/response pattern
const result = await channel.request('bob', 'task:run', { taskId: '456' })
```

## CLI Reference

```bash
# Certificate management
agentic-mesh cert create-ca --name <name>
agentic-mesh cert create-user-ca --name <name> --root-ca <ca>
agentic-mesh cert sign --name <name> --ca <ca> --ip <nebula-ip>
agentic-mesh cert renew --name <name>
agentic-mesh cert revoke --name <name>
agentic-mesh cert list
agentic-mesh cert verify --name <name>
agentic-mesh cert info --name <name>

# Configuration generation
agentic-mesh config generate --ca-cert <path> --cert <path> --key <path> --lighthouses <list>
agentic-mesh config generate-lighthouse --ca-cert <path> --cert <path> --key <path> --ip <ip>

# Lighthouse management
agentic-mesh lighthouse create --name <name> --ip <ip> --endpoint <endpoint> ...
agentic-mesh lighthouse start --name <name>
agentic-mesh lighthouse stop --name <name>
agentic-mesh lighthouse status --name <name>
agentic-mesh lighthouse list

# Diagnostics
agentic-mesh doctor
```

## API Overview

### NebulaMesh

Core mesh connectivity:

```typescript
const mesh = new NebulaMesh(config)

await mesh.connect()
await mesh.disconnect()

mesh.getPeers()           // List connected peers
mesh.getPeer(id)          // Get specific peer
mesh.isHub()              // Check if this node is the hub
mesh.createChannel(name)  // Create message channel

mesh.on('peer:joined', handler)
mesh.on('peer:left', handler)
mesh.on('hub:changed', handler)
```

### YjsSyncProvider

CRDT synchronization:

```typescript
const provider = new YjsSyncProvider(mesh, { namespace: 'project' })

await provider.start()
await provider.stop()

provider.getMap(name)     // Get Y.Map
provider.getArray(name)   // Get Y.Array
provider.getText(name)    // Get Y.Text
provider.getDoc()         // Get underlying Y.Doc

provider.on('synced', handler)
provider.on('peer:synced', handler)
```

### MessageChannel

Peer-to-peer messaging:

```typescript
const channel = mesh.createChannel<Messages>('channel-name')

await channel.send(peerId, type, payload)
channel.broadcast(type, payload)
const response = await channel.request(peerId, type, payload, { timeout: 5000 })

channel.on(type, handler)
channel.handle(type, asyncHandler)  // For request/response
```

### CertManager

Certificate operations:

```typescript
const certManager = new CertManager({ certsDir: './certs' })
await certManager.initialize()

await certManager.createRootCA({ name, duration, groups })
await certManager.createUserCA({ name, rootCAName, duration, groups })
await certManager.signServerCert({ name, caName, nebulaIp, duration, groups })
await certManager.renewServerCert(name)
await certManager.revokeCert(name, reason)

certManager.listCertificates()
certManager.getCertificate(name)
await certManager.verifyCert(name)
```

## Documentation

- [Usage Guide](./docs/USAGE.md) - Detailed setup and API documentation
- [Architecture](./docs/agentic-mesh.md) - Design decisions and architecture overview
- [Sudocode Integration](./docs/mesh-integration.md) - Example integration with sudocode

## License

MIT
