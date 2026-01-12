// ACP SDK E2E Tests - Using official @agentclientprotocol/sdk
// Tests ExampleAcpAgent with real AgentSideConnection/ClientSideConnection over mesh streams
// Implements: s-4hjr

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import { ExampleAcpAgent } from '../../examples/acp-server'
import { meshStream, createConnectedStreams } from '../../src/acp/mesh-stream'
import type { AcpMeshEnvelope } from '../../src/acp/mesh-stream'
import type { PeerInfo } from '../../src/types'

// =============================================================================
// Mock Mesh Infrastructure
// =============================================================================

const channelRegistry = new Map<string, Map<string, MockMessageChannel>>()

class MockMessageChannel extends EventEmitter {
  private _opened = false
  private channelName: string
  private mesh: MockNebulaMesh
  private messageHandlers: Set<(message: unknown, from: PeerInfo) => void> = new Set()

  constructor(mesh: MockNebulaMesh, channelName: string) {
    super()
    this.mesh = mesh
    this.channelName = channelName
  }

  async open(): Promise<void> {
    this._opened = true
    if (!channelRegistry.has(this.channelName)) {
      channelRegistry.set(this.channelName, new Map())
    }
    channelRegistry.get(this.channelName)!.set(this.mesh.peerId, this)
  }

  async close(): Promise<void> {
    this._opened = false
    channelRegistry.get(this.channelName)?.delete(this.mesh.peerId)
  }

  get isOpen(): boolean {
    return this._opened
  }

  send(peerId: string, message: unknown): boolean {
    const targetChannel = channelRegistry.get(this.channelName)?.get(peerId)
    if (targetChannel) {
      const from: PeerInfo = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }
      setImmediate(() => targetChannel.emit('message', message, from))
      return true
    }
    return false
  }

  broadcast(message: unknown): void {
    const channels = channelRegistry.get(this.channelName)
    if (channels) {
      const from: PeerInfo = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }
      for (const [peerId, channel] of Array.from(channels.entries())) {
        if (peerId !== this.mesh.peerId) {
          setImmediate(() => channel.emit('message', message, from))
        }
      }
    }
  }

  on(event: 'message', handler: (message: unknown, from: PeerInfo) => void): this {
    super.on(event, handler)
    return this
  }

  off(event: 'message', handler: (message: unknown, from: PeerInfo) => void): this {
    super.off(event, handler)
    return this
  }
}

class MockNebulaMesh extends EventEmitter {
  peerId: string
  groups: string[]
  private channels: Map<string, MockMessageChannel> = new Map()

  constructor(peerId: string, groups: string[] = []) {
    super()
    this.peerId = peerId
    this.groups = groups
  }

  createChannel<T>(name: string): MockMessageChannel {
    if (this.channels.has(name)) {
      return this.channels.get(name)!
    }
    const channel = new MockMessageChannel(this, name)
    // Auto-open for testing
    channel.open()
    this.channels.set(name, channel)
    return channel
  }

  getSelf(): PeerInfo {
    return {
      id: this.peerId,
      groups: this.groups,
      status: 'online',
      lastSeen: new Date(),
      activeNamespaces: [],
      isHub: false,
    }
  }

  getChannel(name: string): MockMessageChannel | undefined {
    return this.channels.get(name)
  }
}

// =============================================================================
// Test Client Implementation
// =============================================================================

class TestClient implements Client {
  public sessionUpdates: SessionNotification[] = []
  public permissionRequests: RequestPermissionRequest[] = []

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdates.push(params)
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params)
    return {
      outcome: {
        outcome: 'approved',
        optionId: params.options[0]?.optionId ?? 'allow',
      },
    }
  }
}

// =============================================================================
// E2E Tests with Official ACP SDK
// =============================================================================

