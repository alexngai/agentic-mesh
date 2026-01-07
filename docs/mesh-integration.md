# sudocode Mesh Integration

This document describes how sudocode integrates with the `agentic-mesh` library to enable P2P synchronization between distributed sudocode servers.

## Overview

sudocode uses `agentic-mesh` to provide:

- **Real-time sync** of specs, issues, relationships, and feedback between servers
- **Remote execution** - trigger agent runs on remote machines
- **Resource scaling** - offload work to cloud VMs or powerful workstations
- **Offline resilience** - work offline, sync when reconnected

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              sudocode                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      SudocodeMeshService                              │  │
│  │                                                                       │  │
│  │  • Consumes agentic-mesh library                                      │  │
│  │  • Defines sudocode CRDT schema                                       │  │
│  │  • Handles CRDT ↔ JSONL sync                                          │  │
│  │  • Implements "git wins" reconciliation                               │  │
│  │  • Routes executions between peers                                    │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                      │                                      │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        agentic-mesh                                   │  │
│  │                                                                       │  │
│  │  • NebulaMesh - peer connectivity                                     │  │
│  │  • NebulaSyncProvider - Yjs sync                                      │  │
│  │  • MessageChannel - P2P messaging                                     │  │
│  │  • CertManager - certificate ops                                      │  │
│  │                                                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Model Mapping

### CRDT Schema

sudocode entities map to Yjs structures:

```typescript
// One Y.Doc per project
const projectDoc = new Y.Doc()

// Entity collections
const specs = projectDoc.getMap('specs')              // Map<specId, SpecData>
const issues = projectDoc.getMap('issues')            // Map<issueId, IssueData>
const relationships = projectDoc.getArray('rels')     // Array<Relationship>
const feedback = projectDoc.getArray('feedback')      // Array<Feedback>

// Metadata
const meta = projectDoc.getMap('meta')
meta.set('projectId', 'sudocode-a1b2c3d4')
meta.set('schemaVersion', 1)
```

### Entity Structures

```typescript
// Spec (stored in specs Map)
interface SpecCRDT {
  id: string                    // e.g., 's-abc123'
  uuid: string                  // UUID for deduplication
  title: Y.Text                 // Collaborative text
  content: Y.Text               // Collaborative markdown
  priority: number              // 0-4
  tags: Y.Array<string>
  created_at: string            // ISO timestamp
  updated_at: string            // ISO timestamp
  _origin: {                    // Provenance tracking
    peer: string                // Which peer created/modified
    gitRef: string              // e.g., 'main@abc123'
  }
}

// Issue (stored in issues Map)
interface IssueCRDT {
  id: string                    // e.g., 'i-xyz789'
  uuid: string
  title: string                 // Atomic (not collaborative)
  description: Y.Text           // Collaborative
  status: string                // 'open' | 'in_progress' | 'blocked' | 'closed'
  priority: number
  tags: Y.Array<string>
  parent?: string               // Parent issue ID
  archived: boolean
  created_at: string
  updated_at: string
  _origin: { peer: string, gitRef: string }
}

// Relationship (in relationships Array)
interface RelationshipCRDT {
  id: string
  uuid: string
  from_id: string
  to_id: string
  type: string                  // 'blocks' | 'implements' | 'depends-on' | ...
  created_at: string
  _deleted?: boolean            // Tombstone for soft delete
}

// Feedback (in feedback Array)
interface FeedbackCRDT {
  id: string
  uuid: string
  from_id: string               // Issue providing feedback
  to_id: string                 // Spec or issue receiving feedback
  type: string                  // 'comment' | 'suggestion' | 'request'
  content: string
  anchor?: {                    // Location anchor
    line?: number
    text?: string
    section?: string
  }
  status: string                // 'valid' | 'relocated' | 'stale'
  created_at: string
  _deleted?: boolean
}
```

---

## Sync Architecture

### Three-Layer Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CRDT Layer (Real-time)                              │
│                                                                             │
│  • Yjs document synced via agentic-mesh                                     │
│  • Eventual consistency across online peers                                 │
│  • Handles concurrent edits automatically                                   │
│  • Ephemeral - rebuilt from git on pull                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                              (sync on change)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        JSONL Layer (Persistent)                             │
│                                                                             │
│  • specs.jsonl, issues.jsonl in .sudocode/                                  │
│  • Source of truth for sudocode                                             │
│  • Git-tracked, mergeable                                                   │
│  • Updated from CRDT changes                                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                            (git push/pull)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Git Layer (Distributed)                            │
│                                                                             │
│  • Each peer manages own git state                                          │
│  • Peers may be on different branches/commits                               │
│  • Git pull → rebuild CRDT from JSONL (git wins)                            │
│  • Standard git merge for conflicts                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Sync Rules

