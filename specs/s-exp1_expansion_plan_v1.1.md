# Implementation Plan: agentic-mesh v1.1 Expansion

## Overview

This spec defines the implementation plan for expanding agentic-mesh beyond the initial vertical slice (Phases 1-5). These features address gaps identified in the original specs and add capabilities for production use.

## Features Summary

| Feature | Phase | Priority | Effort |
|---------|-------|----------|--------|
| MessageChannel RPC Support | 6.1 | High | 1-2 days |
| Binary Protocol (MessagePack) | 6.2 | High | 1-2 days |
| Execution Streaming | 7.1 | Medium | 2 days |
| Nebula Auto-Discovery | 7.2 | Medium | 2 days |
| Selective Sync (Entity-type) | 8.1 | Medium | 1 day |
| Selective Sync (ID/Attribute) | 8.2 | Medium | 2 days |
| Selective Sync (Namespace) | 8.3 | Low | 2 days |

**Total Estimated Effort: 10-13 days**

## Dependency Graph

```
Phase 6 (Infrastructure)
┌─────────────────────┐     ┌─────────────────────┐
│  6.1 RPC Support    │     │  6.2 Binary Protocol│
│  (MessageChannel)   │     │  (MessagePack)      │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           └───────────┬───────────────┘
                       │
Phase 7 (Enhanced)     ▼
┌─────────────────────────────────────────────────┐
│  7.1 Execution Streaming (uses RPC + Binary)    │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│  7.2 Nebula Auto-Discovery (standalone)         │
└─────────────────────────────────────────────────┘

Phase 8 (Advanced Sync)
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│ 8.1 Entity    │────►│ 8.2 ID/Attr   │────►│ 8.3 Namespace │
│ Type Filter   │     │ Filter        │     │ Partitioning  │
└───────────────┘     └───────────────┘     └───────────────┘
```

---

## Phase 6: Infrastructure

### 6.1 MessageChannel RPC Support

**Goal**: Add request/response pattern to MessageChannel as specified in s-9689.

#### API Design

```typescript
// Additions to MessageChannel<T>
class MessageChannel<T = unknown> {
  // Existing: send, broadcast, multicast, on('message')

  // NEW: RPC Support

  /**
   * Send a request and wait for response.
   * @param peerId Target peer
   * @param message Request message
   * @param timeout Timeout in ms (default: 30000)
   * @returns Response from peer
   * @throws TimeoutError if no response within timeout
   */
  request<R>(peerId: string, message: T, timeout?: number): Promise<R>

  /**
   * Register a request handler.
   * Handler receives request and returns response.
   * Only one handler per channel.
   */
  onRequest(handler: (message: T, from: PeerInfo) => Promise<unknown>): void

  /**
   * Remove the request handler.
   */
  offRequest(): void
}
```

#### Wire Protocol Extension

```typescript
// Extend WireMessage type discriminator
interface WireMessage<T = unknown> {
  id: string
  channel: string
  type: 'message' | 'request' | 'response'  // Add request/response
  payload: T
  from: string
  to: string | null
  timestamp: number
  requestId?: string  // For response correlation (required for request/response)
}
```

#### Implementation Details

1. **Request tracking**: Map of pending requests with resolve/reject callbacks
   ```typescript
   private pendingRequests: Map<string, {
     resolve: (response: unknown) => void
     reject: (error: Error) => void
     timer: NodeJS.Timeout
   }> = new Map()
   ```

2. **Request flow**:
   - Generate unique requestId
   - Send message with `type: 'request'`
   - Store pending request with timeout
   - On response, resolve promise and clear timeout

3. **Response flow**:
   - Receive message with `type: 'request'`
   - Call registered handler
   - Send response with `type: 'response'` and same requestId

4. **Error handling**:
   - Timeout: Reject with `TimeoutError`
   - No handler: Send error response
   - Handler throws: Send error response with message

#### Files to Modify

- `src/channel/message-channel.ts` - Add RPC methods
- `src/types/index.ts` - Extend WireMessage type
- `tests/unit/message-channel-rpc.test.ts` - New test file

#### Success Criteria

- `request()` returns response from peer
- Timeout rejects with clear error
- Multiple concurrent requests work correctly
- Handler errors propagate to requester

---

### 6.2 Binary Protocol (MessagePack)

**Goal**: Replace JSON serialization with MessagePack for better performance.

#### Design Decisions

