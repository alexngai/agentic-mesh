# Tailscale/Headscale vs Nebula Evaluation

This document evaluates whether Tailscale/Headscale would be a better fit for agentic-mesh compared to the current Nebula-based implementation.

## Executive Summary

**Recommendation: Support both Nebula and Tailscale/Headscale via a transport abstraction layer.**

Tailscale/Headscale offers significant advantages for the "hosted flow" use case (zero-config, managed infrastructure), while Nebula remains superior for the "self-hosted flow" (complete control, no external dependencies). Given the project's dual requirements, implementing a pluggable transport layer is the recommended approach.

---

## Current Nebula Implementation Analysis

### Nebula Dependencies in agentic-mesh

The codebase has ~20-25% Nebula-specific code concentrated in:

| Module | Lines | Nebula Coupling |
|--------|-------|-----------------|
| `src/mesh/nebula-mesh.ts` | 1,361 | High - uses Nebula IPs directly |
| `src/mesh/nebula-config-parser.ts` | 480 | High - parses Nebula YAML configs |
| `src/certs/config-generator.ts` | 300+ | High - generates Nebula configs |
| `src/certs/cert-manager.ts` | ~200 | Medium - uses `nebula-cert` binary |
| `src/certs/lighthouse-manager.ts` | ~150 | High - manages Nebula lighthouse |
| `src/mesh/peer-discovery.ts` | 140+ | Medium - lighthouse-based discovery |

### Key Nebula Features Used

1. **Certificate-based PKI** - Three-tier hierarchy (Root CA → User CA → Server certs)
2. **Lighthouse discovery** - Peers find each other via `static_host_map`
3. **Certificate groups** - Embedded groups for permissions/firewall rules
4. **Built-in firewall** - Stateful packet filtering in config
5. **NAT traversal** - UDP hole punching via lighthouses

---

## Architecture Comparison

| Aspect | Nebula | Tailscale (Hosted) | Headscale (Self-hosted) |
|--------|--------|-------------------|------------------------|
| **Protocol** | Noise Protocol | WireGuard (userspace) | WireGuard (userspace) |
| **Control Plane** | Self-hosted lighthouses | Tailscale cloud (closed source) | Self-hosted (open source) |
| **Discovery** | Lighthouse servers | Coordination servers | Headscale coordination |
| **Auth Model** | Certificate-based PKI | OAuth2 + machine keys | OAuth2/OIDC + machine keys |
| **Setup Complexity** | High (CA, certs, config) | Very Low (install + login) | Medium (server + config) |
| **Memory Usage** | ~27MB (consistent) | Variable (can exceed 1GB) | Similar to Tailscale |
| **Open Source** | Fully open source | Client open, server closed | Fully open source |
| **NAT Traversal** | Lighthouses | DERP relays (global network) | Embedded DERP (self-hosted) |

---

## Self-Hosted vs Hosted Flow Comparison

### Hosted Flow (Tailscale)

**Pros:**
- Zero infrastructure to manage
- Instant setup (install, login, done)
- Global DERP relay network for reliability
- Automatic key rotation and management
- Web dashboard for administration
- Built-in SSO/OAuth integration
- MagicDNS for automatic naming

**Cons:**
- Coordination server is closed source
- Reliance on Tailscale's infrastructure
- Privacy concerns (control plane sees metadata)
- Costs scale with usage (free tier has limits)
- No offline-only operation possible

### Self-Hosted Flow (Headscale)

**Pros:**
- Complete control over coordination server
- No external dependencies once deployed
- Open source (MIT license)
- Uses official Tailscale clients
- gRPC + REST APIs for programmatic access
- OIDC/SAML integration for auth

**Cons:**
- Requires dedicated IPv4+IPv6 (CGNAT issues)
- Self-hosted DERP limits geographic distribution
- Some Tailscale features missing (Funnel, Serve, dynamic ACLs)
- More operational overhead than Nebula
- Single-tailnet limitation