| Event | Action |
|-------|--------|
| Local CRDT change | Write to JSONL (debounced) |
| Remote CRDT update | Apply to CRDT → Write to JSONL |
| Git pull | Rebuild CRDT from JSONL (git wins) |
| Git push | CRDT → JSONL already synced; push as normal |

### "Git Wins" Reconciliation

When git state and CRDT state diverge (e.g., after `git pull`):

```typescript
async function onGitPull() {
  // 1. Read fresh JSONL from disk
  const specs = await readJsonl('.sudocode/specs.jsonl')
  const issues = await readJsonl('.sudocode/issues.jsonl')

  // 2. Rebuild CRDT from JSONL
  doc.transact(() => {
    // Clear existing CRDT state
    doc.getMap('specs').clear()
    doc.getMap('issues').clear()

    // Populate from JSONL
    for (const spec of specs) {
      doc.getMap('specs').set(spec.id, specToYjs(spec))
    }
    for (const issue of issues) {
      doc.getMap('issues').set(issue.id, issueToYjs(issue))
    }
  }, 'git-pull')  // Origin marker

  // 3. CRDT updates broadcast to peers automatically
  // Peers will converge to git state
}
```

### CRDT Over Divergent Git

Peers can be on different git commits/branches. CRDT syncs working state regardless:

```
alex-laptop              alex-cloud              ci-runner
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│ main @ abc123 │       │ main @ def456 │       │ feature @ ghi │
│ 5 specs       │       │ 7 specs       │       │ 6 specs       │
└───────┬───────┘       └───────┬───────┘       └───────┬───────┘
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │     CRDT (merged)     │
                    │                       │
                    │ All uncommitted edits │
                    │ visible across peers  │
                    └───────────────────────┘
```

---

## Execution Routing

### Message Types

```typescript
interface SudocodeMessages {
  // Execution lifecycle
  'exec:request': {
    issueId: string
    agentType: 'claude-code' | 'codex' | 'copilot' | 'cursor'
    agentConfig?: any
    prompt?: string
  }
  'exec:accepted': {
    executionId: string
    estimatedStart?: Date
  }
  'exec:rejected': {
    reason: string
    suggestion?: string
  }
  'exec:status': {
    executionId: string
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed'
    progress?: number
  }
  'exec:complete': {
    executionId: string
    result: 'success' | 'failure'
    changedFiles?: string[]
    error?: string
  }

  // Execution control
  'exec:stop': {
    executionId: string
    reason?: string
  }

  // Log streaming (separate from CRDT)
  'exec:log': {
    executionId: string
    chunk: string
    timestamp: Date
  }
}
```

### Routing Model

Executions are **explicitly routed** by the user:

```typescript
// Default: run locally
await executionService.start({
  issueId: 'i-abc123',
  agentType: 'claude-code',
})

// Explicit remote execution
await executionService.start({
  issueId: 'i-abc123',
  agentType: 'claude-code',
  targetPeer: 'cloud-vm',  // Route to specific peer
})
```

### Remote Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Remote Execution Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. User: sudocode exec start i-abc123 --peer cloud-vm                      │
│                                                                             │
│  2. Local server sends exec:request to cloud-vm                             │
│     ┌─────────┐                              ┌─────────┐                    │
│     │  local  │ ── exec:request ──────────►  │cloud-vm │                    │
│     └─────────┘                              └─────────┘                    │
│                                                                             │
│  3. cloud-vm validates and accepts                                          │
│     ┌─────────┐                              ┌─────────┐                    │
│     │  local  │ ◄── exec:accepted ────────── │cloud-vm │                    │
│     └─────────┘                              └─────────┘                    │
│                                                                             │
│  4. cloud-vm runs execution, streams status                                 │
│     ┌─────────┐                              ┌─────────┐                    │
│     │  local  │ ◄── exec:status ──────────── │cloud-vm │                    │
│     │         │ ◄── exec:log ────────────────│         │                    │
│     └─────────┘                              └─────────┘                    │
│                                                                             │
│  5. Execution completes                                                     │
│     ┌─────────┐                              ┌─────────┐                    │
│     │  local  │ ◄── exec:complete ────────── │cloud-vm │                    │
│     └─────────┘                              └─────────┘                    │
│                                                                             │
│  6. Code changes sync via git (user pushes/pulls)                           │
│     Entity changes sync via CRDT (automatic)                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Capability Matching

Before routing, check peer capabilities:

