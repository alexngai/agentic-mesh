// Tests for TailscaleCLI

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TailscaleCLI, type TailscaleStatus } from '../../src/transports/tailscale/cli'
import * as childProcess from 'child_process'
import { EventEmitter } from 'events'

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(),
}))

// Mock promisify to return our mocked exec
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))

describe('TailscaleCLI', () => {
  let cli: TailscaleCLI
  const mockExec = childProcess.exec as unknown as ReturnType<typeof vi.fn>
  const mockSpawn = childProcess.spawn as unknown as ReturnType<typeof vi.fn>

  // Sample Tailscale status response
  const mockStatus: TailscaleStatus = {
    BackendState: 'Running',
    Self: {
      PublicKey: 'abc123',
      TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
      DNSName: 'my-node.tailnet.ts.net',
      HostName: 'my-node',
      OS: 'linux',
      UserID: 12345,
    },
    Peer: {
      'key1': {
        HostName: 'peer-1',
        DNSName: 'peer-1.tailnet.ts.net',
        TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'],
        Online: true,
        OS: 'linux',
        UserID: 12345,
        Tags: ['tag:server'],
        Relay: '',
      },
      'key2': {
        HostName: 'peer-2',
        DNSName: 'peer-2.tailnet.ts.net',
        TailscaleIPs: ['100.64.0.3'],
        Online: false,
        OS: 'darwin',
        UserID: 12345,
        LastSeen: '2024-01-15T10:30:00Z',
        Relay: 'nyc',
      },
      'key3': {
        HostName: 'peer-3',
        DNSName: 'peer-3.tailnet.ts.net',
        TailscaleIPs: ['100.64.0.4'],
        Online: true,
        OS: 'windows',
        UserID: 12345,
        Tags: ['tag:server', 'tag:prod'],
      },
    },
    CurrentTailnet: {
      Name: 'tailnet-name',
      MagicDNSSuffix: 'tailnet.ts.net',
    },
    MagicDNSEnabled: true,
  }

  beforeEach(() => {
    cli = new TailscaleCLI()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should use default tailscale binary', () => {
      const c = new TailscaleCLI()
      expect(c).toBeDefined()
    })

    it('should accept custom binary path', () => {
      const c = new TailscaleCLI('/custom/path/tailscale')
      expect(c).toBeDefined()
    })
  })

  describe('getStatus', () => {
    it('should return parsed status JSON', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const status = await cli.getStatus()

      expect(status.BackendState).toBe('Running')
      expect(status.Self.HostName).toBe('my-node')
      expect(Object.keys(status.Peer)).toHaveLength(3)
    })

    it('should throw on exec failure', async () => {
      mockExec.mockRejectedValue(new Error('command not found'))

      await expect(cli.getStatus()).rejects.toThrow('Failed to get Tailscale status')
    })

    it('should throw on invalid JSON', async () => {
      mockExec.mockResolvedValue({ stdout: 'not json' })

      await expect(cli.getStatus()).rejects.toThrow()
    })
  })

  describe('isConnected', () => {
    it('should return true when BackendState is Running', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const connected = await cli.isConnected()

      expect(connected).toBe(true)
    })

    it('should return false when BackendState is not Running', async () => {
      const stoppedStatus = { ...mockStatus, BackendState: 'Stopped' }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(stoppedStatus) })

      const connected = await cli.isConnected()

      expect(connected).toBe(false)
    })

    it('should return false on error', async () => {
      mockExec.mockRejectedValue(new Error('failed'))

      const connected = await cli.isConnected()

      expect(connected).toBe(false)
    })
  })

  describe('getBackendState', () => {
    it('should return the backend state', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const state = await cli.getBackendState()

      expect(state).toBe('Running')
    })

    it('should return NeedsLogin state', async () => {
      const needsLoginStatus = { ...mockStatus, BackendState: 'NeedsLogin' }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(needsLoginStatus) })

      const state = await cli.getBackendState()

      expect(state).toBe('NeedsLogin')
    })
  })

  describe('getSelf', () => {
    it('should return self status', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const self = await cli.getSelf()

      expect(self.HostName).toBe('my-node')
      expect(self.TailscaleIPs).toContain('100.64.0.1')
    })
  })

  describe('getLocalIP', () => {
    it('should return IPv4 address', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const ip = await cli.getLocalIP()

      expect(ip).toBe('100.64.0.1')
    })

    it('should throw if no IPv4 address', async () => {
      const ipv6OnlyStatus = {
        ...mockStatus,
        Self: { ...mockStatus.Self, TailscaleIPs: ['fd7a:115c:a1e0::1'] },
      }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(ipv6OnlyStatus) })

      await expect(cli.getLocalIP()).rejects.toThrow('No Tailscale IPv4 address found')
    })
  })

  describe('getHostname', () => {
    it('should return hostname', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const hostname = await cli.getHostname()

      expect(hostname).toBe('my-node')
    })
  })

  describe('getDNSName', () => {
    it('should return DNS name', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const dnsName = await cli.getDNSName()

      expect(dnsName).toBe('my-node.tailnet.ts.net')
    })
  })

  describe('getPeers', () => {
    it('should return all peers', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeers()

      expect(peers).toHaveLength(3)
      expect(peers[0].hostname).toBe('peer-1')
      expect(peers[0].ipv4).toBe('100.64.0.2')
      expect(peers[0].ipv6).toBe('fd7a:115c:a1e0::2')
      expect(peers[0].online).toBe(true)
      expect(peers[0].tags).toContain('tag:server')
      expect(peers[0].direct).toBe(true)
    })

    it('should handle peers without IPv6', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeers()
      const peer2 = peers.find((p) => p.hostname === 'peer-2')

      expect(peer2?.ipv6).toBeUndefined()
    })

    it('should parse lastSeen date', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeers()
      const peer2 = peers.find((p) => p.hostname === 'peer-2')

      expect(peer2?.lastSeen).toBeInstanceOf(Date)
    })

    it('should detect relayed connections', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeers()
      const peer2 = peers.find((p) => p.hostname === 'peer-2')

      expect(peer2?.direct).toBe(false)
    })

    it('should skip peers without IPv4', async () => {
      const ipv6OnlyPeerStatus = {
        ...mockStatus,
        Peer: {
          'key1': {
            HostName: 'ipv6-only',
            DNSName: 'ipv6-only.tailnet.ts.net',
            TailscaleIPs: ['fd7a:115c:a1e0::99'],
            Online: true,
            OS: 'linux',
            UserID: 12345,
          },
        },
      }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(ipv6OnlyPeerStatus) })

      const peers = await cli.getPeers()

      expect(peers).toHaveLength(0)
    })

    it('should skip self in peer list', async () => {
      const statusWithSelfInPeers = {
        ...mockStatus,
        Peer: {
          ...mockStatus.Peer,
          'self-key': {
            ...mockStatus.Self,
            Self: true,
          },
        },
      }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(statusWithSelfInPeers) })

      const peers = await cli.getPeers()

      expect(peers.find((p) => p.hostname === 'my-node')).toBeUndefined()
    })
  })

  describe('getOnlinePeers', () => {
    it('should return only online peers', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getOnlinePeers()

      expect(peers).toHaveLength(2)
      expect(peers.every((p) => p.online)).toBe(true)
    })
  })

  describe('getPeersByTag', () => {
    it('should filter peers by tag', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeersByTag('server')

      expect(peers).toHaveLength(2)
      expect(peers.every((p) => p.tags.includes('tag:server'))).toBe(true)
    })

    it('should handle tag: prefix', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeersByTag('tag:prod')

      expect(peers).toHaveLength(1)
      expect(peers[0].hostname).toBe('peer-3')
    })

    it('should return empty array for non-existent tag', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeersByTag('nonexistent')

      expect(peers).toHaveLength(0)
    })
  })

  describe('getPeerByHostname', () => {
    it('should find peer by exact hostname', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peer = await cli.getPeerByHostname('peer-1')

      expect(peer).not.toBeNull()
      expect(peer?.hostname).toBe('peer-1')
    })

    it('should find peer by DNS name prefix', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peer = await cli.getPeerByHostname('peer-2.tailnet')

      expect(peer).not.toBeNull()
      expect(peer?.hostname).toBe('peer-2')
    })

    it('should return null for non-existent hostname', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peer = await cli.getPeerByHostname('nonexistent')

      expect(peer).toBeNull()
    })
  })

  describe('getPeerByIP', () => {
    it('should find peer by IPv4', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peer = await cli.getPeerByIP('100.64.0.2')

      expect(peer).not.toBeNull()
      expect(peer?.hostname).toBe('peer-1')
    })

    it('should find peer by IPv6', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peer = await cli.getPeerByIP('fd7a:115c:a1e0::2')

      expect(peer).not.toBeNull()
      expect(peer?.hostname).toBe('peer-1')
    })

    it('should return null for non-existent IP', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peer = await cli.getPeerByIP('100.64.0.99')

      expect(peer).toBeNull()
    })
  })

  describe('up', () => {
    it('should call tailscale up', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up()

      expect(mockExec).toHaveBeenCalledWith('tailscale up --reset')
    })

    it('should include authKey option', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ authKey: 'tskey-abc123' })

      expect(mockExec).toHaveBeenCalledWith('tailscale up --reset --authkey tskey-abc123')
    })

    it('should include hostname option', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ hostname: 'my-custom-host' })

      expect(mockExec).toHaveBeenCalledWith('tailscale up --reset --hostname my-custom-host')
    })

    it('should include acceptRoutes option', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ acceptRoutes: true })

      expect(mockExec).toHaveBeenCalledWith('tailscale up --reset --accept-routes')
    })

    it('should include all options', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ authKey: 'key', hostname: 'host', acceptRoutes: true })

      expect(mockExec).toHaveBeenCalledWith(
        'tailscale up --reset --authkey key --hostname host --accept-routes'
      )
    })

    it('should throw on failure', async () => {
      mockExec.mockRejectedValue(new Error('permission denied'))

      await expect(cli.up()).rejects.toThrow('Failed to bring Tailscale up')
    })
  })

  describe('down', () => {
    it('should call tailscale down', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.down()

      expect(mockExec).toHaveBeenCalledWith('tailscale down')
    })

    it('should throw on failure', async () => {
      mockExec.mockRejectedValue(new Error('not running'))

      await expect(cli.down()).rejects.toThrow('Failed to bring Tailscale down')
    })
  })

  describe('ping', () => {
    function createMockProcess() {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
      }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      return proc
    }

    it('should return latency on successful ping', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)

      const pingPromise = cli.ping('peer-1')

      // Simulate stdout data
      proc.stdout.emit('data', 'pong from peer-1 (100.64.0.2) via DERP(nyc) in 45.2ms')
      proc.emit('close', 0)

      const latency = await pingPromise

      expect(latency).toBe(45.2)
    })

    it('should return null on ping failure', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)

      const pingPromise = cli.ping('unreachable')

      proc.emit('close', 1)

      const latency = await pingPromise

      expect(latency).toBeNull()
    })

    it('should return null on spawn error', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)

      const pingPromise = cli.ping('peer-1')

      proc.emit('error', new Error('spawn failed'))

      const latency = await pingPromise

      expect(latency).toBeNull()
    })

    it('should use custom timeout', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)

      cli.ping('peer-1', 10)

      expect(mockSpawn).toHaveBeenCalledWith('tailscale', ['ping', '--c', '1', '--timeout', '10s', 'peer-1'])
    })

    it('should handle integer latency', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)

      const pingPromise = cli.ping('peer-1')

      proc.stdout.emit('data', 'pong from peer-1 (100.64.0.2) in 123ms')
      proc.emit('close', 0)

      const latency = await pingPromise

      expect(latency).toBe(123)
    })
  })

  describe('getTailnetName', () => {
    it('should return tailnet name', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const name = await cli.getTailnetName()

      expect(name).toBe('tailnet-name')
    })

    it('should return null if no tailnet info', async () => {
      const noTailnetStatus = { ...mockStatus, CurrentTailnet: undefined }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(noTailnetStatus) })

      const name = await cli.getTailnetName()

      expect(name).toBeNull()
    })
  })

  describe('getMagicDNSSuffix', () => {
    it('should return MagicDNS suffix', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const suffix = await cli.getMagicDNSSuffix()

      expect(suffix).toBe('tailnet.ts.net')
    })

    it('should return null if no tailnet info', async () => {
      const noTailnetStatus = { ...mockStatus, CurrentTailnet: undefined }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(noTailnetStatus) })

      const suffix = await cli.getMagicDNSSuffix()

      expect(suffix).toBeNull()
    })
  })

  describe('isMagicDNSEnabled', () => {
    it('should return true when enabled', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const enabled = await cli.isMagicDNSEnabled()

      expect(enabled).toBe(true)
    })

    it('should return false when disabled', async () => {
      const disabledStatus = { ...mockStatus, MagicDNSEnabled: false }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(disabledStatus) })

      const enabled = await cli.isMagicDNSEnabled()

      expect(enabled).toBe(false)
    })

    it('should return false when not present', async () => {
      const noFieldStatus = { ...mockStatus, MagicDNSEnabled: undefined }
      mockExec.mockResolvedValue({ stdout: JSON.stringify(noFieldStatus) })

      const enabled = await cli.isMagicDNSEnabled()

      expect(enabled).toBe(false)
    })
  })

  describe('getVersion', () => {
    it('should return version string', async () => {
      mockExec.mockResolvedValue({ stdout: '1.56.1\n  tailscale commit: abc123' })

      const version = await cli.getVersion()

      expect(version).toBe('1.56.1')
    })

    it('should throw on failure', async () => {
      mockExec.mockRejectedValue(new Error('not installed'))

      await expect(cli.getVersion()).rejects.toThrow('Failed to get Tailscale version')
    })
  })
})
