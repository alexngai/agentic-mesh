import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NebulaMesh } from '../../src/mesh/nebula-mesh'
import { MessageChannel } from '../../src/channel/message-channel'
import type { PeerInfo } from '../../src/types'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('MessageChannel Permission Enforcement', () => {
  let meshA: NebulaMesh
  let meshB: NebulaMesh
  let basePort: number

  beforeEach(async () => {
    basePort = 20200 + Math.floor(Math.random() * 1000)

    meshA = new NebulaMesh({
      peerId: 'peer-a',
      nebulaIp: '127.0.0.1',
      port: basePort,
      peers: [{ id: 'peer-b', nebulaIp: '127.0.0.1', port: basePort + 1 }],
      groups: ['admin', 'developers'],
    })

    meshB = new NebulaMesh({
      peerId: 'peer-b',
      nebulaIp: '127.0.0.1',
      port: basePort + 1,
      peers: [{ id: 'peer-a', nebulaIp: '127.0.0.1', port: basePort }],
      groups: ['developers'], // Only developers, no admin
    })

    await Promise.all([meshA.connect(), meshB.connect()])
    await sleep(200)
  })

  afterEach(async () => {
    await Promise.race([
      Promise.all([meshA?.disconnect(), meshB?.disconnect()]),
      sleep(2000),
    ])
  })

  describe('requiredGroups configuration', () => {
    it('should create channel without required groups (allow all)', async () => {
      const channel = meshA.createChannel('test-open')
      await channel.open()

      expect(channel.getRequiredGroups()).toEqual([])
    })

    it('should create channel with required groups', async () => {
      const channel = meshA.createChannel('test-restricted', {
        requiredGroups: ['admin', 'superuser'],
      })
      await channel.open()

      expect(channel.getRequiredGroups()).toEqual(['admin', 'superuser'])
    })
  })

  describe('permission checking on receive', () => {
    it('should allow message when sender has required group', async () => {
      const channelA = meshA.createChannel<string>('restricted', {
        requiredGroups: ['developers'],
      })
      const channelB = meshB.createChannel<string>('restricted', {
        requiredGroups: ['developers'],
      })

      await Promise.all([channelA.open(), channelB.open()])

      const receivedMessages: string[] = []
      channelA.on('message', (msg: string) => {
        receivedMessages.push(msg)
      })

      // peer-b has 'developers' group, so should be allowed
      channelB.send('peer-a', 'hello from b')

      await sleep(100)

      expect(receivedMessages).toContain('hello from b')
    })

    it('should reject message when sender lacks required group', async () => {
      // peer-a requires 'admin' group which peer-b doesn't have
      const channelA = meshA.createChannel<string>('admin-only', {
        requiredGroups: ['admin'],
      })
      const channelB = meshB.createChannel<string>('admin-only', {
        requiredGroups: ['admin'],
      })

      await Promise.all([channelA.open(), channelB.open()])

      const receivedMessages: string[] = []
      const deniedEvents: unknown[] = []

      channelA.on('message', (msg: string) => {
        receivedMessages.push(msg)
      })

      channelA.on('permission:denied', (event: unknown) => {
        deniedEvents.push(event)
      })

      // peer-b does NOT have 'admin' group
      channelB.send('peer-a', 'should be rejected')

      await sleep(100)

      expect(receivedMessages).not.toContain('should be rejected')
      expect(deniedEvents.length).toBe(1)
      expect(deniedEvents[0]).toMatchObject({
        reason: 'Sender lacks required group membership',
        requiredGroups: ['admin'],
      })
    })

    it('should allow message when sender has one of multiple required groups', async () => {
      // peer-b has 'developers', channel requires 'admin' OR 'developers'
      const channelA = meshA.createChannel<string>('multi-group', {
        requiredGroups: ['admin', 'developers'],
      })
      const channelB = meshB.createChannel<string>('multi-group', {
        requiredGroups: ['admin', 'developers'],
      })

      await Promise.all([channelA.open(), channelB.open()])

      const receivedMessages: string[] = []
      channelA.on('message', (msg: string) => {
        receivedMessages.push(msg)
      })

      // peer-b has 'developers', should be allowed
      channelB.send('peer-a', 'allowed with developers')

      await sleep(100)

      expect(receivedMessages).toContain('allowed with developers')
    })

    it('should allow all messages when no required groups specified', async () => {
      const channelA = meshA.createChannel<string>('open-channel')
      const channelB = meshB.createChannel<string>('open-channel')

      await Promise.all([channelA.open(), channelB.open()])

      const receivedMessages: string[] = []
      channelA.on('message', (msg: string) => {
        receivedMessages.push(msg)
      })

      channelB.send('peer-a', 'open to all')

      await sleep(100)

      expect(receivedMessages).toContain('open to all')
    })
  })

  describe('stats tracking', () => {
    it('should track permission denied count', async () => {
      const channelA = meshA.createChannel<string>('stats-test', {
        requiredGroups: ['superadmin'], // No one has this
      })
      const channelB = meshB.createChannel<string>('stats-test', {
        requiredGroups: ['superadmin'],
      })

      await Promise.all([channelA.open(), channelB.open()])

      // Send multiple messages that should be rejected
      channelB.send('peer-a', 'rejected 1')
      channelB.send('peer-a', 'rejected 2')
      channelB.send('peer-a', 'rejected 3')

      await sleep(100)

      const stats = channelA.getStats()
      expect(stats.permissionDenied).toBe(3)
      expect(stats.messagesReceived).toBe(0)
    })

    it('should not increment permissionDenied for allowed messages', async () => {
      const channelA = meshA.createChannel<string>('allowed-stats', {
        requiredGroups: ['developers'],
      })
      const channelB = meshB.createChannel<string>('allowed-stats', {
        requiredGroups: ['developers'],
      })

      await Promise.all([channelA.open(), channelB.open()])

      channelB.send('peer-a', 'allowed message')

      await sleep(100)

      const stats = channelA.getStats()
      expect(stats.permissionDenied).toBe(0)
      expect(stats.messagesReceived).toBe(1)
    })
  })
})
