import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { LighthouseManager, LighthouseInfo, LighthouseStatus } from '../../src/certs/lighthouse-manager'

describe('LighthouseManager', () => {
  let tempDir: string
  let manager: LighthouseManager

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lighthouse-test-'))
    manager = new LighthouseManager({
      lighthousesDir: tempDir,
      startupTimeout: 500,
    })
    await manager.initialize()
  })

  afterEach(async () => {
    try {
      await manager.shutdown()
    } catch {
      // Ignore shutdown errors
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      const newManager = new LighthouseManager({ lighthousesDir: tempDir })
      await newManager.initialize()
      expect(newManager.list()).toEqual([])
      await newManager.shutdown()
    })

    it('should create lighthouses directory if it does not exist', async () => {
      const newDir = path.join(tempDir, 'nested', 'lighthouses')
      const newManager = new LighthouseManager({ lighthousesDir: newDir })
      await newManager.initialize()

      const stat = await fs.stat(newDir)
      expect(stat.isDirectory()).toBe(true)

      await newManager.shutdown()
    })

    it('should load existing index on initialization', async () => {
      // Create a lighthouse first
      await manager.create({
        name: 'test-lh',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh.example.com:4242',
        caCertPath: '/ca.crt',
        certPath: '/lh.crt',
        keyPath: '/lh.key',
      })

      // Create new manager and verify it loads the lighthouse
      const newManager = new LighthouseManager({ lighthousesDir: tempDir })
      await newManager.initialize()

      const lighthouses = newManager.list()
      expect(lighthouses).toHaveLength(1)
      expect(lighthouses[0].name).toBe('test-lh')

      await newManager.shutdown()
    })

    it('should throw when operations called before initialize', async () => {
      const uninitManager = new LighthouseManager({ lighthousesDir: tempDir })
      expect(() => uninitManager.list()).toThrow('not initialized')
    })
  })

  describe('Create Lighthouse', () => {
    it('should create a lighthouse configuration', async () => {
      const info = await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lighthouse.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
      })

      expect(info.name).toBe('lighthouse-1')
      expect(info.nebulaIp).toBe('10.42.0.1/24')
      expect(info.publicEndpoint).toBe('lighthouse.example.com:4242')
      expect(info.status).toBe('stopped')
      expect(info.configPath).toContain('lighthouse-1')
    })

    it('should create config file', async () => {
      const info = await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lighthouse.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
      })

      const configContent = await fs.readFile(info.configPath, 'utf-8')
      expect(configContent).toContain('am_lighthouse: true')
      expect(configContent).toContain('/certs/ca.crt')
    })

    it('should use custom listen port', async () => {
      const info = await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lighthouse.example.com:5000',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
        listenPort: 5000,
      })

      expect(info.listenPort).toBe(5000)

      const configContent = await fs.readFile(info.configPath, 'utf-8')
      expect(configContent).toContain('port: 5000')
    })

    it('should include other lighthouses in config', async () => {
      const info = await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
        otherLighthouses: {
          '10.42.0.2': 'lh2.example.com:4242',
        },
      })

      const configContent = await fs.readFile(info.configPath, 'utf-8')
      expect(configContent).toContain('10.42.0.2')
      expect(configContent).toContain('lh2.example.com:4242')
    })

    it('should include DNS config when enabled', async () => {
      const info = await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lighthouse.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
        dns: { enabled: true, port: 5353 },
      })

      const configContent = await fs.readFile(info.configPath, 'utf-8')
      expect(configContent).toContain('dns:')
      expect(configContent).toContain('port: 5353')
    })

    it('should throw when creating duplicate lighthouse', async () => {
      await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lighthouse.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
      })

      await expect(
        manager.create({
          name: 'lighthouse-1',
          nebulaIp: '10.42.0.2/24',
          publicEndpoint: 'lighthouse2.example.com:4242',
          caCertPath: '/certs/ca.crt',
          certPath: '/certs/lighthouse-2.crt',
          keyPath: '/certs/lighthouse-2.key',
        })
      ).rejects.toThrow('already exists')
    })

    it('should emit lighthouse:created event', async () => {
      const listener = vi.fn()
      manager.on('lighthouse:created', listener)

      await manager.create({
        name: 'lighthouse-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lighthouse.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lighthouse-1.crt',
        keyPath: '/certs/lighthouse-1.key',
      })

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          lighthouse: expect.objectContaining({ name: 'lighthouse-1' }),
        })
      )
    })
  })

  describe('Get and List', () => {
    beforeEach(async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })
      await manager.create({
        name: 'lh-2',
        nebulaIp: '10.42.0.2/24',
        publicEndpoint: 'lh2.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-2.crt',
        keyPath: '/certs/lh-2.key',
      })
    })

    it('should get lighthouse by name', () => {
      const info = manager.get('lh-1')
      expect(info).toBeDefined()
      expect(info?.name).toBe('lh-1')
      expect(info?.nebulaIp).toBe('10.42.0.1/24')
    })

    it('should return undefined for non-existent lighthouse', () => {
      const info = manager.get('non-existent')
      expect(info).toBeUndefined()
    })

    it('should list all lighthouses', () => {
      const lighthouses = manager.list()
      expect(lighthouses).toHaveLength(2)
      expect(lighthouses.map((l) => l.name).sort()).toEqual(['lh-1', 'lh-2'])
    })
  })

  describe('Remove Lighthouse', () => {
    beforeEach(async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })
    })

    it('should remove lighthouse', async () => {
      await manager.remove('lh-1')

      expect(manager.get('lh-1')).toBeUndefined()
      expect(manager.list()).toHaveLength(0)
    })

    it('should remove config directory', async () => {
      const info = manager.get('lh-1')
      const lighthouseDir = path.dirname(info!.configPath)

      await manager.remove('lh-1')

      await expect(fs.access(lighthouseDir)).rejects.toThrow()
    })

    it('should throw when removing non-existent lighthouse', async () => {
      await expect(manager.remove('non-existent')).rejects.toThrow('not found')
    })

    it('should emit lighthouse:removed event', async () => {
      const listener = vi.fn()
      manager.on('lighthouse:removed', listener)

      await manager.remove('lh-1')

      expect(listener).toHaveBeenCalledWith({ name: 'lh-1' })
    })
  })

  describe('Status', () => {
    beforeEach(async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })
    })

    it('should return stopped status for new lighthouse', () => {
      expect(manager.status('lh-1')).toBe('stopped')
    })

    it('should throw for non-existent lighthouse', () => {
      expect(() => manager.status('non-existent')).toThrow('not found')
    })
  })

  describe('Health', () => {
    beforeEach(async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })
    })

    it('should return health info for stopped lighthouse', async () => {
      const health = await manager.health('lh-1')

      expect(health.name).toBe('lh-1')
      expect(health.status).toBe('stopped')
      expect(health.healthy).toBe(false)
      expect(health.pid).toBeUndefined()
      expect(health.uptime).toBeUndefined()
    })

    it('should throw for non-existent lighthouse', async () => {
      await expect(manager.health('non-existent')).rejects.toThrow('not found')
    })
  })

  describe('Health Monitor', () => {
    beforeEach(async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })
    })

    it('should start health monitor', () => {
      expect(() => manager.startHealthMonitor('lh-1')).not.toThrow()
    })

    it('should stop health monitor', () => {
      manager.startHealthMonitor('lh-1')
      expect(() => manager.stopHealthMonitor('lh-1')).not.toThrow()
    })

    it('should throw when starting monitor for non-existent lighthouse', () => {
      expect(() => manager.startHealthMonitor('non-existent')).toThrow('not found')
    })
  })

  describe('Process Management (Mock)', () => {
    // These tests verify the state management without actually spawning nebula
    // Full process tests would require nebula to be installed

    beforeEach(async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })
    })

    it('should throw when starting non-existent lighthouse', async () => {
      await expect(manager.start('non-existent')).rejects.toThrow('not found')
    })

    it('should throw when stopping non-running lighthouse', async () => {
      await expect(manager.stop('lh-1')).rejects.toThrow('not running')
    })

    it('should set status to error when nebula binary not found', async () => {
      // This will fail because nebula isn't installed
      await expect(manager.start('lh-1')).rejects.toThrow()

      // Status should be 'error' after failure
      const status = manager.status('lh-1')
      expect(status).toBe('error')

      // Info should have error message
      const info = manager.get('lh-1')
      expect(info?.error).toBeDefined()
    })
  })

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const defaultManager = new LighthouseManager()
      // Can't easily test private fields, but verify it doesn't throw
      expect(defaultManager).toBeDefined()
    })

    it('should accept custom configuration', () => {
      const customManager = new LighthouseManager({
        lighthousesDir: '/custom/dir',
        nebulaBinaryPath: '/usr/local/bin/nebula',
        healthCheckInterval: 60000,
        startupTimeout: 20000,
      })
      expect(customManager).toBeDefined()
    })
  })

  describe('Events', () => {
    it('should emit events with correct data', async () => {
      const events: Array<{ type: string; data: unknown }> = []

      manager.on('lighthouse:created', (data) => events.push({ type: 'created', data }))
      manager.on('lighthouse:removed', (data) => events.push({ type: 'removed', data }))

      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })

      await manager.remove('lh-1')

      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('created')
      expect(events[1].type).toBe('removed')
    })
  })

  describe('Persistence', () => {
    it('should persist lighthouse index', async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })

      const indexPath = path.join(tempDir, 'lighthouse-index.json')
      const indexData = await fs.readFile(indexPath, 'utf-8')
      const index = JSON.parse(indexData)

      expect(index.lighthouses['lh-1']).toBeDefined()
      expect(index.lighthouses['lh-1'].name).toBe('lh-1')
    })

    it('should restore dates correctly from index', async () => {
      await manager.create({
        name: 'lh-1',
        nebulaIp: '10.42.0.1/24',
        publicEndpoint: 'lh1.example.com:4242',
        caCertPath: '/certs/ca.crt',
        certPath: '/certs/lh-1.crt',
        keyPath: '/certs/lh-1.key',
      })

      // Create new manager
      const newManager = new LighthouseManager({ lighthousesDir: tempDir })
      await newManager.initialize()

      const info = newManager.get('lh-1')
      // Index should be loaded correctly
      expect(info).toBeDefined()

      await newManager.shutdown()
    })
  })
})
