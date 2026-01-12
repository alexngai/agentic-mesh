// Tests using the official ACP SDK (@agentclientprotocol/sdk)
// Validates that our mesh stream implementation works with the official SDK
// Implements: s-4hjr

import { describe, it, expect, beforeEach } from 'vitest'
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type CancelNotification,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import { createConnectedStreams } from '../../src/acp/mesh-stream'

// =============================================================================
// Test Agent Implementation
// =============================================================================

class TestAgent implements Agent {
  private connection: AgentSideConnection
  private sessions: Map<string, { history: string[] }> = new Map()
  private sessionCounter = 0

  constructor(connection: AgentSideConnection) {
    this.connection = connection
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `test-session-${++this.sessionCounter}`
    this.sessions.set(sessionId, { history: [] })
    return {
      sessionId,
      availableModes: [
        { name: 'default', description: 'Default mode' },
      ],
      currentMode: 'default',
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {}
  }

  async setSessionMode(_params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`)
    }

    // Extract text from prompt content
    const textContent = params.prompt
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join(' ')

    session.history.push(textContent)

    // Send session update notification
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Echo: ${textContent}`,
        },
      },
    })

    return {
      stopReason: 'end_turn',
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    // No-op for simple test agent
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
    // Always allow for tests
    return {
      outcome: {
        outcome: 'approved',
        optionId: params.options[0]?.optionId ?? 'allow',
      },
    }
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('ACP SDK Integration', () => {
  describe('createConnectedStreams', () => {
    it('should create connected streams that pass messages', async () => {
      const [streamA, streamB] = createConnectedStreams()

      // Write to A, read from B
      const writer = streamA.writable.getWriter()
      const reader = streamB.readable.getReader()

      const testMessage = {
        jsonrpc: '2.0' as const,
        method: 'test',
        params: { foo: 'bar' },
      }

      await writer.write(testMessage)
      const { value } = await reader.read()

      expect(value).toEqual(testMessage)

      writer.releaseLock()
      reader.releaseLock()
    })
  })

  describe('AgentSideConnection + ClientSideConnection', () => {
    let agentConnection: AgentSideConnection
    let clientConnection: ClientSideConnection
    let testClient: TestClient

    beforeEach(() => {
      const [agentStream, clientStream] = createConnectedStreams()

      // Create agent connection
      agentConnection = new AgentSideConnection(
        (conn) => new TestAgent(conn),
        agentStream
      )

      // Create client connection
      testClient = new TestClient()
      clientConnection = new ClientSideConnection(
        (_agent) => testClient,
        clientStream
      )
    })

    it('should initialize connection', async () => {
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
    })

    it('should create a new session', async () => {
      // Initialize first
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const response = await clientConnection.newSession({
        cwd: '/tmp',
        mcpServers: [],
      })

      expect(response.sessionId).toMatch(/^test-session-/)
      expect(response.availableModes).toBeDefined()
      expect(response.currentMode).toBe('default')
    })

    it('should send prompt and receive response', async () => {
      // Initialize and create session
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const session = await clientConnection.newSession({
        cwd: '/tmp',
        mcpServers: [],
      })

      // Send prompt
      const response = await clientConnection.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'Hello, agent!' },
        ],
      })

      expect(response.stopReason).toBe('end_turn')

      // Check that session update was received
      // Give a moment for the notification to be processed
      await new Promise((r) => setTimeout(r, 50))

      expect(testClient.sessionUpdates.length).toBeGreaterThan(0)
      const update = testClient.sessionUpdates[0]
      expect(update.sessionId).toBe(session.sessionId)
    })

    it('should handle multiple sessions', async () => {
      await clientConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      })

      const session1 = await clientConnection.newSession({
        cwd: '/tmp',
        mcpServers: [],
      })
      const session2 = await clientConnection.newSession({
        cwd: '/tmp',
        mcpServers: [],
      })

      expect(session1.sessionId).not.toBe(session2.sessionId)

      // Send prompts to both sessions
      await clientConnection.prompt({
        sessionId: session1.sessionId,
        prompt: [{ type: 'text', text: 'Message to session 1' }],
      })

      await clientConnection.prompt({
        sessionId: session2.sessionId,
        prompt: [{ type: 'text', text: 'Message to session 2' }],
      })

      // Both should have updates
      await new Promise((r) => setTimeout(r, 50))
      expect(testClient.sessionUpdates.length).toBe(2)
    })
  })
})