- **Encoding**: MessagePack via `@msgpack/msgpack` package
- **Migration**: Support both JSON and binary with negotiation
- **Backward compatible**: Peers auto-detect format

#### API Design

```typescript
// MessageChannel config extension
interface MessageChannelConfig {
  // ... existing config

  /**
   * Serialization format.
   * 'auto' negotiates with peer, preferring binary.
   * Default: 'auto'
   */
  serialization?: 'json' | 'binary' | 'auto'
}

// NebulaMesh config extension
interface NebulaMeshConfig {
  // ... existing config

  /**
   * Default serialization for all channels.
   * Default: 'auto'
   */
  defaultSerialization?: 'json' | 'binary' | 'auto'
}
```

#### Wire Protocol

```typescript
// Message frame format (for 'auto' mode)
// First byte indicates format:
// 0x00 = JSON (UTF-8 follows)
// 0x01 = MessagePack (binary follows)

const FORMAT_JSON = 0x00
const FORMAT_MSGPACK = 0x01
```

#### Implementation Details

1. **Serializer abstraction**:
   ```typescript
   interface Serializer {
     encode(data: unknown): Buffer
     decode(buffer: Buffer): unknown
   }

   class JsonSerializer implements Serializer { ... }
   class MsgpackSerializer implements Serializer { ... }
   ```

2. **Format negotiation** (for 'auto' mode):
   - On connect, peers exchange capability message
   - If both support binary, use MessagePack
   - Otherwise fall back to JSON
   - Cache negotiated format per peer

3. **Compression** (optional, for large messages):
   ```typescript
   // Messages > 1KB get compressed
   const COMPRESSION_THRESHOLD = 1024

   // Format byte extended:
   // 0x02 = MessagePack + zlib compression
   ```

#### Files to Modify

- `src/channel/message-channel.ts` - Serialization logic
- `src/channel/serializers/` - New directory
  - `src/channel/serializers/json.ts`
  - `src/channel/serializers/msgpack.ts`
  - `src/channel/serializers/index.ts`
- `src/mesh/nebula-mesh.ts` - Format negotiation on connect
- `src/types/index.ts` - Config types
- `package.json` - Add `@msgpack/msgpack` dependency

#### Success Criteria

- MessagePack encoding/decoding works for all message types
- Auto-negotiation selects best format
- Backward compatible with JSON-only peers
- Benchmark shows improvement for typical Y.js updates

---

## Phase 7: Enhanced Execution

### 7.1 Execution Streaming

**Goal**: Stream execution output in real-time over the mesh.

#### API Design

```typescript
// ExecutionRouter extensions
class ExecutionRouter {
  // Existing: requestExecution, broadcastExecution

  /**
   * Request execution with streaming output.
   * Returns an event emitter for stdout/stderr/exit.
   */
  requestExecutionWithStream(
    peerId: string,
    command: string,
    options?: ExecutionRequestOptions
  ): ExecutionStream
}

interface ExecutionStream extends EventEmitter {
  readonly executionId: string
  readonly peerId: string

  // Events
  on(event: 'stdout', handler: (data: string) => void): this
  on(event: 'stderr', handler: (data: string) => void): this
  on(event: 'exit', handler: (code: number, signal?: string) => void): this
  on(event: 'error', handler: (error: Error) => void): this

  // Control
  cancel(): Promise<void>
}

// Handler side
interface ExecutionRequestEvent {
  // ... existing fields

  /**
   * Stream-enabled respond function.
   * Call multiple times for streaming, final call includes exit code.
   */
  stream: {
    stdout(data: string): void
    stderr(data: string): void
    exit(code: number, signal?: string): void
  }
}
```

#### Wire Protocol

```typescript
type ExecutionStreamMessage =
  | { type: 'exec:start'; executionId: string; command: string; options?: ExecutionRequestOptions }
  | { type: 'exec:stdout'; executionId: string; data: string }
  | { type: 'exec:stderr'; executionId: string; data: string }
  | { type: 'exec:exit'; executionId: string; code: number; signal?: string }
  | { type: 'exec:error'; executionId: string; error: string }
  | { type: 'exec:cancel'; executionId: string }
```

#### Implementation Details

1. **Streaming channel**: Use dedicated channel `exec:stream` for streaming messages
2. **Buffering**: Buffer rapid output (flush every 100ms or 4KB)
3. **Backpressure**: If send queue backs up, buffer locally
4. **Cleanup**: Track active streams, cleanup on disconnect

#### Files to Create/Modify

