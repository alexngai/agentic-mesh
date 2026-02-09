# Mesh Design Decisions & Open Questions

This document captures design decisions, open questions, alternatives considered, and deferred items from the agentic-mesh design process. agentic-mesh has evolved from a CRDT sync library into a transport coordination layer for multi-agent systems.

---

## Key Decisions Made

### Package Architecture

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Package name | `agentic-mesh` | Reserved by user | `nebula-crdt`, `mesh-sync`, `p2p-crdt` |
| Factoring | Standalone library + sudocode consumer | Reusability, clean separation | Monolithic in sudocode |
| License | MIT | Maximum adoption | Apache 2.0 (patent protection) |

### Dependencies

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Transport | Pluggable via `TransportAdapter` (Nebula, Tailscale, Headscale) | Different deployments need different transports | Single transport, plain WebRTC |
| Agent protocols | ACP SDK + MAP server | Direct support for major agent coordination protocols | Custom protocol only |
| CRDT | Yjs + cr-sqlite | In-memory and persistent sync options | Automerge, custom CRDT |
| Transport binary | External install required | Avoids binary distribution complexity | Embedded/bundled binary |

### Identity & Certificates

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Identity model | Hybrid PKI (org CA → user sub-CA → server cert) | Flexible, supports both single-user and team | Flat certs, user-only, server-only |
| Certificate duration | CA: 10y, User: 1y, Server: 30d | Balance security vs convenience | Longer server certs, auto-renewal |
| IP allocation | 10.42.0.0/16 with user ranges | Simple, predictable | DHCP-style, random allocation |
| Permissions | Static (certificate groups) | Simple, verifiable, no runtime state | Dynamic ACL, runtime permissions |

### Sync Model

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Source of truth | Git (JSONL files) | Existing sudocode model, distributed | CRDT-only, database |
| CRDT role | Sync layer for uncommitted changes | Real-time collaboration without git churn | CRDT as source of truth |
| Reconciliation | "Git wins" on pull | Simplicity, predictable behavior | CRDT wins, merge strategies |
| CRDT structure | One Y.Doc per project | Natural isolation | Global doc with namespaces, per-entity docs |

### Hub System

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Hub role | Sync anchor (not traffic router) | Simpler, peers still direct-connect | Full relay/proxy |
| Hub selection | Priority-based list | Deterministic, no election complexity | Raft election, capability-based |
| Failover | Manual designation + priority fallback | Simplicity | Auto-election, quorum-based |
| Multi-hub | Deferred (single hub only) | Complexity | Regional hubs, role-based hubs |

### Execution Routing

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Routing model | Explicit (user specifies target) | Predictable, simple | Auto-routing, capability matching |
| Default | Run locally | Least surprise | Route to most capable |
| Remote execution | Request/response via MessageChannel | Clean separation from CRDT | Embedded in CRDT, separate protocol |

### Offline Handling

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Queue persistence | JSON file | Simple, portable | SQLite, in-memory only |
| Queue TTL | 24 hours default | Balance storage vs delivery | Shorter, configurable per-message |
| Reconnection | Auto-sync CRDT + drain queue | Seamless experience | Manual sync trigger |

### Audit & Logging

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Audit logs | Local-only (not synced) | Simplicity, each peer owns its log | Synced via CRDT, central collection |
| Implementation | Deferred | Not critical for MVP | Immediate implementation |

### Lighthouse

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| Hosting | Support both self-hosted and managed | Flexibility for different deployments | Self-hosted only, managed only |
| Discovery | Lighthouse (truth) + config cache (fallback) | Resilience | Lighthouse only, gossip only |

### CLI

| Decision | Choice | Rationale | Alternatives Considered |
|----------|--------|-----------|------------------------|
| agentic-mesh CLI | Library + optional helpers | Consumer builds their own CLI | Full CLI included, no CLI |
| sudocode CLI | Wraps agentic-mesh helpers | Consistent UX | Separate mesh binary |

---

## Primary Use Case Clarification

