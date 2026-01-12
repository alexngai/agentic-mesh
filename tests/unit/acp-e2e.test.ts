// ACP Mesh End-to-End Tests
// Tests the full integration: ExampleAcpServer <-> AcpMeshAdapter <-> Mesh <-> AcpMeshAdapter <-> ExampleAcpServer
// Implements: s-4hjr

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { AcpMeshAdapter } from '../../src/acp/adapter'
import { ExampleAcpServer } from '../../examples/acp-server'
import type { AcpRequest, AcpResponse, AcpNotification, AcpMeshEnvelope } from '../../src/acp/types'
import { isAcpRequest } from '../../src/acp/types'
import type { PeerInfo } from '../../src/types'

// =============================================================================
// Mock Infrastructure (shared with acp-adapter.test.ts)
// =============================================================================

const channelRegistry = new Map<string, Map<string, MockMessageChannel>>()

class MockMessageChannel extends EventEmitter {
  private _opened = false
  private channelName: string
  private mesh: MockNebulaMesh
  private requestHandlers: Map<string, (response: unknown) => void> = new Map()

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

  async request<R>(peerId: string, message: unknown, timeout?: number): Promise<R> {
    return new Promise((resolve, reject) => {
      const targetChannel = channelRegistry.get(this.channelName)?.get(peerId)
      if (!targetChannel) {
        reject(new Error('Peer not found'))
        return
      }

      const requestId = Math.random().toString(36).slice(2)
      const from: PeerInfo = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
        lastSeen: new Date(),
        activeNamespaces: [],
        isHub: false,
      }

      // Set timeout
      const timer = setTimeout(() => {
        this.requestHandlers.delete(requestId)
        reject(new Error('Request timed out'))
      }, timeout || 5000)

      // Store response handler
      this.requestHandlers.set(requestId, (response: unknown) => {
        clearTimeout(timer)
        this.requestHandlers.delete(requestId)
        resolve(response as R)
      })

      // Send request to target - target will send response back
      setImmediate(() => {
        targetChannel.emit('message', message, from)
      })
    })
  }

  // Called when we receive a response to our request
  _handleResponse(response: unknown): void {
    // Find and call the first waiting handler (simple approach for tests)
    const handlers = Array.from(this.requestHandlers.values())
    if (handlers.length > 0) {
      handlers[0](response)
    }
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
// Test Helpers
// =============================================================================

interface TestPeer {
  mesh: MockNebulaMesh
  adapter: AcpMeshAdapter
  server: ExampleAcpServer
}

async function createTestPeer(peerId: string, groups: string[] = []): Promise<TestPeer> {
  const mesh = new MockNebulaMesh(peerId, groups)
  const adapter = new AcpMeshAdapter(mesh as any)
  const server = new ExampleAcpServer()

  // Wire up: adapter requests -> server
  adapter.onRequest(async (request, from, respond) => {
    const response = await server.handleRequest(request)
    respond(response)
  })

  // Wire up: server updates -> adapter broadcast
  server.on('session:update', (notification: AcpNotification) => {
    adapter.broadcast(notification)
  })

  await adapter.start()

  return { mesh, adapter, server }
}

async function cleanupTestPeer(peer: TestPeer): Promise<void> {
  await peer.server.cleanup()
  await peer.adapter.stop()
}

// =============================================================================
// E2E Tests
// =============================================================================

describe('ACP Mesh E2E', () => {
  let peerA: TestPeer
  let peerB: TestPeer
  let tempDir: string

  beforeEach(async () => {
    channelRegistry.clear()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-e2e-'))
    peerA = await createTestPeer('peer-a')
    peerB = await createTestPeer('peer-b')
  })

  afterEach(async () => {
    await cleanupTestPeer(peerA)
    await cleanupTestPeer(peerB)
    channelRegistry.clear()
    // Clean up temp dir
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('session operations', () => {
    it('should create session on remote peer', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'session/new',
        params: {},
      }

      // Peer A sends request to Peer B
      peerA.adapter.send('peer-b', request)

      // Wait for response to come back
      await new Promise((r) => setTimeout(r, 50))

      // Verify session was created on Peer B
      const sessions = peerB.server.getAllSessions()
      expect(sessions.length).toBe(1)
      expect(sessions[0].id).toMatch(/^session-/)
    })

    it('should send prompt and get response from remote peer', async () => {
      // First create a session on Peer B
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-create',
        method: 'session/new',
        params: {},
      }
      const createResponse = await peerB.server.handleRequest(createRequest)
      const sessionId = (createResponse.result as { sessionId: string }).sessionId

      // Now Peer A sends a prompt to Peer B's session
      const promptRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-prompt',
        method: 'session/prompt',
        params: { sessionId, content: 'Hello from Peer A' },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-prompt') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', promptRequest)
      await new Promise((r) => setTimeout(r, 200))

      expect(responses.length).toBe(1)
      expect(responses[0].result).toBeDefined()
      const result = responses[0].result as { content: Array<{ text: string }> }
      expect(result.content[0].text).toContain('Hello from Peer A')
    })
  })

  describe('terminal operations', () => {
    it('should execute command on remote peer', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-term',
        method: 'terminal/create',
        params: { command: 'echo "Hello from remote"' },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-term') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', request)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].result).toBeDefined()
      const result = responses[0].result as { terminalId: string }
      expect(result.terminalId).toMatch(/^term-/)
    })

    it('should get terminal output from remote peer', async () => {
      // Create terminal on Peer B
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-create',
        method: 'terminal/create',
        params: { command: 'echo "test output"' },
      }
      const createResponse = await peerB.server.handleRequest(createRequest)
      const terminalId = (createResponse.result as { terminalId: string }).terminalId

      // Wait for command to complete
      await new Promise((r) => setTimeout(r, 500))

      // Now Peer A requests output
      const outputRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-output',
        method: 'terminal/output',
        params: { terminalId },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-output') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', outputRequest)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].result).toBeDefined()
      const result = responses[0].result as { output: string }
      expect(result.output).toContain('test output')
    })

    it('should wait for terminal exit on remote peer', async () => {
      // Create terminal on Peer B with a short command
      const createRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-create',
        method: 'terminal/create',
        params: { command: 'echo "done"' },
      }
      const createResponse = await peerB.server.handleRequest(createRequest)
      const terminalId = (createResponse.result as { terminalId: string }).terminalId

      // Peer A waits for exit
      const waitRequest: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-wait',
        method: 'terminal/wait_for_exit',
        params: { terminalId, timeout: 5000 },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-wait') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', waitRequest)
      await new Promise((r) => setTimeout(r, 1000))

      expect(responses.length).toBe(1)
      expect(responses[0].result).toBeDefined()
      const result = responses[0].result as { exitCode: number }
      expect(result.exitCode).toBe(0)
    })
  })

  describe('file system operations', () => {
    it('should read file from remote peer', async () => {
      // Create a test file on "Peer B's filesystem" (using temp dir)
      const testFile = path.join(tempDir, 'remote-file.txt')
      await fs.writeFile(testFile, 'Content from Peer B')

      // Peer A requests to read the file
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-read',
        method: 'fs/read_text_file',
        params: { path: testFile },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-read') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', request)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].result).toBeDefined()
      const result = responses[0].result as { content: string }
      expect(result.content).toBe('Content from Peer B')
    })

    it('should write file on remote peer', async () => {
      const testFile = path.join(tempDir, 'written-file.txt')

      // Peer A requests to write a file on Peer B
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-write',
        method: 'fs/write_text_file',
        params: { path: testFile, content: 'Written by Peer A' },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-write') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', request)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].result).toBeDefined()
      const result = responses[0].result as { success: boolean }
      expect(result.success).toBe(true)

      // Verify file was actually written
      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe('Written by Peer A')
    })

    it('should return error for non-existent file', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-read',
        method: 'fs/read_text_file',
        params: { path: '/nonexistent/path/file.txt' },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-read') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', request)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].error).toBeDefined()
      expect(responses[0].error!.message).toContain('Failed to read file')
    })
  })

  describe('broadcast', () => {
    it('should broadcast session updates to all peers', async () => {
      const peerC = await createTestPeer('peer-c')

      const notificationsB: AcpNotification[] = []
      const notificationsC: AcpNotification[] = []

      peerB.adapter.onMessage((msg) => {
        if (!('id' in msg)) {
          notificationsB.push(msg as AcpNotification)
        }
      })
      peerC.adapter.onMessage((msg) => {
        if (!('id' in msg)) {
          notificationsC.push(msg as AcpNotification)
        }
      })

      // Create session on Peer A and send a prompt (which triggers session updates)
      const createResponse = await peerA.server.handleRequest({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'session/new',
        params: {},
      })
      const sessionId = (createResponse.result as { sessionId: string }).sessionId

      await peerA.server.handleRequest({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'session/prompt',
        params: { sessionId, content: 'Test prompt' },
      })

      await new Promise((r) => setTimeout(r, 200))

      // Both Peer B and Peer C should have received the session updates
      expect(notificationsB.length).toBeGreaterThan(0)
      expect(notificationsC.length).toBeGreaterThan(0)
      expect(notificationsB[0].method).toBe('session/update')
      expect(notificationsC[0].method).toBe('session/update')

      await cleanupTestPeer(peerC)
    })
  })

  describe('multi-peer scenarios', () => {
    it('should handle requests from multiple peers', async () => {
      const peerC = await createTestPeer('peer-c')

      // Both Peer A and Peer C send requests to Peer B
      const requestA: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-from-a',
        method: 'terminal/create',
        params: { command: 'echo "from A"' },
      }
      const requestC: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-from-c',
        method: 'terminal/create',
        params: { command: 'echo "from C"' },
      }

      const responsesA: AcpResponse[] = []
      const responsesC: AcpResponse[] = []

      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-from-a') {
          responsesA.push(msg as AcpResponse)
        }
      })
      peerC.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-from-c') {
          responsesC.push(msg as AcpResponse)
        }
      })

      // Send both requests
      peerA.adapter.send('peer-b', requestA)
      peerC.adapter.send('peer-b', requestC)

      await new Promise((r) => setTimeout(r, 200))

      // Both should get responses
      expect(responsesA.length).toBe(1)
      expect(responsesC.length).toBe(1)
      expect((responsesA[0].result as { terminalId: string }).terminalId).toMatch(/^term-/)
      expect((responsesC[0].result as { terminalId: string }).terminalId).toMatch(/^term-/)

      await cleanupTestPeer(peerC)
    })

    it('should handle bidirectional requests', async () => {
      // Peer A requests from Peer B
      const requestAtoB: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-a-to-b',
        method: 'session/new',
        params: {},
      }

      // Peer B requests from Peer A
      const requestBtoA: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-b-to-a',
        method: 'session/new',
        params: {},
      }

      const responsesA: AcpResponse[] = []
      const responsesB: AcpResponse[] = []

      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-a-to-b') {
          responsesA.push(msg as AcpResponse)
        }
      })
      peerB.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-b-to-a') {
          responsesB.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', requestAtoB)
      peerB.adapter.send('peer-a', requestBtoA)

      await new Promise((r) => setTimeout(r, 100))

      // Both peers should have created sessions
      expect(responsesA.length).toBe(1)
      expect(responsesB.length).toBe(1)
      expect(peerA.server.getAllSessions().length).toBe(1)
      expect(peerB.server.getAllSessions().length).toBe(1)
    })
  })

  describe('error handling', () => {
    it('should return error for unknown method', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-unknown',
        method: 'unknown/method',
        params: {},
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-unknown') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', request)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].error).toBeDefined()
      expect(responses[0].error!.message).toContain('Unknown method')
    })

    it('should return error for invalid session', async () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 'req-invalid',
        method: 'session/prompt',
        params: { sessionId: 'nonexistent', content: 'test' },
      }

      const responses: AcpResponse[] = []
      peerA.adapter.onMessage((msg) => {
        if ('id' in msg && msg.id === 'req-invalid') {
          responses.push(msg as AcpResponse)
        }
      })

      peerA.adapter.send('peer-b', request)
      await new Promise((r) => setTimeout(r, 100))

      expect(responses.length).toBe(1)
      expect(responses[0].error).toBeDefined()
      expect(responses[0].error!.message).toContain('Session not found')
    })
  })
})
