// Tests for HeadscaleCLI

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HeadscaleCLI, type HeadscaleConfig } from '../../src/transports/headscale/cli'
import { type TailscaleStatus } from '../../src/transports/tailscale/cli'
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

// Mock fetch for API calls
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('HeadscaleCLI', () => {
  let cli: HeadscaleCLI
  const mockExec = childProcess.exec as unknown as ReturnType<typeof vi.fn>
  const mockSpawn = childProcess.spawn as unknown as ReturnType<typeof vi.fn>

  const defaultConfig: HeadscaleConfig = {
    serverUrl: 'https://headscale.example.com',
    preAuthKey: 'tskey-abc123',
    apiKey: 'api-key-xyz',
    hostname: 'test-node',
  }

  // Sample Tailscale status response
  const mockStatus: TailscaleStatus = {
    BackendState: 'Running',
    Self: {
      PublicKey: 'abc123',
      TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
      DNSName: 'my-node.headscale.example.com',
      HostName: 'my-node',
      OS: 'linux',
      UserID: 12345,
    },
    Peer: {
      'key1': {
        HostName: 'peer-1',
        DNSName: 'peer-1.headscale.example.com',
        TailscaleIPs: ['100.64.0.2'],
        Online: true,
        OS: 'linux',
        UserID: 12345,
      },
    },
    MagicDNSEnabled: true,
  }

  beforeEach(() => {
    cli = new HeadscaleCLI(defaultConfig)
    vi.clearAllMocks()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create CLI with default tailscale binary', () => {
      const c = new HeadscaleCLI({ serverUrl: 'https://example.com' })
      expect(c).toBeDefined()
    })

    it('should create CLI with custom binary path', () => {
      const c = new HeadscaleCLI({
        serverUrl: 'https://example.com',
        tailscaleBin: '/custom/tailscale',
      })
      expect(c).toBeDefined()
    })
  })

  describe('getServerUrl', () => {
    it('should return the server URL', () => {
      expect(cli.getServerUrl()).toBe('https://headscale.example.com')
    })
  })

  describe('hasApiKey', () => {
    it('should return true when API key is configured', () => {
      expect(cli.hasApiKey()).toBe(true)
    })

    it('should return false when API key is not configured', () => {
      const noApiCli = new HeadscaleCLI({
        serverUrl: 'https://example.com',
      })
      expect(noApiCli.hasApiKey()).toBe(false)
    })
  })

  describe('up', () => {
    it('should call tailscale up with login-server', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up()

      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--login-server https://headscale.example.com')
      )
    })

    it('should include pre-auth key from config', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up()

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--authkey tskey-abc123'))
    })

    it('should override pre-auth key with provided authKey', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ authKey: 'override-key' })

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--authkey override-key'))
    })

    it('should include hostname from config', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up()

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--hostname test-node'))
    })

    it('should override hostname with provided option', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ hostname: 'override-host' })

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--hostname override-host'))
    })

    it('should include accept-routes option', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up({ acceptRoutes: true })

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--accept-routes'))
    })

    it('should include accept-dns by default', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.up()

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--accept-dns'))
    })

    it('should throw on failure', async () => {
      mockExec.mockRejectedValue(new Error('connection refused'))

      await expect(cli.up()).rejects.toThrow('Failed to connect to Headscale')
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

      await expect(cli.down()).rejects.toThrow('Failed to disconnect from Headscale')
    })
  })

  describe('logout', () => {
    it('should call tailscale logout', async () => {
      mockExec.mockResolvedValue({ stdout: '' })

      await cli.logout()

      expect(mockExec).toHaveBeenCalledWith('tailscale logout')
    })

    it('should throw on failure', async () => {
      mockExec.mockRejectedValue(new Error('not registered'))

      await expect(cli.logout()).rejects.toThrow('Failed to logout from Headscale')
    })
  })

  describe('inherited methods', () => {
    it('should get status from parent class', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const status = await cli.getStatus()

      expect(status.BackendState).toBe('Running')
    })

    it('should check connection from parent class', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const connected = await cli.isConnected()

      expect(connected).toBe(true)
    })

    it('should get peers from parent class', async () => {
      mockExec.mockResolvedValue({ stdout: JSON.stringify(mockStatus) })

      const peers = await cli.getPeers()

      expect(peers).toHaveLength(1)
      expect(peers[0].hostname).toBe('peer-1')
    })
  })

  describe('API operations', () => {
    describe('listNodes', () => {
      it('should list nodes from Headscale API', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              machines: [
                {
                  id: '1',
                  name: 'node-1',
                  givenName: 'Node 1',
                  ipAddresses: ['100.64.0.1'],
                  user: { id: '1', name: 'default' },
                  online: true,
                  createdAt: '2024-01-01T00:00:00Z',
                  registerMethod: 'authkey',
                },
              ],
            }),
        })

        const nodes = await cli.listNodes()

        expect(nodes).toHaveLength(1)
        expect(nodes[0].name).toBe('node-1')
        expect(mockFetch).toHaveBeenCalledWith(
          'https://headscale.example.com/api/v1/machine',
          expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({
              Authorization: 'Bearer api-key-xyz',
            }),
          })
        )
      })

      it('should throw without API key', async () => {
        const noApiCli = new HeadscaleCLI({ serverUrl: 'https://example.com' })

        await expect(noApiCli.listNodes()).rejects.toThrow('Headscale API key is required')
      })

      it('should throw on API error', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Internal server error'),
        })

        await expect(cli.listNodes()).rejects.toThrow('Failed to list Headscale nodes')
      })
    })

    describe('getNode', () => {
      it('should get node by ID', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              machine: {
                id: '123',
                name: 'node-123',
                givenName: 'Node 123',
                ipAddresses: ['100.64.0.5'],
                user: { id: '1', name: 'default' },
                online: true,
                createdAt: '2024-01-01T00:00:00Z',
                registerMethod: 'authkey',
              },
            }),
        })

        const node = await cli.getNode('123')

        expect(node).not.toBeNull()
        expect(node?.name).toBe('node-123')
      })

      it('should return null for non-existent node', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 404,
          text: () => Promise.resolve('Not found'),
        })

        const node = await cli.getNode('nonexistent')

        expect(node).toBeNull()
      })
    })

    describe('deleteNode', () => {
      it('should delete node by ID', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => null },
        })

        await cli.deleteNode('123')

        expect(mockFetch).toHaveBeenCalledWith(
          'https://headscale.example.com/api/v1/machine/123',
          expect.objectContaining({
            method: 'DELETE',
          })
        )
      })
    })

    describe('expireNode', () => {
      it('should expire node by ID', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => null },
        })

        await cli.expireNode('123')

        expect(mockFetch).toHaveBeenCalledWith(
          'https://headscale.example.com/api/v1/machine/123/expire',
          expect.objectContaining({
            method: 'POST',
          })
        )
      })
    })

    describe('listUsers', () => {
      it('should list users from Headscale API', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              users: [
                {
                  id: '1',
                  name: 'default',
                  createdAt: '2024-01-01T00:00:00Z',
                },
                {
                  id: '2',
                  name: 'admin',
                  createdAt: '2024-01-02T00:00:00Z',
                },
              ],
            }),
        })

        const users = await cli.listUsers()

        expect(users).toHaveLength(2)
        expect(users[0].name).toBe('default')
      })
    })

    describe('createPreAuthKey', () => {
      it('should create pre-auth key', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              preAuthKey: {
                id: '1',
                key: 'tskey-newkey-123',
                user: 'default',
                reusable: false,
                ephemeral: false,
                used: false,
                expiration: '2024-12-31T23:59:59Z',
                createdAt: '2024-01-01T00:00:00Z',
              },
            }),
        })

        const key = await cli.createPreAuthKey({ user: 'default' })

        expect(key.key).toBe('tskey-newkey-123')
        expect(mockFetch).toHaveBeenCalledWith(
          'https://headscale.example.com/api/v1/preauthkey',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              user: 'default',
              reusable: false,
              ephemeral: false,
              expiration: undefined,
              aclTags: undefined,
            }),
          })
        )
      })

      it('should create reusable pre-auth key', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              preAuthKey: {
                id: '1',
                key: 'tskey-reusable-123',
                user: 'default',
                reusable: true,
                ephemeral: false,
                used: false,
                expiration: '2024-12-31T23:59:59Z',
                createdAt: '2024-01-01T00:00:00Z',
              },
            }),
        })

        const key = await cli.createPreAuthKey({ user: 'default', reusable: true })

        expect(key.reusable).toBe(true)
      })

      it('should create ephemeral pre-auth key', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              preAuthKey: {
                id: '1',
                key: 'tskey-ephemeral-123',
                user: 'default',
                reusable: false,
                ephemeral: true,
                used: false,
                expiration: '2024-12-31T23:59:59Z',
                createdAt: '2024-01-01T00:00:00Z',
              },
            }),
        })

        const key = await cli.createPreAuthKey({ user: 'default', ephemeral: true })

        expect(key.ephemeral).toBe(true)
      })
    })

    describe('listPreAuthKeys', () => {
      it('should list pre-auth keys for user', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () =>
            Promise.resolve({
              preAuthKeys: [
                {
                  id: '1',
                  key: 'tskey-key1-123',
                  user: 'default',
                  reusable: false,
                  ephemeral: false,
                  used: true,
                  expiration: '2024-12-31T23:59:59Z',
                  createdAt: '2024-01-01T00:00:00Z',
                },
              ],
            }),
        })

        const keys = await cli.listPreAuthKeys('default')

        expect(keys).toHaveLength(1)
        expect(keys[0].used).toBe(true)
        expect(mockFetch).toHaveBeenCalledWith(
          'https://headscale.example.com/api/v1/preauthkey?user=default',
          expect.any(Object)
        )
      })
    })

    describe('setNodeTags', () => {
      it('should set tags on node', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: { get: () => null },
        })

        await cli.setNodeTags('123', ['tag:server', 'tag:prod'])

        expect(mockFetch).toHaveBeenCalledWith(
          'https://headscale.example.com/api/v1/machine/123/tags',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ tags: ['tag:server', 'tag:prod'] }),
          })
        )
      })
    })
  })
})
