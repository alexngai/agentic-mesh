import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  parseYaml,
  parseNebulaConfig,
  parseNebulaSetup,
  validateNebulaSetup,
} from '../../src/mesh/nebula-config-parser'

// Mock fs module
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}))

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

describe('parseYaml', () => {
  it('should parse simple key-value pairs', () => {
    const yaml = `
name: test
version: 1
enabled: true
`
    const result = parseYaml(yaml)

    expect(result.name).toBe('test')
    expect(result.version).toBe(1)
    expect(result.enabled).toBe(true)
  })

  it('should parse nested objects', () => {
    const yaml = `
pki:
  ca: /path/to/ca.crt
  cert: /path/to/host.crt
  key: /path/to/host.key
`
    const result = parseYaml(yaml)

    expect(result.pki).toBeDefined()
    const pki = result.pki as Record<string, string>
    expect(pki.ca).toBe('/path/to/ca.crt')
    expect(pki.cert).toBe('/path/to/host.crt')
    expect(pki.key).toBe('/path/to/host.key')
  })

  it('should parse arrays of strings', () => {
    const yaml = `
lighthouse:
  hosts:
    - "10.42.0.1"
    - "10.42.0.2"
`
    const result = parseYaml(yaml)

    expect(result.lighthouse).toBeDefined()
    const lighthouse = result.lighthouse as Record<string, unknown>
    expect(lighthouse.hosts).toEqual(['10.42.0.1', '10.42.0.2'])
  })

  it('should parse boolean values', () => {
    const yaml = `
lighthouse:
  am_lighthouse: true
punchy:
  punch: true
  respond: false
`
    const result = parseYaml(yaml)

    const lighthouse = result.lighthouse as Record<string, unknown>
    expect(lighthouse.am_lighthouse).toBe(true)

    const punchy = result.punchy as Record<string, unknown>
    expect(punchy.punch).toBe(true)
    expect(punchy.respond).toBe(false)
  })

  it('should parse quoted strings', () => {
    const yaml = `
host: "0.0.0.0"
port: "4242"
`
    const result = parseYaml(yaml)

    expect(result.host).toBe('0.0.0.0')
    expect(result.port).toBe('4242')
  })

  it('should skip comments', () => {
    const yaml = `
# This is a comment
name: test
# Another comment
version: 1
`
    const result = parseYaml(yaml)

    expect(result.name).toBe('test')
    expect(result.version).toBe(1)
    expect(Object.keys(result)).toHaveLength(2)
  })

  it('should parse null values', () => {
    const yaml = `
empty1: null
empty2: ~
`
    const result = parseYaml(yaml)

    expect(result.empty1).toBeNull()
    expect(result.empty2).toBeNull()
  })

  it('should parse a complete nebula config structure', () => {
    const yaml = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/host.crt
  key: /etc/nebula/host.key

lighthouse:
  am_lighthouse: false
  interval: 60
  hosts:
    - "10.42.0.1"

listen:
  host: "0.0.0.0"
  port: 4242

tun:
  disabled: false
  dev: nebula1
  mtu: 1300
`
    const result = parseYaml(yaml)

    // PKI section
    const pki = result.pki as Record<string, string>
    expect(pki.ca).toBe('/etc/nebula/ca.crt')

    // Lighthouse section
    const lighthouse = result.lighthouse as Record<string, unknown>
    expect(lighthouse.am_lighthouse).toBe(false)
    expect(lighthouse.interval).toBe(60)
    expect(lighthouse.hosts).toEqual(['10.42.0.1'])

    // Listen section
    const listen = result.listen as Record<string, unknown>
    expect(listen.host).toBe('0.0.0.0')
    expect(listen.port).toBe(4242)

    // TUN section
    const tun = result.tun as Record<string, unknown>
    expect(tun.disabled).toBe(false)
    expect(tun.dev).toBe('nebula1')
    expect(tun.mtu).toBe(1300)
  })
})

describe('parseNebulaConfig', () => {
  const mockFs = fs as unknown as {
    readFile: ReturnType<typeof vi.fn>
    access: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should parse a valid nebula config file', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/host.crt
  key: /etc/nebula/host.key

lighthouse:
  am_lighthouse: false
  interval: 60
  hosts:
    - "10.42.0.1"

static_host_map:
  10.42.0.1:
    - "lighthouse.example.com:4242"

listen:
  host: "0.0.0.0"
  port: 4242
`
    mockFs.readFile.mockResolvedValue(configContent)

    const result = await parseNebulaConfig('/etc/nebula/config.yaml')

    expect(result.pki.caPath).toBe('/etc/nebula/ca.crt')
    expect(result.pki.certPath).toBe('/etc/nebula/host.crt')
    expect(result.pki.keyPath).toBe('/etc/nebula/host.key')
    expect(result.lighthouse.amLighthouse).toBe(false)
    expect(result.lighthouse.interval).toBe(60)
    expect(result.listen.host).toBe('0.0.0.0')
    expect(result.listen.port).toBe(4242)
    expect(result.isLighthouse).toBe(false)
  })

  it('should detect lighthouse configuration', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/lighthouse.crt
  key: /etc/nebula/lighthouse.key

lighthouse:
  am_lighthouse: true
  interval: 60

listen:
  host: "0.0.0.0"
  port: 4242
`
    mockFs.readFile.mockResolvedValue(configContent)

    const result = await parseNebulaConfig('/etc/nebula/config.yaml')

    expect(result.lighthouse.amLighthouse).toBe(true)
    expect(result.isLighthouse).toBe(true)
  })

  it('should use default values for missing optional fields', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/host.crt
  key: /etc/nebula/host.key
`
    mockFs.readFile.mockResolvedValue(configContent)

    const result = await parseNebulaConfig('/etc/nebula/config.yaml')

    expect(result.listen.host).toBe('0.0.0.0')
    expect(result.listen.port).toBe(4242)
    expect(result.lighthouse.amLighthouse).toBe(false)
    expect(result.lighthouse.interval).toBe(60)
    expect(result.isLighthouse).toBe(false)
  })

  it('should throw error when pki section is missing', async () => {
    const configContent = `
lighthouse:
  am_lighthouse: false
`
    mockFs.readFile.mockResolvedValue(configContent)

    await expect(parseNebulaConfig('/etc/nebula/config.yaml')).rejects.toThrow(
      'Missing pki section'
    )
  })

  it('should resolve relative paths against config directory', async () => {
    const configContent = `
pki:
  ca: ./ca.crt
  cert: ./host.crt
  key: ./host.key
`
    mockFs.readFile.mockResolvedValue(configContent)

    const result = await parseNebulaConfig('/etc/nebula/config.yaml')

    expect(result.pki.caPath).toBe(path.resolve('/etc/nebula', './ca.crt'))
    expect(result.pki.certPath).toBe(path.resolve('/etc/nebula', './host.crt'))
    expect(result.pki.keyPath).toBe(path.resolve('/etc/nebula', './host.key'))
  })
})