**Current focus:** agentic-mesh serves as a **transport coordination layer for multi-agent systems**. The primary consumer is [multi-agent-protocol](https://github.com/multi-agent-protocol/multi-agent-protocol), which uses agentic-mesh for encrypted P2P connectivity between MAP clients, agents, and peers.

Secondary use cases include:
- Single user scaling workloads across machines (laptop + cloud VMs + CI runners)
- CRDT-based state synchronization for collaborative applications
- Git repository sync over encrypted tunnels

---

## Open Questions (Unresolved)

### Certificate Management

| Question | Options | Notes |
|----------|---------|-------|
| Certificate renewal | Manual vs auto-renew | Start manual; add auto-renewal if friction is high |
| Revocation mechanism | CRL vs OCSP vs short-lived certs | Short-lived certs (30d) reduce revocation need |
| CA key loss recovery | Backup strategy? Re-key mesh? | Need to document recovery procedure |
| Machine migration | Revoke old + issue new? Transfer? | Unclear UX for replacing hardware |

### CRDT Behavior

| Question | Options | Notes |
|----------|---------|-------|
| Orphaned CRDT entities | How to detect entities from rebased commits? | May need `_origin.gitRef` validation |
| Large content | Is Y.Text efficient for 100KB+ specs? | May need chunking or external refs |
| Schema evolution | How do old peers handle new fields? | Version field in meta, ignore unknown |
| Presence/awareness | Separate channel or in Y.Doc? | Defer; separate ephemeral channel likely |

### Execution

| Question | Options | Notes |
|----------|---------|-------|
| Log streaming | Via CRDT? Separate WebSocket? Direct P2P? | Logs are large; probably separate channel |
| Execution migration | Can we move running execution between peers? | Complex; defer |
| Agent discovery | How does peer advertise available agents? | Peer metadata? Capability channel? |

### Scale

| Question | Options | Notes |
|----------|---------|-------|
| Max peers | What breaks at 50+? 100+? | Need testing |
| Max entities | CRDT performance at 10k+ specs? | Need testing |
| Snapshot size | How large do snapshots get? | May need incremental snapshots |

### Operations

| Question | Options | Notes |
|----------|---------|-------|
| Monitoring | Prometheus metrics? Health endpoints? | Defer |
| Debugging | How to diagnose sync issues? | CRDT inspector tool? |
| Backup/restore | Can we backup and restore mesh state? | Snapshot export/import? |

---

## Implemented Features (Previously Deferred)

These features were originally deferred but have since been implemented:

| Feature | Status | Implementation |
|---------|--------|---------------|
| Pluggable transport | **Implemented** | `TransportAdapter` interface with Nebula, Tailscale, Headscale |
| Agent protocol support | **Implemented** | ACP adapter (`src/acp/`) and MAP server (`src/map/`) |
| Git transport | **Implemented** | `git-remote-mesh://` protocol (`src/git/`) |
| Optional features | **Implemented** | `OptionalFeaturesConfig` for hub election, health monitoring, etc. |
| Pluggable health monitoring | **Implemented** | `HealthMonitorAdapter` interface, `NoopHealthMonitor` |
| Serialization negotiation | **Implemented** | JSON/MessagePack negotiation in `src/channel/serializers/` |

## Deferred Features

### Definitely Later

| Feature | Reason for Deferral |
|---------|---------------------|
| Auto git sync | Adds complexity; git push/pull is explicit |
| Availability pools | Need explicit routing first |
| Live migration | Complex state transfer |
| Alternative CRDTs (Automerge) | Yjs sufficient for current use cases |
| Awareness/presence layer | Separate ephemeral channel likely needed |
| Certificate auto-renewal | Start manual; add if friction is high |
| Dual-transport mode | Running Nebula + Tailscale simultaneously |
| Dynamic permissions (ACL) | Static certs work for current usage |

### Maybe Never

| Feature | Reason |
|---------|--------|
| Full traffic routing through hub | Defeats P2P benefits |
| Automatic hub election (Raft) | Adds distributed consensus complexity |
| Agent-specific logic in agentic-mesh | Should stay in consumer (MAP, ACP agents) |
| Embedded transport binary | External install is simpler and more maintainable |

---

## Alternatives Considered (Not Chosen)

### Transport Alternatives

| Option | Pros | Cons | Why Not Chosen |
|--------|------|------|----------------|
| **Tailscale** | Easier setup, hosted control plane | Less control, not fully open source | Want full control |
| **ZeroTier** | Simpler config | Less performant, some features paid | Nebula more proven |
| **Plain WebRTC** | Browser-native | NAT traversal harder, no CLI story | Not CLI-friendly |
| **Matrix** | Existing infrastructure | Requires Matrix server, more overhead | Too heavy |

### Sync Alternatives

| Option | Pros | Cons | Why Not Chosen |
|--------|------|------|----------------|
| **CRDT as source of truth** | Simpler sync | Loses git history benefits | Git integration important |
| **Operational Transform** | Proven (Google Docs) | Requires central server | Want P2P |
| **Database replication** | Familiar | Central coordination needed | Want P2P |

### Hub Alternatives

| Option | Pros | Cons | Why Not Chosen |
|--------|------|------|----------------|
| **Raft election** | Automatic failover | Complex, need quorum | Overkill for small mesh |
| **No hub** | Simpler | No sync anchor, harder bootstrap | Need authority for tie-breaking |
| **Multiple equal hubs** | Redundancy | Split-brain risk | Single hub simpler |

---

## Design Rationale Notes

### Why Nebula?

1. **Proven scale** - Slack runs 50k+ hosts on it
2. **Security** - Noise Protocol + AES-256-GCM, mutual auth
3. **NAT traversal** - UDP hole punching works in most environments
4. **Certificate-based** - Natural permission model via groups
5. **Open source** - MIT license, active development
6. **Simple conceptually** - Just encrypted IP tunnels

### Why Yjs?

1. **Performance** - Fastest CRDT implementation benchmarks
2. **Mature** - Years of production use
3. **TypeScript** - First-class support
4. **Ecosystem** - Existing providers, bindings, tools
5. **Flexible** - Supports text, arrays, maps, nested structures
6. **Small** - ~10KB gzipped

### Why Git Wins?

1. **Existing model** - sudocode already uses git-tracked JSONL
2. **Predictable** - Clear mental model (git is truth)
3. **Recoverable** - Can always rebuild CRDT from git
4. **Mergeable** - Git handles branch merges
5. **Auditable** - Git history is the audit trail

### Why Explicit Execution Routing?

1. **Predictable** - User knows where code runs
2. **Debuggable** - Clear which peer to check
3. **Secure** - No surprise remote execution
4. **Simple** - No capability matching algorithm
5. **Extensible** - Can add auto-routing later

---

## Assumptions Made

### Environment

- Users have Node.js 18+ installed
- Users can install Nebula separately
- Users have at least one machine with public IP (lighthouse) or use managed lighthouse
- Network allows UDP traffic (or can punch through NAT)

### Usage Patterns

- Single-digit peers initially (<10)
- One project active at a time typically
- Specs/issues in hundreds, not tens of thousands
- Users push/pull git regularly (not continuous sync)

### Trust Model

- All peers in a mesh are trusted (authenticated via cert)
- No Byzantine behavior (honest but potentially buggy)
- Audit logs are local (no need for tamper-proof cross-peer audit)

---

## Naming Conventions

### Identifiers

| Entity | Format | Example |
|--------|--------|---------|
| Spec ID | `s-xxxx` | `s-4bf2` |
| Issue ID | `i-xxxx` | `i-abc1` |
| Execution ID | `e-xxxx` or UUID | `e-789f` |
| Peer ID | From cert name | `alex-laptop` |
| Mesh IP | `10.42.x.x` | `10.42.1.1` |

### Certificate Groups

| Group | Purpose |
|-------|---------|
| `admin` | Full permissions |
| `developer` | Read/write/execute |
| `read-only` | Read only |
| `executor` | Can receive executions |
| `hub` | Can be sync anchor |
| `user:<name>` | User identity |
| `server:<name>` | Server identity |
| `project:<id>` | Project access |

### Message Types

| Namespace | Pattern | Example |
|-----------|---------|---------|
| sudocode | `<entity>:<action>` | `exec:request`, `exec:status` |
| agentic-mesh | `mesh:<action>` | `mesh:hub_priority_update` |

---

## Testing Considerations

### Unit Tests Needed

- Certificate generation and validation
- CRDT sync protocol (state vectors, updates)
- Message channel (send, request/response, queue)
- Hub priority selection
- Permission checking

### Integration Tests Needed

- Multi-peer sync convergence
- Offline/reconnection scenarios
- Hub failover
- Remote execution flow
- Git pull reconciliation

### Manual Testing Scenarios

- NAT traversal (peer behind home router)
- Lighthouse unreachable
- Hub goes down mid-sync
- Large document sync
- Concurrent edits from multiple peers

---

## Documentation Gaps

| Topic | Status | Notes |
|-------|--------|-------|
| Installation guide | Not written | Need nebula install + cert setup |
| Quick start | Not written | Hello world for agentic-mesh |
| Troubleshooting | Not written | Common issues, debugging |
| Security model | Partial | Need threat model doc |
| Performance tuning | Not written | Throttling, snapshot intervals |
| Migration guide | Not written | Adding mesh to existing sudocode project |

---

## Implementation History

### Phase 1-4: Core (Complete)

1. CertManager (CA, signing, config generation)
2. NebulaMesh (peer connection, health)
3. MessageChannel (send, broadcast, RPC)
4. YjsSyncProvider (Yjs CRDT sync)
5. Hub management (priority, failover)
6. Offline queue (persistence, drain)
7. CrSqliteSyncProvider (SQLite CRDT sync)
8. CLI helpers

### Phase 5: Optional Features (Complete)

9. Pluggable health monitoring (`HealthMonitorAdapter`)
10. Optional hub election, namespace registry, hub relay
11. Serialization negotiation (JSON/MessagePack)

### Phase 6-9: Integrations (Complete)

12. SudocodeMeshService integration
13. Peer discovery via Nebula lighthouses
14. Hub relay and offline queuing
15. Execution router and streaming

### Phase 10: Transport Abstraction (Complete)

16. `TransportAdapter` interface
17. Nebula, Tailscale, Headscale transport implementations
18. Transport-agnostic `PeerEndpoint`

### Phase 11: Agent Protocol Support (Complete)

19. ACP integration (`AcpMeshAdapter`, `meshStream`)
20. MAP server (agents, scopes, events, routing, federation)
21. Git transport (`git-remote-mesh://`)
22. TunnelStream for NDJSON over encrypted transport
