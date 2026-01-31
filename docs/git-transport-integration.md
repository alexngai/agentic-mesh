# Git Transport Integration Guide

This guide explains how git transport is integrated with agentic-mesh and how to use it from the MAP side.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ MAP Client/Agent                                                 │
│                                                                  │
│  Option A: CLI                    Option B: Programmatic         │
│  ─────────────────                ───────────────────────        │
│  git fetch mesh://peer-b/         client.sync('peer-b')          │
│         │                                │                       │
│         ▼                                ▼                       │
│  git-remote-mesh helper           GitSyncClient                  │
│         │                                │                       │
│         └────────────┬───────────────────┘                       │
│                      ▼                                           │
│         GitTransportService (HTTP :3456)                         │
│                      │                                           │
│                      ▼                                           │
│         MeshPeer.sendGitMessage()                                │
│                      │                                           │
│                      ▼                                           │
│         PeerConnection.sendGitMessage()                          │
└──────────────────────┬───────────────────────────────────────────┘
                       │ MAP Protocol (NDJSON over transport)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Remote Peer                                                      │
│                                                                  │
│         PeerConnection receives 'git/message'                    │
│                      │                                           │
│                      ▼                                           │
│         MeshPeer.git:message event                               │
│                      │                                           │
│                      ▼                                           │
│         GitTransportService.handleRemoteMessage()                │
│                      │                                           │
│                      ▼                                           │
│         GitProtocolHandler (spawns native git)                   │
└──────────────────────────────────────────────────────────────────┘
```

## Key Integration Points

### 1. Enable Git in MeshPeer Config

**File:** `src/map/types.ts` (lines 45-52)

```typescript
const peer = createMeshPeer({
  peerId: 'my-agent',
  git: {
    enabled: true,
    httpPort: 3456,           // Port for git-remote-mesh helper
    repoPath: '/path/to/repo', // Default repo path
  },
})
```

### 2. Git Service Lifecycle

**File:** `src/map/mesh-peer.ts`

The git service is initialized in the constructor (lines 74-84) and started/stopped with the peer:

```typescript
// Start (line 170-173)
if (this.gitService) {
  this.gitService.setPeerSender(this.createGitPeerSender())
  await this.gitService.start()
}

// Stop (line 195-197)
if (this.gitService) {
  await this.gitService.stop()
}
```

### 3. Message Routing

**File:** `src/map/mesh-peer.ts` (lines 225-241)

Git messages are sent via `createGitPeerSender()`:

```typescript
private createGitPeerSender(): PeerMessageSender {
  return {
    sendToPeer: async (peerId: string, message: AnyGitMessage) => {
      const conn = this.peerConnections.get(peerId)
      if (!conn) throw new Error(`No connection to peer ${peerId}`)
      await conn.sendGitMessage(message)
    },
    isConnected: (peerId: string) => this.peerConnections.has(peerId),
  }
}
```

### 4. Receiving Git Messages

**File:** `src/map/mesh-peer.ts` (lines 354-359)

When a peer connection receives a git message, it's forwarded to the git service:

```typescript
conn.on('git:message', (gitMessage) => {
  if (this.gitService) {
    this.gitService.handleRemoteMessage(peerId, gitMessage)
  }
})
```

### 5. PeerConnection Git Support

**File:** `src/map/connection/peer.ts`

Git messages use a dedicated method type:

```typescript
const GIT_MESSAGE_METHOD = 'git/message' as const  // line 32

// Send (lines 224-232)
async sendGitMessage(message: AnyGitMessage): Promise<void> {
  await this.stream.notify(GIT_MESSAGE_METHOD, message)
}

// Receive (line 296)
this.emit('git:message', message)
```

## Usage from MAP Side

### Option A: Using GitSyncClient (Recommended)

```typescript
import { createMeshPeer } from 'agentic-mesh/map'

const peer = createMeshPeer({
  peerId: 'agent-a',
  git: { enabled: true, repoPath: '/my/repo' },
})

await peer.start()
await peer.connectToPeer('agent-b', endpoint)

// Create sync client
const client = peer.git!.createSyncClient('/my/repo')

// Sync operations
await client.sync('agent-b', { branch: 'main', bidirectional: true })
await client.pull('agent-b', 'main')
await client.push('agent-b', 'feature-branch')
await client.clone('agent-b', '/new/repo')
```

### Option B: Using Standard Git Commands

Requires `git-remote-mesh` in PATH:

```bash
# Install globally
npm install -g agentic-mesh

# Or add to PATH
export PATH="$PATH:./node_modules/.bin"

# Use mesh:// URLs
git remote add agent-b mesh://agent-b-id/
git fetch agent-b
git push agent-b main
```

### Option C: Direct Protocol Access

For low-level control:

```typescript
// List refs from remote peer
const refs = await peer.git!.protocolHandler.listRefs({
  refPrefix: 'refs/heads/',
})

// Fetch pack data
const pack = await peer.git!.protocolHandler.uploadPack({
  wants: ['abc123...'],
  haves: ['def456...'],
})
```

## Wire Protocol Messages

**File:** `src/git/types.ts`

| Message Type | Direction | Purpose |
|--------------|-----------|---------|
| `git/list-refs` | Request/Response | List remote refs |
| `git/upload-pack` | Request/Response | Fetch pack data |
| `git/receive-pack` | Request/Response | Push pack data |
| `git/pack-stream` | Notification | Start binary stream |
| `git/pack-chunk` | Notification | Stream chunk |
| `git/pack-complete` | Notification | End stream |
| `git/error` | Response | Error response |

## Binary Streaming

**File:** `src/git/transport-service.ts` (lines 451-465, 501-545)

Large packs (>1MB by default) are automatically streamed:

```typescript
// Config (lines 67-71)
streaming: {
  enabled: true,
  threshold: 1024 * 1024,  // 1MB
  chunkSize: 64 * 1024,    // 64KB chunks
}
```

Flow:
1. Response sent with `streaming: true`, no `packData`
2. `git/pack-stream` message initiates transfer
3. `git/pack-chunk` messages send data (base64 encoded)
4. `git/pack-complete` finalizes with checksum

## File Reference

| File | Purpose |
|------|---------|
| `src/git/types.ts` | Type definitions, message types |
| `src/git/protocol-handler.ts` | Native git operations |
| `src/git/transport-service.ts` | HTTP server + peer routing |
| `src/git/sync-client.ts` | High-level sync API |
| `src/git/pack-streamer.ts` | Binary streaming |
| `src/git/git-remote-mesh.ts` | CLI remote helper |
| `src/map/mesh-peer.ts` | MeshPeer integration |
| `src/map/connection/peer.ts` | Git message handling |

## Testing

```bash
# Unit tests
npm test -- git-transport

# Integration tests (requires git)
npm test -- tests/integration/git-transport

# All tests
npm test
```