describe('validateNebulaSetup', () => {
  const mockFs = fs as unknown as {
    readFile: ReturnType<typeof vi.fn>
    access: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return valid when all files exist', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/host.crt
  key: /etc/nebula/host.key
`
    mockFs.readFile.mockResolvedValue(configContent)
    mockFs.access.mockResolvedValue(undefined)

    const result = await validateNebulaSetup('/etc/nebula/config.yaml')

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should return errors when certificate file is missing', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/missing.crt
  key: /etc/nebula/host.key
`
    mockFs.readFile.mockResolvedValue(configContent)
    mockFs.access.mockImplementation((filePath: string) => {
      if (filePath === '/etc/nebula/missing.crt') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve()
    })

    const result = await validateNebulaSetup('/etc/nebula/config.yaml')

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Certificate not found: /etc/nebula/missing.crt')
  })

  it('should return errors when CA file is missing', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/missing-ca.crt
  cert: /etc/nebula/host.crt
  key: /etc/nebula/host.key
`
    mockFs.readFile.mockResolvedValue(configContent)
    mockFs.access.mockImplementation((filePath: string) => {
      if (filePath === '/etc/nebula/missing-ca.crt') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve()
    })

    const result = await validateNebulaSetup('/etc/nebula/config.yaml')

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('CA certificate not found: /etc/nebula/missing-ca.crt')
  })

  it('should return errors when key file is missing', async () => {
    const configContent = `
pki:
  ca: /etc/nebula/ca.crt
  cert: /etc/nebula/host.crt
  key: /etc/nebula/missing.key
`
    mockFs.readFile.mockResolvedValue(configContent)
    mockFs.access.mockImplementation((filePath: string) => {
      if (filePath === '/etc/nebula/missing.key') {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve()
    })

    const result = await validateNebulaSetup('/etc/nebula/config.yaml')

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Key file not found: /etc/nebula/missing.key')
  })
})