```typescript
function canExecute(peer: PeerInfo, agentType: string): boolean {
  // Check certificate groups
  if (!peer.groups.includes('executor')) return false

  // Check agent availability (via peer metadata)
  const metadata = peerMetadata.get(peer.id)
  return metadata?.agents?.includes(agentType) ?? false
}
```

---

## Implementation

### SudocodeMeshService

```typescript
// server/src/services/mesh-service.ts
import { NebulaMesh, NebulaSyncProvider, MessageChannel } from 'agentic-mesh'
import * as Y from 'yjs'

export class SudocodeMeshService {
  private mesh: NebulaMesh
  private provider: NebulaSyncProvider
  private doc: Y.Doc
  private channel: MessageChannel<SudocodeMessages>

  private specsMap: Y.Map<any>
  private issuesMap: Y.Map<any>
  private relsArray: Y.Array<any>
  private feedbackArray: Y.Array<any>

  async init(projectId: string, config: MeshConfig) {
    // Initialize mesh connection
    this.mesh = new NebulaMesh({
      name: config.serverName,
      certPath: config.certPath,
      keyPath: config.keyPath,
      caPath: config.caPath,
      lighthouse: config.lighthouse,
      hub: config.hub,
      permissionChecker: this.checkPermission.bind(this),
    })

    // Setup CRDT document
    this.doc = new Y.Doc()
    this.setupSchema()

    // Attach sync provider
    this.provider = new NebulaSyncProvider(this.doc, this.mesh, {
      namespace: projectId,
      snapshotPath: '.sudocode/mesh/snapshots/',
      snapshotInterval: 60_000,
    })

    // Setup message channel for execution routing
    this.channel = this.mesh.createChannel<SudocodeMessages>('sudocode', {
      queuePath: '.sudocode/mesh/queue.json',
    })
    this.setupMessageHandlers()

    // Wire CRDT changes to JSONL
    this.setupJsonlSync()

    // Start mesh
    await this.mesh.start()

    // Wait for initial sync
    await new Promise<void>(resolve => {
      if (this.provider.synced) resolve()
      else this.provider.once('synced', resolve)
    })
  }

  private setupSchema() {
    this.specsMap = this.doc.getMap('specs')
    this.issuesMap = this.doc.getMap('issues')
    this.relsArray = this.doc.getArray('rels')
    this.feedbackArray = this.doc.getArray('feedback')

    const meta = this.doc.getMap('meta')
    meta.set('schemaVersion', 1)
  }

  private setupJsonlSync() {
    // Debounced sync to JSONL
    let syncTimeout: NodeJS.Timeout | null = null

    this.doc.on('update', (update, origin) => {
      // Skip if update came from JSONL load
      if (origin === 'jsonl-load') return

      // Debounce writes
      if (syncTimeout) clearTimeout(syncTimeout)
      syncTimeout = setTimeout(() => {
        this.syncToJsonl()
      }, 100)
    })
  }

  private async syncToJsonl() {
    // Convert CRDT to JSONL format
    const specs = Array.from(this.specsMap.entries()).map(([id, data]) =>
      yjsToSpec(id, data)
    )
    const issues = Array.from(this.issuesMap.entries()).map(([id, data]) =>
      yjsToIssue(id, data)
    )

    // Write atomically
    await writeJsonl('.sudocode/specs.jsonl', specs)
    await writeJsonl('.sudocode/issues.jsonl', issues)
  }

  async loadFromJsonl() {
    const specs = await readJsonl('.sudocode/specs.jsonl')
    const issues = await readJsonl('.sudocode/issues.jsonl')

    this.doc.transact(() => {
      this.specsMap.clear()
      this.issuesMap.clear()

      for (const spec of specs) {
        this.specsMap.set(spec.id, specToYjs(spec))
      }
      for (const issue of issues) {
        this.issuesMap.set(issue.id, issueToYjs(issue))
      }
    }, 'jsonl-load')
  }

  private setupMessageHandlers() {
    // Handle incoming execution requests
    this.channel.handle('exec:request', async (from, payload) => {
      const canRun = await this.canRunExecution(from, payload)

      if (!canRun.ok) {
        return { type: 'exec:rejected', reason: canRun.reason }
      }

      const executionId = await this.startLocalExecution(payload)
      return { type: 'exec:accepted', executionId }
    })

    // Handle stop requests
    this.channel.on('exec:stop', async (from, payload) => {
      await this.stopExecution(payload.executionId, from)
    })
  }

  // Public API for remote execution
  async requestRemoteExecution(
    peerId: string,
    request: SudocodeMessages['exec:request']
  ): Promise<string> {
    const response = await this.channel.request(peerId, 'exec:request', request, {
      timeout: 30_000,
    })

    if (response.type === 'exec:rejected') {
      throw new Error(`Execution rejected: ${response.reason}`)
    }

    return response.executionId
  }

  // Permission checker for agentic-mesh
  private checkPermission(peer: PeerInfo, action: string): boolean {
    const groups = peer.groups

    // Admin can do anything
    if (groups.includes('admin')) return true

    switch (action) {
      case 'crdt:read':
        return true  // All tiers can read
      case 'crdt:write':
        return groups.includes('developer') || groups.includes('admin')
      case 'exec:trigger':
      case 'exec:receive':
        return groups.includes('developer') && groups.includes('executor')
      default:
        return false
    }
  }
}
```

