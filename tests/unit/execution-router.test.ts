import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  ExecutionRouter,
  ExecutionRequestEvent,
  ExecutionResponse,
} from '../../src/mesh/execution-router'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Global channel registry for cross-mesh communication
const channelRegistry = new Map<string, Map<string, MockMessageChannel>>()

// Mock MessageChannel for execution router
class MockMessageChannel extends EventEmitter {
  private _opened = false
  private namespace: string
  private mesh: MockNebulaMesh

  constructor(mesh: MockNebulaMesh, namespace: string) {
    super()
    this.mesh = mesh
    this.namespace = namespace
  }

  async open(): Promise<void> {
    this._opened = true
    // Register in global registry
    if (!channelRegistry.has(this.namespace)) {
      channelRegistry.set(this.namespace, new Map())
    }
    channelRegistry.get(this.namespace)!.set(this.mesh.peerId, this)
  }

  async close(): Promise<void> {
    this._opened = false
    channelRegistry.get(this.namespace)?.delete(this.mesh.peerId)
  }

  get opened(): boolean {
    return this._opened
  }

  send(peerId: string, message: unknown): boolean {
    const targetChannel = channelRegistry.get(this.namespace)?.get(peerId)
    if (targetChannel) {
      const from = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
      }
      setImmediate(() => targetChannel.emit('message', message, from))
      return true
    }
    return false
  }

  broadcast(message: unknown): void {
    const channels = channelRegistry.get(this.namespace)
    if (channels) {
      const from = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
      }
      for (const [peerId, channel] of channels) {
        if (peerId !== this.mesh.peerId) {
          setImmediate(() => channel.emit('message', message, from))
        }
      }
    }
  }

  async request<R>(peerId: string, message: unknown, _timeout?: number): Promise<R> {
    return new Promise((resolve, reject) => {
      const targetChannel = channelRegistry.get(this.namespace)?.get(peerId)
      if (!targetChannel) {
        reject(new Error('Peer not found'))
        return
      }

      const requestId = Math.random().toString(36).slice(2)
      const from = {
        id: this.mesh.peerId,
        groups: this.mesh.groups,
        status: 'online',
      }

      // Send to target and expect response
      setImmediate(() => targetChannel.emit('message', message, from))

      // For simplicity, just resolve with the message (tests will handle response)
      setTimeout(() => reject(new Error('Request timed out')), _timeout || 5000)
    })
  }
}

// Mock NebulaMesh to avoid creating real network connections
class MockNebulaMesh extends EventEmitter {
  config: { peerId: string; groups?: string[] }
  _connected = false
  private peers = new Map<string, { id: string; status: string; groups: string[] }>()
  private channels = new Map<string, MockMessageChannel>()
  private otherMesh: MockNebulaMesh | null = null

  constructor(config: { peerId: string; peers?: { id: string }[]; groups?: string[] }) {
    super()
    this.config = config
    // Pre-populate peers from config
    if (config.peers) {
      for (const p of config.peers) {
        this.peers.set(p.id, { id: p.id, status: 'online', groups: [] })
      }
    }
  }

  async connect() {
    this._connected = true
  }

  async disconnect() {
    this._connected = false
    // Close all channels
    for (const channel of this.channels.values()) {
      await channel.close()
    }
  }

  get connected() {
    return this._connected
  }

  get peerId() {
    return this.config.peerId
  }

  get groups() {
    return this.config.groups || []
  }

  // Link two mock meshes for bidirectional communication
  linkTo(other: MockNebulaMesh) {
    this.otherMesh = other
    other.otherMesh = this
    // Update peer info with groups
    this.peers.set(other.peerId, { id: other.peerId, status: 'online', groups: other.groups })
    other.peers.set(this.peerId, { id: this.peerId, status: 'online', groups: this.groups })
  }

  getPeer(peerId: string) {
    return this.peers.get(peerId)
  }

  getPeers() {
    return Array.from(this.peers.values())
  }

  getOnlinePeers() {
    return Array.from(this.peers.values()).filter((p) => p.status === 'online')
  }

  createChannel<T>(namespace: string): MockMessageChannel {
    if (!this.channels.has(namespace)) {
      this.channels.set(namespace, new MockMessageChannel(this, namespace))
    }
    return this.channels.get(namespace)!
  }

  getActiveNamespaces() {
    return new Map()
  }
}