- `src/mesh/execution-router.ts` - Add streaming methods
- `src/mesh/execution-stream.ts` - New ExecutionStream class
- `tests/unit/execution-streaming.test.ts` - New tests

#### Success Criteria

- stdout/stderr stream in real-time
- Exit event fires with correct code
- Cancel stops remote execution
- Works with binary protocol

---

### 7.2 Nebula Auto-Discovery

**Goal**: Auto-configure mesh from Nebula config with lighthouse peer discovery.

#### API Design

```typescript
class NebulaMesh {
  /**
   * Create mesh instance from Nebula config file.
   * Extracts local IP, groups, and lighthouse addresses.
   */
  static async fromNebulaConfig(
    configPath: string,
    options?: {
      peerId?: string  // Default: derived from cert name
      peerName?: string
      hub?: HubConfig
    }
  ): Promise<NebulaMesh>

  /**
   * Query lighthouses for known peers.
   * Called automatically on connect if lighthouses configured.
   */
  async discoverPeers(): Promise<PeerInfo[]>

  /**
   * Enable continuous peer discovery.
   * Polls lighthouses periodically for new peers.
   */
  startPeerDiscovery(intervalMs?: number): void
  stopPeerDiscovery(): void
}

// Config extension
interface NebulaMeshConfig {
  // ... existing config

  /**
   * Path to nebula.yaml for auto-configuration.
   * If provided, extracts nebulaIp, groups, and lighthouses.
   */
  nebulaConfigPath?: string

  /**
   * Enable automatic peer discovery via lighthouses.
   * Default: true if lighthouses are configured
   */
  enablePeerDiscovery?: boolean

  /**
   * Peer discovery interval in ms.
   * Default: 30000 (30 seconds)
   */
  peerDiscoveryInterval?: number
}
```

#### Nebula Config Parsing

```typescript
// nebula.yaml structure we need to parse
interface NebulaConfig {
  pki: {
    ca: string      // Path to CA cert
    cert: string    // Path to host cert
    key: string     // Path to host key
  }
  static_host_map?: Record<string, string[]>  // Lighthouse IPs
  lighthouse?: {
    am_lighthouse: boolean
    hosts: string[]  // Lighthouse Nebula IPs
  }
  listen?: {
    host: string
    port: number
  }
}

// Extract from host certificate:
// - Nebula IP
// - Groups
// - Name (for peerId)
```

#### Lighthouse Discovery Protocol

```typescript
// Query lighthouse for peer list
// Uses existing MessageChannel with special 'discovery' channel

interface DiscoveryRequest {
  type: 'peer-list-request'
  namespace?: string  // Optional: filter by namespace
}

interface DiscoveryResponse {
  type: 'peer-list-response'
  peers: Array<{
    id: string
    nebulaIp: string
    name?: string
    groups: string[]
    namespaces: string[]
    lastSeen: string
  }>
}
```

#### Implementation Details

1. **Config parsing**: Use `yaml` package to parse nebula.yaml
2. **Cert parsing**: Shell out to `nebula-cert print` for cert details
3. **Lighthouse query**: Connect to lighthouses on startup, query peer list
4. **Continuous discovery**: Optional polling for dynamic peer discovery
5. **Validation**: Verify cert/key files exist, warn if not

#### Files to Create/Modify

- `src/mesh/nebula-mesh.ts` - Add `fromNebulaConfig`, discovery methods
- `src/mesh/nebula-config-parser.ts` - New config parser
- `src/mesh/peer-discovery.ts` - Lighthouse discovery logic
- `package.json` - Add `yaml` dependency
- `tests/unit/nebula-config.test.ts` - Config parsing tests
- `tests/unit/peer-discovery.test.ts` - Discovery tests

#### Success Criteria

- `fromNebulaConfig()` creates working mesh from nebula.yaml
- Groups extracted from certificate
- Lighthouses queried for peer list on connect
- Continuous discovery finds new peers

---

## Phase 8: Advanced Sync

### 8.1 Selective Sync - Entity Type Filtering

**Goal**: Control which entity types sync over the mesh.

#### API Design

```typescript
interface SudocodeMeshConfig {
  // ... existing config

  /**
   * Entity types to sync.
   * Default: all types
   */
  syncEntities?: ('specs' | 'issues' | 'relationships' | 'feedback')[]
}
```

#### Implementation Details