describe('ACP SDK E2E with Mesh', () => {
  let tempDir: string

  beforeEach(async () => {
    channelRegistry.clear()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-sdk-e2e-'))
  })

  afterEach(async () => {
    channelRegistry.clear()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('Direct Connected Streams (createConnectedStreams)', () => {
    let agentConnection: AgentSideConnection
    let clientConnection: ClientSideConnection
    let testClient: TestClient
    let agent: ExampleAcpAgent | null = null

    beforeEach(() => {
      const [agentStream, clientStream] = createConnectedStreams()

      // Create agent connection with ExampleAcpAgent
      agentConnection = new AgentSideConnection(
        (conn) => {
          agent = new ExampleAcpAgent(conn)
          return agent
        },
        agentStream
      )

      // Create client connection
      testClient = new TestClient()
      clientConnection = new ClientSideConnection(
        (_agent) => testClient,
        clientStream
      )
    })

    afterEach(async () => {
      if (agent) {
        await agent.cleanup()
      }
    })

    it('should initialize ExampleAcpAgent through SDK', async () => {
      const response = await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      })

      expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(response.agentCapabilities).toBeDefined()
      expect(response.agentInfo?.name).toBe('ExampleAcpAgent')
    })

    it('should create session and send prompt through SDK', async () => {
      // Initialize
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      // Create session
      const session = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })

      expect(session.sessionId).toMatch(/^session-/)
      expect(session.availableModes).toBeDefined()
      expect(session.currentMode).toBe('default')

      // Send prompt
      const response = await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'Hello, ExampleAcpAgent!' },
        ],
      })

      expect(response.stopReason).toBe('end_turn')

      // Check session updates were received
      await new Promise((r) => setTimeout(r, 50))
      expect(testClient.sessionUpdates.length).toBeGreaterThan(0)
      expect(testClient.sessionUpdates[0].sessionId).toBe(session.sessionId)
    })

    it('should handle multiple prompts in single session', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const session = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })

      // Send multiple prompts
      await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'First message' }],
      })

      await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Second message' }],
      })

      await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Third message' }],
      })

      // Wait for all updates
      await new Promise((r) => setTimeout(r, 100))

      // Should have received session updates for all prompts
      expect(testClient.sessionUpdates.length).toBeGreaterThanOrEqual(3)
    })

    it('should handle multiple sessions', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const session1 = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })
      const session2 = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })

      expect(session1.sessionId).not.toBe(session2.sessionId)

      // Send to both sessions
      await clientConnection.prompt({
        sessionId: session1.sessionId,
        prompt: [{ type: 'text', text: 'Message to session 1' }],
      })

      await clientConnection.prompt({
        sessionId: session2.sessionId,
        prompt: [{ type: 'text', text: 'Message to session 2' }],
      })

      await new Promise((r) => setTimeout(r, 100))

      // Should have updates from both sessions
      const session1Updates = testClient.sessionUpdates.filter(u => u.sessionId === session1.sessionId)
      const session2Updates = testClient.sessionUpdates.filter(u => u.sessionId === session2.sessionId)
      expect(session1Updates.length).toBeGreaterThan(0)
      expect(session2Updates.length).toBeGreaterThan(0)
    })

    it('should handle setSessionMode', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const session = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })

      // Set mode to agent (SDK uses modeId, not mode)
      await clientConnection.setSessionMode({
        sessionId: session.sessionId,
        modeId: 'agent',
      })

      // Verify mode was set (via agent internal state)
      expect(agent?.getSession(session.sessionId)?.mode).toBe('agent')
    })

    it('should handle authentication', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      // Authenticate should complete without error (SDK uses methodId)
      await expect(clientConnection.authenticate({
        methodId: 'api_key',
      })).resolves.toBeDefined()
    })
  })

  describe('Mesh Stream Integration (meshStream)', () => {
    let meshA: MockNebulaMesh
    let meshB: MockNebulaMesh
    let agentConnection: AgentSideConnection
    let clientConnection: ClientSideConnection
    let testClient: TestClient
    let agent: ExampleAcpAgent | null = null

    beforeEach(() => {
      // Create two mock mesh instances
      meshA = new MockNebulaMesh('peer-a')
      meshB = new MockNebulaMesh('peer-b')

      // Agent on peer-b, client on peer-a
      const agentStream = meshStream(meshB as any, { peerId: 'peer-a' })
      const clientStream = meshStream(meshA as any, { peerId: 'peer-b' })

      // Create agent connection with ExampleAcpAgent
      agentConnection = new AgentSideConnection(
        (conn) => {
          agent = new ExampleAcpAgent(conn)
          return agent
        },
        agentStream
      )

      // Create client connection
      testClient = new TestClient()
      clientConnection = new ClientSideConnection(
        (_agent) => testClient,
        clientStream
      )
    })

    afterEach(async () => {
      if (agent) {
        await agent.cleanup()
      }
    })

    it('should initialize agent over mesh stream', async () => {
      const response = await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: 'mesh-client',
          version: '1.0.0',
        },
      })

      expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(response.agentInfo?.name).toBe('ExampleAcpAgent')
    })

    it('should create session and prompt over mesh', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'mesh-test', version: '1.0' },
      })

      const session = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })

      expect(session.sessionId).toMatch(/^session-/)

      const response = await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'Hello over mesh!' },
        ],
      })

      expect(response.stopReason).toBe('end_turn')

      // Verify session updates came through
      await new Promise((r) => setTimeout(r, 100))
      expect(testClient.sessionUpdates.length).toBeGreaterThan(0)
    })

    it('should route messages through correct peer', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const session = await clientConnection.newSession({
        cwd: tempDir,
        mcpServers: [],
      })

      // Send prompt and verify it reached the agent
      await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Test routing' }],
      })

      // Verify agent has the session and history
      expect(agent?.getSession(session.sessionId)).toBeDefined()
      const agentSession = agent?.getSession(session.sessionId)
      expect(agentSession?.history.length).toBeGreaterThan(0)
    })
  })

  describe('Error handling with SDK', () => {
    it('should handle session not found error', async () => {
      const [agentStream, clientStream] = createConnectedStreams()

      const agentConnection = new AgentSideConnection(
        (conn) => new ExampleAcpAgent(conn),
        agentStream
      )

      const testClient = new TestClient()
      const clientConnection = new ClientSideConnection(
        (_agent) => testClient,
        clientStream
      )

      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      // Try to prompt with non-existent session
      // SDK wraps errors as "Internal error" with details in data field
      await expect(clientConnection.prompt({
        sessionId: 'nonexistent-session',
        prompt: [{ type: 'text', text: 'test' }],
      })).rejects.toThrow()
    })
  })
})