// Use the mock instead of real NebulaMesh
type NebulaMesh = MockNebulaMesh

describe('ExecutionRouter', () => {
  let meshA: NebulaMesh
  let meshB: NebulaMesh
  let routerA: ExecutionRouter
  let routerB: ExecutionRouter

  beforeEach(async () => {
    meshA = new MockNebulaMesh({
      peerId: 'peer-a',
      peers: [{ id: 'peer-b' }],
      groups: ['admin', 'developers'],
    })

    meshB = new MockNebulaMesh({
      peerId: 'peer-b',
      peers: [{ id: 'peer-a' }],
      groups: ['developers'],
    })

    // Link the mock meshes for bidirectional communication
    meshA.linkTo(meshB)

    // Connect both
    await Promise.all([meshA.connect(), meshB.connect()])
  })

  afterEach(async () => {
    if (routerA) routerA.cancelAll()
    if (routerB) routerB.cancelAll()

    await Promise.all([meshA?.disconnect(), meshB?.disconnect()])

    // Clear channel registry to avoid cross-test contamination
    channelRegistry.clear()
  })

  describe('initialization', () => {
    it('should create router with default config', () => {
      routerA = new ExecutionRouter(meshA)
      expect(routerA.pendingCount).toBe(0)
      expect(routerA.activeCount).toBe(0)
    })

    it('should create router with custom config', () => {
      routerA = new ExecutionRouter(meshA, {
        defaultTimeout: 5000,
        requiredGroups: ['admin'],
        maxConcurrent: 5,
      })
      expect(routerA).toBeDefined()
    })
  })

  describe('requestExecution', () => {
    beforeEach(async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB)
      // Ensure routers are started
      await Promise.all([routerA.start(), routerB.start()])
    })

    it('should throw error for non-existent peer', async () => {
      await expect(routerA.requestExecution('non-existent', 'ls')).rejects.toThrow(
        'Peer not found'
      )
    })

    it('should send execution request to peer', async () => {
      const requestHandler = vi.fn((event: ExecutionRequestEvent) => {
        event.respond({
          success: true,
          exitCode: 0,
          stdout: 'file1.txt\nfile2.txt',
        })
      })

      routerB.on('execution:requested', requestHandler)

      const response = await routerA.requestExecution('peer-b', 'ls', {
        args: ['-la'],
        cwd: '/tmp',
      })

      expect(requestHandler).toHaveBeenCalled()
      expect(response.success).toBe(true)
      expect(response.stdout).toBe('file1.txt\nfile2.txt')
    })

    it('should pass command arguments in request', async () => {
      let receivedRequest: { command: string; args?: string[] } | null = null

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        receivedRequest = {
          command: event.request.command,
          args: event.request.args,
        }
        event.respond({ success: true })
      })

      await routerA.requestExecution('peer-b', 'git', {
        args: ['status', '-s'],
      })

      expect(receivedRequest).not.toBeNull()
      expect(receivedRequest?.command).toBe('git')
      expect(receivedRequest?.args).toEqual(['status', '-s'])
    })

    it('should timeout if no response received', async () => {
      // Don't set up handler on B (no response)
      await expect(
        routerA.requestExecution('peer-b', 'sleep', { timeout: 100 })
      ).rejects.toThrow('timed out')
    })

    it('should handle execution failure response', async () => {
      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        event.respond({
          success: false,
          exitCode: 1,
          stderr: 'Command not found',
          error: 'Execution failed',
        })
      })

      const response = await routerA.requestExecution('peer-b', 'invalid-cmd')

      expect(response.success).toBe(false)
      expect(response.error).toBe('Execution failed')
    })
  })

  describe('permission checking', () => {
    it('should allow execution when peer has required group', async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB, {
        requiredGroups: ['developers'],
      })
      await Promise.all([routerA.start(), routerB.start()])

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        event.respond({ success: true })
      })

      // peer-a has 'developers' group
      const response = await routerA.requestExecution('peer-b', 'ls')
      expect(response.success).toBe(true)
    })

    it('should deny execution when peer lacks required group', async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB, {
        requiredGroups: ['superadmin'], // peer-a doesn't have this
      })
      await Promise.all([routerA.start(), routerB.start()])

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        event.respond({ success: true })
      })

      const response = await routerA.requestExecution('peer-b', 'ls')
      expect(response.success).toBe(false)
      expect(response.error).toContain('Permission denied')
    })

    it('should allow all when no required groups specified', async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB, {
        requiredGroups: [], // Allow all
      })
      await Promise.all([routerA.start(), routerB.start()])

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        event.respond({ success: true })
      })

      const response = await routerA.requestExecution('peer-b', 'ls')
      expect(response.success).toBe(true)
    })
  })

  describe('concurrent execution limit', () => {
    it('should reject when max concurrent reached', async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB, {
        maxConcurrent: 1,
      })
      await Promise.all([routerA.start(), routerB.start()])

      // First request - don't respond immediately
      let firstRespond: ((r: Omit<ExecutionResponse, 'requestId'>) => void) | null = null
      let requestCount = 0

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        requestCount++
        if (requestCount === 1) {
          firstRespond = event.respond
          // Don't respond yet - keep execution active
        } else {
          event.respond({ success: true })
        }
      })

      // Start first request (don't await)
      const firstPromise = routerA.requestExecution('peer-b', 'sleep', { timeout: 5000 })

      // Wait for first request to be received
      await sleep(200)

      // Second request should be rejected due to limit
      const secondResponse = await routerA.requestExecution('peer-b', 'echo')

      expect(secondResponse.success).toBe(false)
      expect(secondResponse.error).toContain('too many concurrent')

      // Complete first request
      firstRespond!({ success: true })
      const firstResponse = await firstPromise
      expect(firstResponse.success).toBe(true)
    })
  })

  describe('broadcastExecution', () => {
    it('should send to all online peers', async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB)
      await Promise.all([routerA.start(), routerB.start()])

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        event.respond({
          success: true,
          stdout: `Response from peer-b`,
        })
      })

      const results = await routerA.broadcastExecution('hostname')

      expect(results.size).toBeGreaterThan(0)
      const peerBResult = results.get('peer-b')
      expect(peerBResult?.success).toBe(true)
    })
  })

  describe('request management', () => {
    beforeEach(async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB)
      await Promise.all([routerA.start(), routerB.start()])
    })

    it('should track pending request count', async () => {
      // Don't respond on B
      expect(routerA.pendingCount).toBe(0)

      // Start request but don't await
      const promise = routerA.requestExecution('peer-b', 'sleep', { timeout: 5000 })

      // Wait for request to be sent
      await sleep(100)

      expect(routerA.pendingCount).toBe(1)

      // Cancel to clean up
      routerA.cancelAll()

      await expect(promise).rejects.toThrow('cancelled')
      expect(routerA.pendingCount).toBe(0)
    })

    it('should cancel all pending requests', async () => {
      // Don't respond on B
      const promise1 = routerA.requestExecution('peer-b', 'cmd1', { timeout: 5000 })
      const promise2 = routerA.requestExecution('peer-b', 'cmd2', { timeout: 5000 })

      await sleep(100)

      expect(routerA.pendingCount).toBe(2)

      routerA.cancelAll()

      await expect(promise1).rejects.toThrow('cancelled')
      await expect(promise2).rejects.toThrow('cancelled')
      expect(routerA.pendingCount).toBe(0)
    })
  })

  describe('execution:requested event', () => {
    it('should provide request details and respond function', async () => {
      routerA = new ExecutionRouter(meshA)
      routerB = new ExecutionRouter(meshB)
      await Promise.all([routerA.start(), routerB.start()])

      let receivedEvent: ExecutionRequestEvent | null = null

      routerB.on('execution:requested', (event: ExecutionRequestEvent) => {
        receivedEvent = event
        event.respond({
          success: true,
          exitCode: 0,
          stdout: 'done',
        })
      })

      await routerA.requestExecution('peer-b', 'test-command', {
        args: ['arg1', 'arg2'],
        cwd: '/home/user',
        env: { FOO: 'bar' },
      })

      expect(receivedEvent).not.toBeNull()
      expect(receivedEvent?.request.command).toBe('test-command')
      expect(receivedEvent?.request.args).toEqual(['arg1', 'arg2'])
      expect(receivedEvent?.request.cwd).toBe('/home/user')
      expect(receivedEvent?.request.env).toEqual({ FOO: 'bar' })
      expect(receivedEvent?.from.id).toBe('peer-a')
      expect(typeof receivedEvent?.respond).toBe('function')
    })
  })
})