1. **Filter on write**: Only sync entities of enabled types
2. **Filter on receive**: Ignore remote updates for disabled types
3. **Namespace scoping**: Each type can have separate Y.Map (already implemented)

#### Files to Modify

- `src/integrations/sudocode/service.ts` - Add entity type filtering
- `src/integrations/sudocode/types.ts` - Config type update

#### Success Criteria

- Only configured entity types sync
- Disabled types remain local-only

---

### 8.2 Selective Sync - ID/Attribute Filtering

**Goal**: Filter sync by entity ID patterns or attribute values.

#### API Design

```typescript
interface SyncFilter {
  /**
   * Specs to sync. Can be:
   * - 'all' - sync all specs
   * - 'none' - sync no specs
   * - string[] - glob patterns for IDs (e.g., ['s-abc*', 's-xyz'])
   * - FilterConfig - attribute-based filter
   */
  specs?: 'all' | 'none' | string[] | SpecFilterConfig

  issues?: 'all' | 'none' | string[] | IssueFilterConfig

  relationships?: 'all' | 'none' | string[] | RelFilterConfig

  feedback?: 'all' | 'none' | string[] | FeedbackFilterConfig
}

interface SpecFilterConfig {
  ids?: string[]           // Glob patterns
  priority?: number[]      // e.g., [0, 1] for high priority only
  tags?: string[]          // Any of these tags
  archived?: boolean       // Include archived?
}

interface IssueFilterConfig {
  ids?: string[]
  status?: IssueStatus[]   // e.g., ['open', 'in_progress']
  priority?: number[]
  tags?: string[]
  archived?: boolean
}

// Usage
const service = new SudocodeMeshService({
  projectId: 'my-project',
  projectPath: '/path/to/project',
  meshConfig: { ... },
  syncFilter: {
    specs: { priority: [0, 1], archived: false },
    issues: { status: ['open', 'in_progress'] },
    relationships: 'all',
    feedback: 'all'
  }
})
```

#### Implementation Details

1. **Filter compilation**: Compile filter config to predicate functions
2. **Write filtering**: Check predicate before syncing local changes
3. **Receive filtering**: Check predicate before applying remote changes
4. **Dynamic filter update**: Allow filter changes at runtime
5. **Glob matching**: Use `minimatch` or `picomatch` for ID patterns

```typescript
class SyncFilterEngine {
  private specFilter: (spec: SpecCRDT) => boolean
  private issueFilter: (issue: IssueCRDT) => boolean
  // ...

  constructor(config: SyncFilter) {
    this.specFilter = this.compileFilter(config.specs, 'spec')
    this.issueFilter = this.compileFilter(config.issues, 'issue')
  }

  shouldSyncSpec(spec: SpecCRDT): boolean {
    return this.specFilter(spec)
  }

  updateFilter(config: Partial<SyncFilter>): void {
    // Recompile affected filters
  }
}
```

#### Files to Create/Modify

- `src/integrations/sudocode/sync-filter.ts` - New SyncFilterEngine
- `src/integrations/sudocode/service.ts` - Integrate filter engine
- `src/integrations/sudocode/types.ts` - Filter config types
- `package.json` - Add `picomatch` dependency
- `tests/unit/sync-filter.test.ts` - Filter tests

#### Success Criteria

- ID glob patterns filter correctly
- Attribute filters work for all entity types
- Filters can be updated at runtime
- Filtered entities don't sync

---

### 8.3 Selective Sync - Namespace Partitioning

**Goal**: Partition project into sub-namespaces that sync independently.

#### API Design

```typescript
interface SudocodeMeshConfig {
  // ... existing config

  /**
   * Namespace partitioning configuration.
   * Entities are assigned to partitions based on rules.
   */
  partitioning?: PartitionConfig
}

interface PartitionConfig {
  /**
   * Enable namespace partitioning.
   * Default: false (single namespace for entire project)
   */
  enabled: boolean

  /**
   * Partition assignment rules.
   * Evaluated in order, first match wins.
   */
  rules: PartitionRule[]

  /**
   * Default partition for entities not matching any rule.
   * Default: 'default'
   */
  defaultPartition?: string

  /**
   * Partitions to subscribe to.
   * Default: all partitions defined in rules + default
   */
  subscriptions?: string[]
}

interface PartitionRule {
  /**
   * Partition name (becomes part of namespace).
   */
  partition: string

  /**
   * Match criteria (all must match).
   */
  match: {
    entityType?: ('specs' | 'issues' | 'relationships' | 'feedback')[]
    idPattern?: string      // Glob pattern
    tags?: string[]         // Any of these tags
    attribute?: {
      path: string          // e.g., 'status' or 'metadata.team'
      value: unknown        // Value to match
    }
  }
}

// Usage example: Partition by team
const service = new SudocodeMeshService({
  projectId: 'my-project',
  projectPath: '/path/to/project',
  meshConfig: { ... },
  partitioning: {
    enabled: true,
    rules: [
      { partition: 'team-frontend', match: { tags: ['frontend'] } },
      { partition: 'team-backend', match: { tags: ['backend'] } },
      { partition: 'team-infra', match: { tags: ['infrastructure'] } }
    ],
    defaultPartition: 'shared',
    subscriptions: ['team-frontend', 'shared']  // Only sync these
  }
})
```

