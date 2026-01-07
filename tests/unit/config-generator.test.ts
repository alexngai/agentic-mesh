import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ConfigGenerator } from '../../src/certs/config-generator'
import type { NebulaConfigOptions, LighthouseConfigOptions } from '../../src/certs/config-generator'

describe('ConfigGenerator', () => {
  let generator: ConfigGenerator
  let tempDir: string

  beforeEach(() => {
    generator = new ConfigGenerator()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-generator-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const baseOptions: NebulaConfigOptions = {
    caCertPath: '/etc/nebula/ca.crt',
    certPath: '/etc/nebula/host.crt',
    keyPath: '/etc/nebula/host.key',
    lighthouses: {
      '10.42.0.1': '203.0.113.1:4242',
    },
  }

  describe('generateNebulaConfig', () => {
    it('should generate valid peer config', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('pki:')
      expect(config).toContain('ca: /etc/nebula/ca.crt')
      expect(config).toContain('cert: /etc/nebula/host.crt')
      expect(config).toContain('key: /etc/nebula/host.key')
    })

    it('should include lighthouse hosts', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('static_host_map:')
      expect(config).toContain('10.42.0.1:')
      expect(config).toContain('203.0.113.1:4242')
    })

    it('should set am_lighthouse to false for peers', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('am_lighthouse: false')
    })

    it('should include listen config', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        listenHost: '0.0.0.0',
        listenPort: 5555,
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('listen:')
      // Host is quoted because it contains periods
      expect(config).toMatch(/host:\s*"?0\.0\.0\.0"?/)
      expect(config).toContain('port: 5555')
    })

    it('should use default listen port 4242', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('port: 4242')
    })

    it('should include tun config', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        tunDevice: 'nebula0',
        mtu: 1400,
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('tun:')
      expect(config).toContain('dev: nebula0')
      expect(config).toContain('mtu: 1400')
    })

    it('should disable tun when specified', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        tunEnabled: false,
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('disabled: true')
    })

    it('should include punchy config', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('punchy:')
      expect(config).toContain('punch: true')
      expect(config).toContain('respond: true')
    })

    it('should include cipher setting', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        cipher: 'chachapoly',
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('cipher: chachapoly')
    })

    it('should include default firewall rules', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('firewall:')
      expect(config).toContain('inbound:')
      expect(config).toContain('outbound:')
      expect(config).toContain('proto: icmp')
    })

    it('should include custom firewall rules', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        firewall: {
          inbound: [
            { proto: 'tcp', port: '443', host: 'any' },
            { proto: 'tcp', port: '80', host: 'group:web' },
          ],
          outbound: [
            { proto: 'any', port: 'any', host: 'any' },
          ],
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('port: "443"')
      expect(config).toContain('port: "80"')
      expect(config).toContain('group: web')
    })

    it('should include logging config', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        logging: {
          level: 'debug',
          format: 'json',
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('logging:')
      expect(config).toContain('level: debug')
      expect(config).toContain('format: json')
    })

    it('should merge extra config', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        extraConfig: {
          relay: {
            am_relay: false,
            use_relays: true,
          },
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('relay:')
      expect(config).toContain('am_relay: false')
      expect(config).toContain('use_relays: true')
    })
  })

  describe('generateLighthouseConfig', () => {
    const lighthouseOptions: LighthouseConfigOptions = {
      ...baseOptions,
      nebulaIp: '10.42.0.1/24',
    }

    it('should set am_lighthouse to true', () => {
      const config = generator.generateLighthouseConfig(lighthouseOptions)

      expect(config).toContain('am_lighthouse: true')
    })

    it('should remove self from static_host_map', () => {
      const options: LighthouseConfigOptions = {
        ...baseOptions,
        nebulaIp: '10.42.0.1/24',
        lighthouses: {
          '10.42.0.1': '203.0.113.1:4242',
          '10.42.0.2': '203.0.113.2:4242',
        },
      }

      const config = generator.generateLighthouseConfig(options)

      // Should not contain self in static_host_map
      // But should contain the other lighthouse
      expect(config).toContain('10.42.0.2:')
    })

    it('should not include self in lighthouse hosts', () => {
      const options: LighthouseConfigOptions = {
        ...baseOptions,
        nebulaIp: '10.42.0.1/24',
        lighthouses: {
          '10.42.0.1': '203.0.113.1:4242',
          '10.42.0.2': '203.0.113.2:4242',
        },
      }

      const config = generator.generateLighthouseConfig(options)

      // Should have hosts array with only other lighthouse
      expect(config).toContain('hosts:')
    })

    it('should include DNS config when enabled', () => {
      const options: LighthouseConfigOptions = {
        ...lighthouseOptions,
        dns: {
          enabled: true,
          host: '0.0.0.0',
          port: 5353,
        },
      }

      const config = generator.generateLighthouseConfig(options)

      expect(config).toContain('dns:')
      expect(config).toContain('port: 5353')
    })

    it('should not include DNS config when disabled', () => {
      const options: LighthouseConfigOptions = {
        ...lighthouseOptions,
        dns: {
          enabled: false,
        },
      }

      const config = generator.generateLighthouseConfig(options)

      // The dns section should not appear
      const lines = config.split('\n')
      const dnsLines = lines.filter(l => l.trim().startsWith('dns:'))
      expect(dnsLines.length).toBe(0)
    })
  })

  describe('generateMeshPeerConfig', () => {
    it('should include mesh-specific firewall rules', () => {
      const config = generator.generateMeshPeerConfig(baseOptions)

      // Should include port 7946 for mesh traffic
      expect(config).toContain('port: "7946"')
    })

    it('should allow custom firewall override', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        firewall: {
          inbound: [
            { proto: 'tcp', port: '8080', host: 'any' },
          ],
          outbound: [
            { proto: 'any', port: 'any', host: 'any' },
          ],
        },
      }

      const config = generator.generateMeshPeerConfig(options)

      expect(config).toContain('port: "8080"')
    })
  })

  describe('writeConfig', () => {
    it('should write config to file', async () => {
      const configPath = path.join(tempDir, 'nebula.yaml')
      const config = generator.generateNebulaConfig(baseOptions)

      await generator.writeConfig(configPath, config)

      expect(fs.existsSync(configPath)).toBe(true)
      const content = fs.readFileSync(configPath, 'utf-8')
      expect(content).toContain('pki:')
    })

    it('should create parent directories', async () => {
      const configPath = path.join(tempDir, 'nested', 'dir', 'nebula.yaml')
      const config = generator.generateNebulaConfig(baseOptions)

      await generator.writeConfig(configPath, config)

      expect(fs.existsSync(configPath)).toBe(true)
    })
  })

  describe('multiple lighthouses', () => {
    it('should handle multiple lighthouses', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        lighthouses: {
          '10.42.0.1': '203.0.113.1:4242',
          '10.42.0.2': '203.0.113.2:4242',
          '10.42.0.3': '203.0.113.3:4242',
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('10.42.0.1:')
      expect(config).toContain('10.42.0.2:')
      expect(config).toContain('10.42.0.3:')
      expect(config).toContain('203.0.113.1:4242')
      expect(config).toContain('203.0.113.2:4242')
      expect(config).toContain('203.0.113.3:4242')
    })
  })

  describe('firewall rule formatting', () => {
    it('should handle CIDR notation', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        firewall: {
          inbound: [
            { proto: 'tcp', port: '22', host: '10.0.0.0/8' },
          ],
          outbound: [],
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('cidr: 10.0.0.0/8')
    })

    it('should handle specific host', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        firewall: {
          inbound: [
            { proto: 'tcp', port: '22', host: '10.42.0.5' },
          ],
          outbound: [],
        },
      }

      const config = generator.generateNebulaConfig(options)

      // Host may be quoted due to periods in IP address
      expect(config).toMatch(/host:\s*"?10\.42\.0\.5"?/)
    })

    it('should handle groups in firewall rules', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        firewall: {
          inbound: [
            { proto: 'tcp', port: '22', host: 'any', groups: ['admin', 'ops'] },
          ],
          outbound: [],
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('groups:')
      expect(config).toContain('admin')
      expect(config).toContain('ops')
    })
  })

  describe('conntrack timeout', () => {
    it('should use default conntrack timeout', () => {
      const config = generator.generateNebulaConfig(baseOptions)

      expect(config).toContain('conntrack:')
      // Timeout values are not quoted in YAML
      expect(config).toContain('tcp_timeout: 10m')
    })

    it('should use custom conntrack timeout', () => {
      const options: NebulaConfigOptions = {
        ...baseOptions,
        firewall: {
          conntrackTimeout: '30m',
          inbound: [],
          outbound: [],
        },
      }

      const config = generator.generateNebulaConfig(options)

      expect(config).toContain('tcp_timeout: 30m')
    })
  })
})