### CLI Integration

```typescript
// cli/src/commands/mesh.ts
import { Command } from 'commander'
import { commands as meshCommands } from 'agentic-mesh/cli'

export function createMeshCommand(): Command {
  const mesh = new Command('mesh')
    .description('Manage P2P mesh network')

  // Use agentic-mesh CLI helpers
  mesh.addCommand(meshCommands.init({
    configDir: '~/.config/sudocode/mesh',
    projectDir: '.sudocode/mesh',
  }))

  mesh.addCommand(meshCommands.join({
    configDir: '~/.config/sudocode/mesh',
    projectDir: '.sudocode/mesh',
  }))

  mesh.addCommand(meshCommands.peers())
  mesh.addCommand(meshCommands.status())
  mesh.addCommand(meshCommands.hub())

  return mesh
}

// Execution command with --peer flag
export function createExecCommand(): Command {
  return new Command('exec')
    .command('start <issueId>')
    .option('--agent <type>', 'Agent type', 'claude-code')
    .option('--peer <peerId>', 'Run on remote peer')
    .action(async (issueId, options) => {
      const meshService = getMeshService()

      if (options.peer) {
        // Remote execution
        const execId = await meshService.requestRemoteExecution(
          options.peer,
          { issueId, agentType: options.agent }
        )
        console.log(`Execution ${execId} started on ${options.peer}`)
      } else {
        // Local execution
        const execId = await executionService.start({ issueId, agentType: options.agent })
        console.log(`Execution ${execId} started locally`)
      }
    })
}
```

---

## Configuration

### Mesh Config

```yaml
# .sudocode/mesh/config.yaml
mesh:
  name: "alex-laptop"

nebula:
  lighthouse:
    - "lighthouse.example.com:4242"
  listenPort: 4242

hub:
  priorityList:
    - "dedicated-server"
    - "alex-cloud"
  relay:
    forwardUpdates: true
    proxyMessages: true

sync:
  throttleMs: 100
  snapshotInterval: 60000

queue:
  maxSize: 1000
  defaultTtl: 86400000
```

### Permission Tiers

| Tier | Groups | Capabilities |
|------|--------|--------------|
| Admin | `admin` | Full access |
| Developer | `developer`, `executor` | Read, write, execute |
| Read-only | `read-only` | Read specs/issues only |

---

## Storage Layout

```
~/.config/sudocode/mesh/          # User-level
├── ca.crt                        # Root CA cert
├── user.crt                      # User sub-CA cert
├── user.key                      # User sub-CA key
└── known_peers.json              # Peer cache

.sudocode/                        # Project-level
├── specs.jsonl                   # Source of truth
├── issues.jsonl                  # Source of truth
├── mesh/                         # Mesh-specific
│   ├── server.crt                # Server certificate
│   ├── server.key                # Server private key
│   ├── nebula.yaml               # Nebula config
│   ├── config.yaml               # Mesh config
│   ├── snapshots/                # CRDT snapshots
│   │   └── <projectId>.snapshot
│   └── queue.json                # Offline queue
└── cache.db                      # SQLite (gitignored)
```

---

## Error Handling

```typescript
import { MeshError, ConnectionError, SyncError } from 'agentic-mesh'

async function withMeshErrorHandling<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (e) {
    if (e instanceof ConnectionError) {
      console.error(`Connection failed: ${e.message}`)
      // Offer to run locally instead
    } else if (e instanceof SyncError) {
      console.error(`Sync failed: ${e.message}`)
      // Continue with stale data, retry later
    } else {
      throw e
    }
  }
}
```

---

## Future Considerations

### Planned Enhancements

- **Execution log streaming** via WebSocket proxy
- **Agent capability discovery** (query peer for available agents)
- **Execution migration** (move running execution between peers)
- **Auto git sync** (optional, trigger push/pull on sync events)

### Deferred

- **Slack integration** (trigger executions from Slack)
- **Webhook gateway** (external triggers)
- **Load balancing** (availability pools)