#### Implementation Details

1. **Namespace scheme**: `sudocode:{projectId}:{partition}`
   - e.g., `sudocode:my-project:team-frontend`

2. **Partition assignment**:
   ```typescript
   class PartitionManager {
     getPartition(entity: SpecCRDT | IssueCRDT | ...): string {
       for (const rule of this.rules) {
         if (this.matchesRule(entity, rule)) {
           return rule.partition
         }
       }
       return this.defaultPartition
     }
   }
   ```

3. **Multi-namespace sync**:
   - Create YjsSyncProvider per subscribed partition
   - Route entity updates to correct provider
   - Merge results when querying

4. **Cross-partition relationships**:
   - Relationships can span partitions
   - Store in both partitions for availability
   - Dedupe on merge

5. **Partition migration**:
   - When entity's partition changes (e.g., tag added)
   - Delete from old partition, add to new
   - Handle gracefully during sync

#### Files to Create/Modify

- `src/integrations/sudocode/partition-manager.ts` - New partition logic
- `src/integrations/sudocode/service.ts` - Multi-provider management
- `src/integrations/sudocode/types.ts` - Partition config types
- `tests/unit/partition-manager.test.ts` - Partition tests

#### Success Criteria

- Entities route to correct partition based on rules
- Only subscribed partitions sync
- Cross-partition relationships work
- Partition changes handled gracefully

---

## Testing Strategy

### Unit Tests (per feature)

| Feature | Test File | Key Test Cases |
|---------|-----------|----------------|
| RPC Support | `message-channel-rpc.test.ts` | Request/response, timeout, errors |
| Binary Protocol | `serialization.test.ts` | Encode/decode, negotiation, compression |
| Execution Streaming | `execution-streaming.test.ts` | Stream events, cancel, backpressure |
| Nebula Discovery | `nebula-config.test.ts`, `peer-discovery.test.ts` | Config parsing, lighthouse query |
| Sync Filtering | `sync-filter.test.ts` | Glob, attributes, runtime update |
| Partitioning | `partition-manager.test.ts` | Rule matching, multi-provider |

### Integration Tests

- Two-peer RPC over real mesh connection
- Binary protocol negotiation between peers
- Streaming execution between peers
- Selective sync with filters active
- Partitioned sync across multiple peers

---

## Migration & Compatibility

### Binary Protocol Migration

1. **Phase 1**: Add MessagePack support with 'auto' default
2. **Phase 2**: Existing deployments continue working (JSON fallback)
3. **Phase 3**: Monitor adoption, consider deprecating JSON

### Config Backward Compatibility

All new config options have sensible defaults:
- `serialization: 'auto'` - negotiates best format
- `syncFilter: undefined` - syncs everything
- `partitioning: { enabled: false }` - single namespace

No breaking changes to existing configurations.

---

## Success Criteria Summary

| Phase | Feature | Key Metric |
|-------|---------|------------|
| 6.1 | RPC | Request/response works with timeout |
| 6.2 | Binary | MessagePack ~2-5x smaller than JSON |
| 7.1 | Streaming | stdout/stderr stream in real-time |
| 7.2 | Discovery | Peers discovered from lighthouses |
| 8.1 | Type Filter | Only configured types sync |
| 8.2 | ID/Attr Filter | Filters correctly applied |
| 8.3 | Partitioning | Subscribed partitions only |

---

## Appendix: Package Dependencies

```json
{
  "dependencies": {
    "@msgpack/msgpack": "^3.0.0",
    "picomatch": "^3.0.0",
    "yaml": "^2.3.0"
  },
  "devDependencies": {
    "@types/picomatch": "^2.3.0"
  }
}
```