### Self-Hosted Flow (Nebula - Current)

**Pros:**
- Truly self-contained (no external servers required)
- Deterministic memory usage
- Certificate-based identity (no OAuth needed)
- Complete firewall control
- Battle-tested at scale (Slack: 50k+ hosts)
- Works offline/air-gapped

**Cons:**
- Complex initial setup (CA, certificates, configs)
- No hosted option available
- Manual certificate distribution
- Less user-friendly than Tailscale
- Requires `nebula` and `nebula-cert` binaries

---

## API & Programmatic Integration

### Tailscale API

- **REST API** at `api.tailscale.com`
- **Authentication**: API keys or OAuth client credentials
- **Capabilities**: Device management, ACLs, auth keys, DNS, routes
- **SDKs**:
  - Go: `tsnet` (embed Tailscale in Go programs)
  - Node.js: No official SDK (HTTP calls or Pulumi provider)
  - Python: Community `tailscale` package

### Headscale API

- **gRPC API** (primary, 25 RPC methods)
- **REST API** at `/api/v1/*` (auto-generated from gRPC)
- **OpenAPI spec** at `/swagger`
- **Authentication**: API keys (Bearer token)
- **Capabilities**: Users, nodes, pre-auth keys, ACLs, policies

### Nebula (Current)

- **No API** - Configuration file-based
- **Binary calls**: `nebula-cert` for certificate operations
- **Lighthouse protocol**: Custom UDP protocol for discovery

---

## Migration Complexity Assessment

### Required Changes for Tailscale/Headscale Support

#### 1. Transport Abstraction Layer (New)

```typescript
interface MeshTransport {
  // Connection
  connect(peer: PeerInfo): Promise<Connection>;
  listen(port: number): Promise<void>;

  // Identity
  getLocalIdentity(): Promise<PeerIdentity>;
  verifyPeer(connection: Connection): Promise<PeerIdentity>;

  // Discovery
  discoverPeers(): AsyncIterable<PeerInfo>;
  announceSelf(): Promise<void>;
}

interface TransportFactory {
  createTransport(config: TransportConfig): MeshTransport;
}
```

#### 2. Files Requiring Modification

| File | Change Type | Effort |
|------|-------------|--------|
| `src/mesh/nebula-mesh.ts` | Refactor to use `MeshTransport` | High |
| `src/mesh/nebula-config-parser.ts` | Extract to transport-specific | Medium |
| `src/certs/config-generator.ts` | Make transport-agnostic | Medium |
| `src/certs/cert-manager.ts` | Abstract certificate provider | Medium |
| `src/mesh/peer-discovery.ts` | Use transport discovery interface | Low |
| `src/types/index.ts` | Add transport abstractions | Low |

#### 3. New Modules Required

```
src/transports/
├── index.ts                 # Transport factory
├── interface.ts             # MeshTransport interface
├── nebula/
│   ├── transport.ts         # NebulaTransport implementation
│   ├── config-parser.ts     # Moved from mesh/
│   └── cert-manager.ts      # Nebula-specific cert handling
└── tailscale/
    ├── transport.ts         # TailscaleTransport implementation
    ├── api-client.ts        # Tailscale/Headscale API client
    └── discovery.ts         # Coordination-based discovery
```

### Estimated Effort

| Task | Estimate |
|------|----------|
| Transport abstraction design | 2-3 days |
| Refactor NebulaMesh to use abstraction | 3-4 days |
| Implement TailscaleTransport | 4-5 days |
| Implement HeadscaleTransport (extends Tailscale) | 1-2 days |
| Update tests | 2-3 days |
| Documentation | 1-2 days |
| **Total** | **13-19 days** |

---

## Feature Parity Matrix

