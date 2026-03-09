# MAP Mail for Agentic-Mesh: Design Document

## Problem Statement

The MAP (Multi-Agent Protocol) ecosystem defines a [mail protocol spec](https://github.com/multi-agent-protocol/multi-agent-protocol/blob/main/docs/10-mail-protocol.md) and has an in-memory reference implementation in the TS SDK. However, there is no **agent-facing, production-ready mail service** that:

1. Provides persistent storage (not just in-memory)
2. Works over encrypted mesh transport (agentic-mesh)
3. Offers the DX features agents actually need (inbox polling, search, file reservations)
4. Bridges the gap between MAP's protocol-level mail and the practical coordination patterns seen in projects like [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)

This document designs a system that combines MAP mail protocol compliance with the practical agent coordination features from mcp_agent_mail, running over agentic-mesh transport.

---

## Landscape Analysis

### What MAP Mail Already Defines (Protocol Layer)

The MAP spec defines mail as an **optional persistence layer** on top of `map/send`:

| Concept | Description |
|---------|-------------|
| **Conversations** | Containers for related interactions (types: `user-session`, `agent-task`, `multi-agent`, `mixed`) |
| **Turns** | Atomic units of conversation (content types: `text`, `data`, `event`, `reference`, `x-*`) |
| **Threads** | Focused sub-discussions within conversations |
| **Participants** | Agents with roles (`initiator`, `assistant`, `worker`, `observer`, `moderator`) and permissions |
| **Turn Interception** | `map/send` with `meta.mail` auto-records turns without agent changes |
| **Progressive Adoption** | Level 0 (unaware) through Level 4 (dashboard) — agents opt in incrementally |

**Protocol methods**: `mail/create`, `mail/get`, `mail/list`, `mail/close`, `mail/join`, `mail/leave`, `mail/invite`, `mail/turn`, `mail/turns/list`, `mail/thread/create`, `mail/thread/list`, `mail/summary`, `mail/replay`

**MAP SDK implementation**: The TS SDK has ~1,445 lines implementing `ConversationManager`, `TurnManager`, `ThreadManager` with in-memory stores and JSON-RPC handlers. Storage interfaces are defined but only in-memory implementations exist.

### What mcp_agent_mail Adds (Agent DX Layer)

mcp_agent_mail solves the practical coordination problem with features MAP mail doesn't address:

| Feature | Description | MAP Equivalent |
|---------|-------------|----------------|
| **Agent Identity** | Memorable names (e.g., "GreenCastle"), registration, directory | MAP agents have IDs but no memorable naming or directory |
| **Inbox/Outbox** | Per-agent inbox with read/ack state | MAP has `mail/turns/list` but no inbox abstraction |
| **File Reservations** | Advisory leases on file paths/globs to avoid conflicts | No MAP equivalent |
| **Search** | Full-text search across messages | No MAP equivalent |
| **Contact Policies** | `open`, `auto`, `contacts_only`, `block_all` | MAP has participant permissions but not contact policies |
| **Urgency/Priority** | Priority levels with urgent filtering | MAP has priority on messages |
| **Message Acknowledgment** | Explicit ack/read tracking | MAP has delivery acknowledgment but not read receipts |
| **Git-backed Audit** | Messages archived to git for human review | No MAP equivalent |
| **Project Scoping** | Messages scoped to projects (repositories) | MAP has scopes but not project-aware |
| **MCP Tool Interface** | Exposed as MCP tools for any agent to call | MAP uses JSON-RPC methods |

### What agentic-mesh Provides (Transport Layer)

agentic-mesh already has the infrastructure this system needs:

| Component | How It Helps |
|-----------|-------------|
| `MapServer` | Agent registry, scope management, event bus, message routing |
| `MessageChannel` | Typed pub/sub + RPC with offline queueing |
| `OfflineQueue` | Persistent message queueing with TTL, retry, per-peer flush |
| `TransportAdapter` | Encrypted tunnels (Nebula/Tailscale/Headscale) |
| `Address` system | 9+ addressing patterns including scope, role, federated |
| `EventBus` | Event subscription with filtering |
| `TunnelStream` | NDJSON framing over transport |

---

## Design Decision: Where Does This Live?

### Recommendation: New module in agentic-mesh (`src/map/mail/`)

**Rationale:**
- The MAP mail protocol is already part of the MAP spec that agentic-mesh implements
- agentic-mesh's `MapServer` is the natural host for mail method handlers
- The transport, offline queueing, and event infrastructure are all here
- The MAP TS SDK already has in-memory stores — we extend with persistent stores
- A separate repo would duplicate the transport/routing/event infrastructure

**What stays out:**
- The MCP tool interface (a thin adapter) should live in its own package or in the consumer project, since it's a protocol bridge concern
- Git-backed archival could be a separate optional module

### Alternative considered: Separate repo

A separate `map-agent-mail` package would make sense if:
- You want to use it without agentic-mesh transport (e.g., over plain WebSocket)
- You want it to be a standalone MCP server like mcp_agent_mail

This could work as a **layered approach**: core mail logic in a separate package, with agentic-mesh providing the transport adapter. But given that the MAP SDK already defines the mail interfaces, the real value-add is the persistent storage + agent DX layer, which integrates most naturally into agentic-mesh.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Agent-Facing Interfaces                          │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐    │
│  │  MCP Tools   │  │  MAP JSON-RPC│  │  CLI (agentic-mesh mail)   │    │
│  │  (adapter)   │  │  (native)    │  │                            │    │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬───────────────┘    │
│         │                 │                        │                    │
├─────────┴─────────────────┴────────────────────────┴────────────────────┤
│                     Mail Service Layer (NEW)                            │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    MailService                                   │    │
│  │  • Inbox/Outbox abstraction                                     │    │
│  │  • Agent directory with memorable names                         │    │
│  │  • Contact policies & permissions                               │    │
│  │  • Read/ack tracking                                            │    │
│  │  • Full-text search                                             │    │
│  │  • File reservation leases                                      │    │
│  │  • Priority & urgency                                           │    │
│  └──────────┬──────────────────────────────────────────────────────┘    │
│             │                                                           │
├─────────────┴───────────────────────────────────────────────────────────┤
│                   MAP Mail Protocol (EXISTING in SDK)                   │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────────┐         │
│  │ConversationManager│  │  TurnManager │  │  ThreadManager    │         │
│  └────────┬─────────┘  └──────┬───────┘  └────────┬──────────┘         │
│           │                   │                    │                     │
│  ┌────────┴───────────────────┴────────────────────┴──────────────┐     │
│  │                    Storage Layer (NEW)                          │     │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐    │     │
│  │  │ SQLite Store │  │ In-Memory    │  │ Git Archive        │    │     │
│  │  │ (default)    │  │ (testing)    │  │ (optional audit)   │    │     │
│  │  └─────────────┘  └──────────────┘  └────────────────────┘    │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                   agentic-mesh Infrastructure (EXISTING)                │
│                                                                         │
│  MapServer │ MessageRouter │ EventBus │ OfflineQueue │ TransportAdapter │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Persistent Storage (`src/map/mail/storage/`)

The MAP SDK defines store interfaces (`ConversationStore`, `TurnStore`, `ThreadStore`, `ParticipantStore`). We implement SQLite-backed versions.

```typescript
// Storage interface (already defined in MAP SDK)
interface ConversationStore {
  create(conversation: ServerConversation): Promise<ServerConversation>
  get(id: string): Promise<ServerConversation | undefined>
  list(filter: ConversationFilter): Promise<ServerConversation[]>
  update(id: string, updates: Partial<ServerConversation>): Promise<ServerConversation>
  delete(id: string): Promise<void>
}

// New: SQLite implementation
class SqliteConversationStore implements ConversationStore { /* ... */ }
class SqliteTurnStore implements TurnStore { /* ... */ }
class SqliteThreadStore implements ThreadStore { /* ... */ }
class SqliteParticipantStore implements ParticipantStore { /* ... */ }
```

**Why SQLite?** agentic-mesh already uses `better-sqlite3` for cr-sqlite. SQLite gives us persistence, full-text search (FTS5), and ACID guarantees without an external database.

### 2. Mail Service (`src/map/mail/mail-service.ts`)

The high-level service that adds agent DX features on top of MAP mail primitives.

```typescript
interface MailServiceConfig {
  /** SQLite database path (default: .agentic-mesh/mail.db) */
  dbPath?: string
  /** Enable git-backed archival */
  gitArchive?: boolean
  /** Default message TTL (default: 7 days) */
  defaultTtlMs?: number
  /** Enable file reservation tracking */
  fileReservations?: boolean
  /** Agent name generator (default: adjective-noun pairs) */
  nameGenerator?: () => string
}

class MailService {
  // === Agent Directory ===

  /** Register an agent with a memorable identity */
  registerAgent(opts: {
    agentId: string           // MAP agent ID
    name?: string             // Memorable name (auto-generated if omitted)
    program?: string          // e.g., "claude-code", "codex"
    model?: string            // e.g., "claude-opus-4-6"
    contactPolicy?: ContactPolicy
  }): Promise<AgentProfile>

  /** List active agents in a project/scope */
  listAgents(filter?: {
    scopeId?: string
    program?: string
    active?: boolean
  }): Promise<AgentProfile[]>

  /** Look up agent by name or ID */
  resolveAgent(nameOrId: string): Promise<AgentProfile | undefined>

  // === Inbox / Outbox ===

  /** Get agent's inbox (unread turns addressed to them) */
  getInbox(agentId: string, opts?: {
    limit?: number
    urgentOnly?: boolean
    since?: number             // timestamp
    conversationId?: string
    contentTypes?: string[]
  }): Promise<InboxEntry[]>

  /** Get agent's outbox (turns they've sent) */
  getOutbox(agentId: string, opts?: {
    limit?: number
    since?: number
  }): Promise<OutboxEntry[]>

  /** Mark turns as read */
  markRead(agentId: string, turnIds: string[]): Promise<void>

  /** Acknowledge turns (stronger than read — signals processing) */
  acknowledge(agentId: string, turnIds: string[]): Promise<void>

  // === Search ===

  /** Full-text search across conversations the agent participates in */
  search(agentId: string, query: string, opts?: {
    conversationId?: string
    contentTypes?: string[]
    limit?: number
  }): Promise<SearchResult[]>

  // === File Reservations ===

  /** Reserve file paths/globs (advisory locking) */
  reserveFiles(agentId: string, opts: {
    patterns: string[]          // glob patterns
    exclusive?: boolean         // exclusive vs shared
    ttlSeconds?: number         // lease duration
    scopeId?: string            // project scope
  }): Promise<FileReservation>

  /** Check for conflicts before editing */
  checkReservations(patterns: string[], scopeId?: string): Promise<ReservationCheck>

  /** Release file reservations */
  releaseReservations(agentId: string, reservationId: string): Promise<void>

  /** List active reservations */
  listReservations(scopeId?: string): Promise<FileReservation[]>

  // === Convenience: Send with Mail Context ===

  /** Send a message that auto-records as a turn in a conversation */
  sendMail(opts: {
    from: string               // agent ID
    to: string | string[]      // agent ID(s), scope, or role
    content: unknown
    contentType?: string        // default: 'text'
    conversationId?: string     // existing conversation (created if omitted)
    threadId?: string
    priority?: 'urgent' | 'high' | 'normal' | 'low'
    inReplyTo?: string          // turn ID
  }): Promise<SendMailResult>
}
```

### 3. Agent Directory (`src/map/mail/agent-directory.ts`)

Memorable agent naming and discovery, inspired by mcp_agent_mail.

```typescript
interface AgentProfile {
  agentId: string              // MAP agent ID
  name: string                 // Memorable name (e.g., "CrimsonFalcon")
  program?: string             // Agent program (e.g., "claude-code")
  model?: string               // Model name
  contactPolicy: ContactPolicy
  registeredAt: number
  lastActiveAt: number
  scopes: string[]             // Scopes the agent belongs to
}

type ContactPolicy = 'open' | 'auto' | 'contacts_only' | 'block_all'

interface AgentDirectory {
  register(profile: Omit<AgentProfile, 'registeredAt' | 'lastActiveAt'>): Promise<AgentProfile>
  lookup(nameOrId: string): Promise<AgentProfile | undefined>
  list(filter?: AgentDirectoryFilter): Promise<AgentProfile[]>
  updateActivity(agentId: string): Promise<void>
  retire(agentId: string): Promise<void>
}
```

### 4. Inbox Manager (`src/map/mail/inbox-manager.ts`)

Wraps MAP mail's `TurnManager` with inbox/outbox semantics.

```typescript
interface InboxEntry {
  turn: Turn                   // The MAP turn
  conversation: ConversationSummary
  thread?: ThreadSummary
  readAt?: number
  acknowledgedAt?: number
  fromAgent: AgentProfile      // Resolved agent info
}

interface InboxManager {
  getInbox(agentId: string, opts?: InboxFilter): Promise<InboxEntry[]>
  getUnreadCount(agentId: string): Promise<number>
  markRead(agentId: string, turnIds: string[]): Promise<void>
  acknowledge(agentId: string, turnIds: string[]): Promise<void>
}
```

### 5. File Reservation Manager (`src/map/mail/file-reservations.ts`)

Advisory file locking to prevent agent conflicts, inspired by mcp_agent_mail's lease system.

```typescript
interface FileReservation {
  id: string
  agentId: string
  patterns: string[]           // glob patterns (e.g., ["src/map/**/*.ts"])
  exclusive: boolean
  scopeId?: string
  createdAt: number
  expiresAt: number
  released: boolean
}

interface ReservationCheck {
  conflicts: Array<{
    pattern: string
    heldBy: AgentProfile
    reservation: FileReservation
    conflictType: 'exclusive' | 'overlap'
  }>
  safe: boolean
}
```

### 6. MCP Tool Adapter (`src/map/mail/mcp-adapter.ts`)

Thin adapter that exposes MailService operations as MCP tools, for agents that prefer the MCP interface.

```typescript
/** Generates MCP tool definitions that delegate to MailService */
function createMcpMailTools(mailService: MailService): McpToolDefinition[] {
  return [
    {
      name: 'mail_register',
      description: 'Register as a mail participant',
      inputSchema: { /* ... */ },
      handler: (params) => mailService.registerAgent(params)
    },
    {
      name: 'mail_send',
      description: 'Send a message to another agent',
      inputSchema: { /* ... */ },
      handler: (params) => mailService.sendMail(params)
    },
    {
      name: 'mail_inbox',
      description: 'Check your inbox for new messages',
      inputSchema: { /* ... */ },
      handler: (params) => mailService.getInbox(params.agentId, params)
    },
    {
      name: 'mail_search',
      description: 'Search messages',
      inputSchema: { /* ... */ },
      handler: (params) => mailService.search(params.agentId, params.query, params)
    },
    {
      name: 'mail_reserve_files',
      description: 'Reserve files to signal editing intent',
      inputSchema: { /* ... */ },
      handler: (params) => mailService.reserveFiles(params.agentId, params)
    },
    // ... etc
  ]
}
```

---

## Integration with agentic-mesh

### MapServer Integration

Mail is wired into the existing `MapServer` as an optional feature:

```typescript
// In MapServer constructor or setup
const mailService = new MailService({
  dbPath: config.mail?.dbPath,
  fileReservations: config.mail?.fileReservations ?? true,
})

// Register mail/* method handlers
const mailHandlers = createMailHandlers({
  conversations: mailService.conversations,
  turns: mailService.turns,
  threads: mailService.threads,
})

// Register extended handlers for agent DX
const dxHandlers = createMailDxHandlers(mailService)

// Advertise mail capability in map/connect response
capabilities.mail = {
  enabled: true,
  canCreate: true,
  // ... per-participant capabilities
}
```

### Turn Interception (Zero-Change Agent Support)

The existing `MessageRouter` is extended to intercept `meta.mail`:

```typescript
// In MessageRouter.route()
if (message.meta?.mail) {
  // Record turn automatically (non-blocking)
  mailService.turns.create({
    conversationId: message.meta.mail.conversationId,
    participantId: message.from,
    contentType: inferContentType(message.payload),
    content: message.payload,
    source: { type: 'intercepted', messageId: message.id },
    threadId: message.meta.mail.threadId,
    inReplyTo: message.meta.mail.inReplyTo,
    visibility: message.meta.mail.visibility,
  }).catch(err => {
    eventBus.emit('mail.turn.failed', { messageId: message.id, error: err.message })
  })
}
```

### Mesh Transport Integration

Mail works over any agentic-mesh transport:

```
Agent A (Nebula peer)                    Agent B (Nebula peer)
  │                                        │
  ├── mailService.sendMail({              │
  │     to: 'CrimsonFalcon',             │
  │     content: { text: 'Review PR?' }  │
  │   })                                  │
  │                                        │
  ├──► map/send + meta.mail ─────────────►├── message delivered
  │    (via TransportAdapter)              │   turn auto-recorded
  │                                        │   inbox updated
  │                                        │
  │                                        ├── mailService.getInbox()
  │                                        │   → [{ from: 'BluePanther', ... }]
```

### Offline Support

When an agent is offline, the existing `OfflineQueue` handles message delivery. The `MailService` additionally:

1. Stores the turn in SQLite immediately (it's persistent regardless of delivery)
2. Queues the `map/send` delivery via `OfflineQueue`
3. When the peer comes online, `OfflineQueue` flushes and delivers
4. The inbox shows unread turns that accumulated while offline

### Federation

For cross-mesh mail, the existing federation gateway routes `map/send` with `meta.mail` to remote systems. The remote `MailService` records the turn locally. Conversation state is eventually consistent via turn exchange.

---

## Extended Protocol Methods

Beyond the standard MAP mail methods, we add agent DX methods:

| Method | Description |
|--------|-------------|
| `mail/directory/register` | Register agent with memorable name |
| `mail/directory/list` | List registered agents |
| `mail/directory/lookup` | Look up agent by name or ID |
| `mail/inbox` | Get agent's inbox (convenience over `mail/turns/list`) |
| `mail/inbox/count` | Get unread count |
| `mail/read` | Mark turns as read |
| `mail/ack` | Acknowledge turns |
| `mail/search` | Full-text search |
| `mail/files/reserve` | Reserve file patterns |
| `mail/files/check` | Check for reservation conflicts |
| `mail/files/release` | Release reservations |
| `mail/files/list` | List active reservations |

These are **Tier 4 (Vendor Extension)** methods in MAP terminology — they extend the spec without breaking compatibility.

---

## Data Model (SQLite Schema)

```sql
-- Agent directory
CREATE TABLE mail_agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  program TEXT,
  model TEXT,
  contact_policy TEXT DEFAULT 'open',
  registered_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  retired_at INTEGER
);

-- Conversations (MAP mail/create)
CREATE TABLE mail_conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject TEXT,
  status TEXT DEFAULT 'active',
  parent_conversation_id TEXT,
  parent_turn_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  metadata TEXT  -- JSON
);

-- Participants
CREATE TABLE mail_participants (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  permissions TEXT,  -- JSON
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (conversation_id, agent_id)
);

-- Turns (the core message/content unit)
CREATE TABLE mail_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  thread_id TEXT,
  participant_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,  -- JSON
  source_type TEXT NOT NULL,  -- 'explicit' | 'intercepted'
  source_message_id TEXT,
  in_reply_to TEXT,
  visibility TEXT,  -- JSON
  metadata TEXT,    -- JSON
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES mail_conversations(id)
);

-- Full-text search index on turns
CREATE VIRTUAL TABLE mail_turns_fts USING fts5(
  content, content_type, participant_id,
  content='mail_turns', content_rowid='rowid'
);

-- Read/ack tracking (inbox state)
CREATE TABLE mail_read_state (
  agent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  read_at INTEGER,
  ack_at INTEGER,
  PRIMARY KEY (agent_id, turn_id)
);

-- Threads
CREATE TABLE mail_threads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  root_turn_id TEXT NOT NULL,
  parent_thread_id TEXT,
  subject TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES mail_conversations(id)
);

-- File reservations
CREATE TABLE mail_file_reservations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  patterns TEXT NOT NULL,  -- JSON array of globs
  exclusive INTEGER DEFAULT 0,
  scope_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released INTEGER DEFAULT 0
);

CREATE INDEX idx_reservations_scope ON mail_file_reservations(scope_id, released, expires_at);
```

---

## File Structure

```
src/map/mail/
├── index.ts                    # Public exports
├── mail-service.ts             # High-level MailService class
├── agent-directory.ts          # Agent naming and discovery
├── inbox-manager.ts            # Inbox/outbox abstraction
├── file-reservations.ts        # Advisory file locking
├── search.ts                   # FTS5-based search
├── handlers.ts                 # JSON-RPC handlers for extended methods
├── mcp-adapter.ts              # MCP tool interface adapter
├── types.ts                    # Mail-specific types
└── storage/
    ├── types.ts                # Storage interfaces (extends MAP SDK)
    ├── sqlite.ts               # SQLite store implementations
    └── migrations.ts           # Schema migrations
```

---

## Progressive Adoption (Matching MAP Spec)

### Level 0: Unaware Agent
No changes needed. Messages arrive via `map/send`. If `meta.mail` is present, turns are recorded server-side. The agent doesn't know or care.

### Level 1: Inbox-Aware Agent
Agent calls `mail/inbox` to check for messages. Uses `mail/ack` to signal processing. Minimal integration.

```typescript
// Agent periodically checks inbox
const inbox = await client.request('mail/inbox', { limit: 10 })
for (const entry of inbox.entries) {
  await processMessage(entry)
  await client.request('mail/ack', { turnIds: [entry.turn.id] })
}
```

### Level 2: Coordinating Agent
Agent registers in directory, reserves files, sends mail with conversation context.

```typescript
// Register with memorable name
await client.request('mail/directory/register', {
  name: 'BluePanther',
  program: 'claude-code',
  model: 'claude-opus-4-6',
})

// Reserve files before editing
await client.request('mail/files/reserve', {
  patterns: ['src/map/mail/**/*.ts'],
  exclusive: true,
  ttlSeconds: 3600,
})

// Send mail to another agent
await client.request('mail/send', {
  to: 'CrimsonFalcon',
  content: { text: 'I am working on the mail module, heads up.' },
  conversationId: 'sprint-planning',
})
```

### Level 3: MCP-Based Agent
Agent uses the MCP tool adapter (for agents running as MCP clients like Claude Code, Codex, etc.)

```typescript
// Via MCP tools
await callTool('mail_register', { name: 'GreenCastle', program: 'codex' })
await callTool('mail_send', { to: 'BluePanther', content: 'PR is ready for review' })
const inbox = await callTool('mail_inbox', { limit: 5 })
```

---

## Key Design Decisions

### 1. Conversations are optional, not mandatory

Like MAP mail spec: agents can send messages without creating conversations. The `sendMail` convenience method auto-creates conversations when needed, but agents can also use raw `map/send`.

### 2. Turns are the source of truth, not messages

MAP messages are ephemeral (routed and forgotten). Turns persist. The inbox shows turns, not messages. This aligns with the MAP spec's design.

### 3. File reservations are advisory, not enforced

Like mcp_agent_mail: reservations signal intent. They don't prevent writes. Agents check for conflicts voluntarily. This is practical for coding agents that may need to override.

### 4. SQLite for persistence, not a separate database

agentic-mesh already uses `better-sqlite3`. SQLite gives us FTS5 for search, ACID for consistency, and zero deployment complexity. The database is local to each mesh peer.

### 5. MCP adapter is a thin layer, not the primary interface

The primary interface is MAP JSON-RPC. The MCP adapter is a convenience for agents that speak MCP. This keeps the system MAP-native while being accessible to the broader MCP ecosystem.

### 6. Memorable names are optional sugar

Agents are always identifiable by their MAP agent ID. Memorable names are a convenience for human readability and agent-to-agent discovery. They're registered in the directory but don't replace MAP's addressing system.

---

## Comparison: This Design vs. mcp_agent_mail

| Aspect | mcp_agent_mail | This Design |
|--------|---------------|-------------|
| **Protocol** | Custom MCP tools | MAP-native + MCP adapter |
| **Transport** | HTTP (localhost) | Encrypted mesh (Nebula/Tailscale) |
| **Multi-machine** | Single server | Distributed (per-peer with federation) |
| **Identity** | Per-project agents | MAP agents with directory overlay |
| **Conversations** | Threads (flat) | MAP conversations + threads (hierarchical) |
| **Storage** | SQLite + Git | SQLite + optional Git archive |
| **Offline** | N/A (centralized) | OfflineQueue with persistent turns |
| **Interop** | MCP only | MAP protocol + MCP adapter |
| **File reservations** | Built-in | Built-in (same pattern) |
| **Search** | SQLite FTS | SQLite FTS5 |
| **Observability** | HTTP endpoints | MAP event subscriptions |

---

## Open Questions

1. **Should conversations replicate across peers?** Currently each peer has its own SQLite. For multi-peer conversations, we could use cr-sqlite (already in agentic-mesh) for CRDT-based replication of the mail tables.

2. **Git archival format?** mcp_agent_mail uses a specific directory structure. Should we match it for compatibility, or use a MAP-native format?

3. **Name collision across federated systems?** Memorable names are locally unique. Across federation boundaries, names might collide. Do we namespace them (e.g., `BluePanther@mesh-1`)?

4. **Rate limiting?** mcp_agent_mail has per-agent rate limits. Should we implement this, or rely on MAP's existing permission system?

5. **Attachment support?** mcp_agent_mail supports image/file attachments. MAP turns have `reference` content type for URIs. Should we add blob storage, or keep it URI-based?
