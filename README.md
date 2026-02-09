# agentic-mesh

Transport coordination and configuration layer for multi-agent systems over encrypted mesh networks.

## Overview

agentic-mesh provides the networking infrastructure for distributed multi-agent systems. It handles encrypted peer-to-peer connectivity, agent protocol integration, message routing, and state synchronization — so agent frameworks can focus on orchestration logic rather than transport concerns.

**Used by [multi-agent-protocol](https://github.com/multi-agent-protocol/multi-agent-protocol)** as the P2P transport layer for MAP clients, agents, and peers.

**Key capabilities:**

- **Pluggable transports** — Nebula, Tailscale, and Headscale backends via a unified `TransportAdapter` interface
- **Agent protocol support** — Built-in [ACP](https://github.com/anthropics/agent-control-protocol) (Agent Control Protocol) and [MAP](https://github.com/multi-agent-protocol/multi-agent-protocol) (Multi-Agent Protocol) integration
- **Git over mesh** — `git-remote-mesh://` protocol for repository sync over encrypted tunnels
- **CRDT synchronization** — Yjs (in-memory) and cr-sqlite (SQLite) sync providers
- **Typed messaging** — Pub/sub and RPC channels with offline queuing
- **Certificate management** — Nebula PKI lifecycle, lighthouse management

## Installation

```bash
npm install agentic-mesh
```

For Nebula transport, install [Nebula](https://github.com/slackhq/nebula):

```bash
# macOS
brew install nebula

# Linux
curl -LO https://github.com/slackhq/nebula/releases/latest/download/nebula-linux-amd64.tar.gz
tar xzf nebula-linux-amd64.tar.gz
sudo mv nebula nebula-cert /usr/local/bin/
```

## Quick Start

### As a transport layer for MAP

agentic-mesh is used by the [multi-agent-protocol SDK](https://github.com/multi-agent-protocol/multi-agent-protocol) to provide encrypted mesh connectivity:

```typescript
import { ClientConnection } from '@multi-agent-protocol/sdk'

// Connect a MAP client over an encrypted mesh transport
const client = await ClientConnection.connectMesh({
  transport,
  peer: { peerId: 'server', address: '10.0.0.1', port: 4242 },
  localPeerId: 'my-client',
  name: 'MeshClient',
  reconnection: true,
})

// Use the MAP protocol normally
const agents = await client.listAgents()
```

### As a standalone mesh

```typescript
import { NebulaMesh, YjsSyncProvider, MessageChannel } from 'agentic-mesh'

// Create mesh connection
const mesh = new NebulaMesh({
  peerId: 'alice',
  nebulaIp: '10.42.0.10',
  port: 7946,
  peers: [{ id: 'bob', nebulaIp: '10.42.0.11' }],
})

await mesh.connect()

// Sync state with CRDT
const provider = new YjsSyncProvider(mesh, { namespace: 'my-project' })
await provider.start()

const shared = provider.getMap<string>('config')
shared.set('version', '1.0.0')

// Send typed messages between peers
const channel = mesh.createChannel<MyMessages>('tasks')
await channel.send('bob', 'task:run', { taskId: '123' })
const result = await channel.request('bob', 'task:run', { taskId: '456' })
```

### ACP over mesh

Bridge Agent Control Protocol sessions over the mesh:

```typescript
import { AcpMeshAdapter, meshStream } from 'agentic-mesh'
import { AgentSideConnection } from '@agentclientprotocol/sdk'

// Create an ACP-compatible stream over mesh
const stream = meshStream(mesh, { peerId: 'client-peer' })
const connection = new AgentSideConnection(
  (conn) => new MyAcpAgent(conn),
  stream
)
```

### Git over mesh

Clone and push repositories over encrypted tunnels:

```bash
git clone git-remote-mesh://peer-id/repository
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         agentic-mesh                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │   MAP    │  │   ACP    │  │   Sync   │  │     Channel      │  │
│  │  Server  │  │ Adapter  │  │ Provider │  │   (Pub/Sub/RPC)  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬──────────┘  │
│       └──────────────┴─────────────┴────────────────┘              │
│                              │                                     │
│                     ┌────────┴────────┐                            │
│  ┌──────────────┐   │   MeshContext   │   ┌──────────────┐        │
│  │ CertManager  │   │   Interface     │   │ Git Transport│        │
│  │ + Lighthouse │   └────────┬────────┘   │              │        │
│  └──────────────┘            │            └──────────────┘        │
│                     ┌────────┴────────┐                            │
│                     │ TransportAdapter │                            │
│                     └──┬──────┬──────┬┘                            │
│                        │      │      │                             │
│                   Nebula  Tailscale  Headscale                     │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
                             │
                    Encrypted P2P Tunnels
```

### Transport Abstraction

The `TransportAdapter` interface supports multiple encrypted transport backends:

| Transport | Best For | Setup |
|-----------|----------|-------|
| **Nebula** | Air-gapped, enterprise, full control | Self-hosted CA + lighthouses |
| **Tailscale** | Quick dev/testing, zero-config | Install + login |
| **Headscale** | Self-hosted alternative to Tailscale | Self-hosted coordination server |

```typescript
// Nebula transport
const mesh = new NebulaMesh({
  peerId: 'peer-1',
  nebulaIp: '10.42.0.10',
  port: 7946,
  peers: [{ id: 'peer-2', nebulaIp: '10.42.0.11' }],
})

// Transport features are configurable
const mesh = new NebulaMesh({
  // ...
  features: {
    hubElection: true,
    healthMonitoring: 'transport',
    namespaceRegistry: true,
    offlineQueue: true,
  },
})
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

### AcpMeshAdapter

Bridge ACP protocol over mesh:

```typescript
const adapter = new AcpMeshAdapter(mesh)
await adapter.start()

adapter.onRequest(async (request, from, respond) => {
  const response = await server.handleRequest(request)
  respond(response)
})

await adapter.request(peerId, acpRequest, timeout)
adapter.broadcast(notification)
```

### MapServer

Multi-Agent Protocol server for agent orchestration:

```typescript
const mapServer = new MapServer({
  systemId: 'my-system',
  federation: { enabled: true },
})
```

### YjsSyncProvider

CRDT synchronization:

```typescript
const provider = new YjsSyncProvider(mesh, { namespace: 'project' })
await provider.start()

provider.getMap(name)     // Get Y.Map
provider.getArray(name)   // Get Y.Array
provider.getText(name)    // Get Y.Text
provider.getDoc()         // Get underlying Y.Doc
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
await certManager.signServerCert({ name, caName, nebulaIp, duration, groups })
```

## CLI Reference

```bash
# Certificate management
agentic-mesh cert create-ca --name <name>
agentic-mesh cert sign --name <name> --ca <ca> --ip <nebula-ip>
agentic-mesh cert list
agentic-mesh cert verify --name <name>
agentic-mesh cert renew --name <name>
agentic-mesh cert revoke --name <name>

# Configuration generation
agentic-mesh config generate --ca-cert <path> --cert <path> --key <path> --lighthouses <list>

# Lighthouse management
agentic-mesh lighthouse create --name <name> --ip <ip> --endpoint <endpoint>
agentic-mesh lighthouse start --name <name>
agentic-mesh lighthouse stop --name <name>
agentic-mesh lighthouse status --name <name>

# Diagnostics
agentic-mesh doctor
```

## Documentation

- [Usage Guide](./docs/USAGE.md) — Detailed setup and API documentation
- [Architecture](./docs/agentic-mesh.md) — Design decisions and architecture overview
- [Transport Design](./docs/pluggable-transport-plan.md) — Pluggable transport abstraction
- [Transport Evaluation](./docs/tailscale-headscale-evaluation.md) — Nebula vs Tailscale vs Headscale
- [Integration Example](./docs/mesh-integration.md) — Sudocode integration patterns

## License

MIT