| Feature | Nebula | Tailscale | Headscale |
|---------|--------|-----------|-----------|
| P2P encrypted tunnels | ✅ | ✅ | ✅ |
| NAT traversal | ✅ | ✅ | ✅ |
| Certificate identity | ✅ | ❌ (OAuth) | ❌ (OAuth) |
| Built-in firewall | ✅ | ✅ (ACLs) | ✅ (ACLs) |
| Group-based permissions | ✅ | ✅ (tags) | ✅ (tags) |
| Offline operation | ✅ | ❌ | ⚠️ (limited) |
| Hosted option | ❌ | ✅ | ❌ |
| Self-hosted option | ✅ | ❌ | ✅ |
| Web dashboard | ❌ | ✅ | ⚠️ (Headplane) |
| SSO integration | ❌ | ✅ | ✅ |
| API access | ❌ | ✅ | ✅ |
| Air-gapped deployment | ✅ | ❌ | ⚠️ |
| Memory efficiency | ✅ (27MB) | ❌ (variable) | ❌ (variable) |

---

## Recommendations

### Recommended Approach: Pluggable Transport Layer

Given the dual requirements (self-hosted + hosted), implement a transport abstraction that supports multiple backends:

```
┌─────────────────────────────────────────────┐
│              agentic-mesh                   │
├─────────────────────────────────────────────┤
│  MessageChannel │ YjsSync │ CrSqliteSync    │
├─────────────────────────────────────────────┤
│           MeshTransport Interface           │
├──────────┬──────────────┬───────────────────┤
│  Nebula  │   Tailscale  │    Headscale      │
│ Transport│   Transport  │    Transport      │
└──────────┴──────────────┴───────────────────┘
```

### Use Case Mapping

| Use Case | Recommended Transport |
|----------|----------------------|
| Enterprise air-gapped | Nebula |
| Quick dev/testing | Tailscale (hosted) |
| Privacy-conscious self-host | Headscale |
| Hybrid (internal + external) | Headscale + Nebula |
| Consumer/SaaS product | Tailscale (hosted) |

### Implementation Priority

1. **Phase 1**: Extract transport abstraction from current Nebula code
2. **Phase 2**: Implement Tailscale transport (hosted flow)
3. **Phase 3**: Implement Headscale transport (self-hosted alternative)
4. **Phase 4**: Consider dual-transport mode for hybrid deployments

### Configuration Example

```typescript
// Nebula (current)
const mesh = await createMesh({
  transport: 'nebula',
  nebula: {
    configPath: '/etc/nebula/config.yml'
  }
});

// Tailscale (hosted)
const mesh = await createMesh({
  transport: 'tailscale',
  tailscale: {
    authKey: process.env.TAILSCALE_AUTH_KEY,
    hostname: 'agent-node-1'
  }
});

// Headscale (self-hosted)
const mesh = await createMesh({
  transport: 'headscale',
  headscale: {
    serverUrl: 'https://headscale.example.com',
    apiKey: process.env.HEADSCALE_API_KEY,
    preAuthKey: '...'
  }
});
```

---

## Conclusion

Tailscale/Headscale offers compelling advantages for user experience and hosted deployments, but Nebula's self-contained nature remains valuable for enterprise and air-gapped scenarios. The recommended path forward is implementing a transport abstraction layer that preserves the existing Nebula functionality while enabling Tailscale and Headscale as alternative backends.

This approach:
- Maintains backward compatibility with existing Nebula users
- Enables a "zero-config" hosted flow via Tailscale
- Provides a self-hosted alternative via Headscale
- Allows users to choose based on their specific requirements

---

## References

- [Tailscale API Documentation](https://tailscale.com/api)
- [Headscale GitHub](https://github.com/juanfont/headscale)
- [Headscale API Documentation](http://headscale.net/development/ref/api/)
- [Tailscale vs Nebula Comparison](https://tailscale.com/compare/nebula)
- [Tailscale Open Source Policy](https://tailscale.com/opensource)
- [tsnet Documentation](https://tailscale.com/kb/1244/tsnet)
