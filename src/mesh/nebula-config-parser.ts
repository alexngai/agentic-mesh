// Nebula Config Parser - Parse existing Nebula configuration files
// Implements: i-4j5g

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed Nebula configuration
 */
export interface ParsedNebulaConfig {
  /** PKI configuration */
  pki: {
    caPath: string
    certPath: string
    keyPath: string
  }
  /** Lighthouse configuration */
  lighthouse: {
    amLighthouse: boolean
    /** Map of Nebula IP to public endpoints */
    hosts: Map<string, string[]>
    interval: number
  }
  /** Listen configuration */
  listen: {
    host: string
    port: number
  }
  /** Static host map (Nebula IP to public endpoints) */
  staticHostMap: Map<string, string[]>
  /** Whether this is a lighthouse node */
  isLighthouse: boolean
}

/**
 * Parsed certificate information
 */
export interface ParsedCertInfo {
  /** Certificate name */
  name: string
  /** Nebula IP (with CIDR) */
  nebulaIp: string
  /** Groups assigned to this certificate */
  groups: string[]
  /** Certificate expiration */
  notAfter: Date
  /** Certificate creation */
  notBefore: Date
  /** Issuer name */
  issuer: string
  /** Is this a CA certificate */
  isCa: boolean
  /** Public key fingerprint */
  fingerprint?: string
}

/**
 * Complete parsed Nebula setup
 */
export interface NebulaSetup {
  config: ParsedNebulaConfig
  cert: ParsedCertInfo
  configPath: string
}

// =============================================================================
// YAML Parser (minimal, no dependencies)
// =============================================================================

/**
 * Minimal YAML parser for Nebula configs.
 * Supports the subset of YAML used by Nebula configurations.
 */
export function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = content.split('\n')
  const stack: { obj: Record<string, unknown>; indent: number }[] = [
    { obj: result, indent: -1 },
  ]

  let currentKey = ''
  let inArray: { arr: unknown[]; indent: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue
    }

    // Calculate indentation
    const indent = line.search(/\S/)
    const trimmed = line.trim()

    // Handle array items
    if (trimmed.startsWith('- ')) {
      const value = trimmed.substring(2).trim()

      if (inArray && indent >= inArray.indent) {
        // Check if it's a key-value in array (like firewall rules)
        if (value.includes(':')) {
          const obj = parseInlineObject(value)
          inArray.arr.push(obj)
        } else {
          inArray.arr.push(parseValue(value))
        }
        continue
      }
    }

    // Handle key-value pairs
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim()
      const value = trimmed.substring(colonIndex + 1).trim()

      // Pop stack to find correct parent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }

      const current = stack[stack.length - 1].obj

      // Reset array state when we move to a new key
      inArray = null

      if (value === '' || value === '~' || value === 'null') {
        // Nested object or null
        const nextLine = i + 1 < lines.length ? lines[i + 1] : ''
        const nextIndent = nextLine.search(/\S/)
        const nextTrimmed = nextLine.trim()

        if (nextIndent > indent && nextTrimmed.startsWith('- ')) {
          // Array follows
          const arr: unknown[] = []
          current[key] = arr
          inArray = { arr, indent: nextIndent }
        } else if (nextIndent > indent) {
          // Nested object follows
          const nested: Record<string, unknown> = {}
          current[key] = nested
          stack.push({ obj: nested, indent })
        } else {
          current[key] = null
        }
      } else {
        // Inline value
        current[key] = parseValue(value)
      }

      currentKey = key
    }
  }

  return result
}

function parseValue(value: string): unknown {
  // Handle quoted strings
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  // Handle booleans
  if (value === 'true') return true
  if (value === 'false') return false

  // Handle null
  if (value === 'null' || value === '~') return null

  // Handle numbers
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)

  // Handle arrays like ["item1", "item2"]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1)
    if (!inner.trim()) return []
    return inner.split(',').map((s) => parseValue(s.trim()))
  }

  return value
}

function parseInlineObject(value: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  // Handle inline key: value pairs separated by whitespace or commas
  const parts = value.split(/,\s*|\s{2,}/)

  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx).trim()
      const val = part.substring(colonIdx + 1).trim()
      obj[key] = parseValue(val)
    }
  }

  return obj
}

// =============================================================================
// Config Parser
// =============================================================================

/**
 * Parse a Nebula configuration file.
 *
 * @param configPath Path to nebula config.yaml file
 * @returns Parsed configuration
 */
export async function parseNebulaConfig(
  configPath: string
): Promise<ParsedNebulaConfig> {
  // Expand ~ to home directory
  const resolvedPath = configPath.replace(/^~/, os.homedir())
  const absolutePath = path.isAbsolute(resolvedPath)
    ? resolvedPath
    : path.resolve(resolvedPath)

  const content = await fs.readFile(absolutePath, 'utf-8')
  const raw = parseYaml(content)

  // Get config directory for relative path resolution
  const configDir = path.dirname(absolutePath)

  // Parse PKI
  const pki = raw.pki as Record<string, string> | undefined
  if (!pki) {
    throw new Error('Missing pki section in Nebula config')
  }

  const resolvePath = (p: string) => {
    if (!p) return p
    const expanded = p.replace(/^~/, os.homedir())
    return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded)
  }

  // Parse lighthouse config
  const lighthouse = raw.lighthouse as Record<string, unknown> | undefined
  const lighthouseHosts = new Map<string, string[]>()

  if (lighthouse?.hosts) {
    const hosts = lighthouse.hosts as string[]
    for (const host of hosts) {
      lighthouseHosts.set(host, [])
    }
  }

  // Parse static_host_map
  const staticHostMap = new Map<string, string[]>()
  const rawStaticMap = raw.static_host_map as Record<string, unknown> | undefined

  if (rawStaticMap) {
    for (const [ip, endpoints] of Object.entries(rawStaticMap)) {
      if (Array.isArray(endpoints)) {
        staticHostMap.set(ip, endpoints as string[])
        // Also populate lighthouse hosts if this IP is a lighthouse
        if (lighthouseHosts.has(ip)) {
          lighthouseHosts.set(ip, endpoints as string[])
        }
      }
    }
  }

  // Parse listen config
  const listen = raw.listen as Record<string, unknown> | undefined

  return {
    pki: {
      caPath: resolvePath(pki.ca),
      certPath: resolvePath(pki.cert),
      keyPath: resolvePath(pki.key),
    },
    lighthouse: {
      amLighthouse: (lighthouse?.am_lighthouse as boolean) ?? false,
      hosts: lighthouseHosts,
      interval: (lighthouse?.interval as number) ?? 60,
    },
    listen: {
      host: (listen?.host as string) ?? '0.0.0.0',
      port: (listen?.port as number) ?? 4242,
    },
    staticHostMap,
    isLighthouse: (lighthouse?.am_lighthouse as boolean) ?? false,
  }
}

// =============================================================================
// Certificate Parser
// =============================================================================

/**
 * Parse a Nebula certificate using nebula-cert binary.
 *
 * @param certPath Path to .crt file
 * @param nebulaCertPath Path to nebula-cert binary (default: 'nebula-cert')
 * @returns Parsed certificate information
 */
export async function parseCertificate(
  certPath: string,
  nebulaCertPath = 'nebula-cert'
): Promise<ParsedCertInfo> {
  // Expand ~ and resolve path
  const resolvedPath = certPath.replace(/^~/, os.homedir())
  const absolutePath = path.isAbsolute(resolvedPath)
    ? resolvedPath
    : path.resolve(resolvedPath)

  // Run nebula-cert print
  const result = await runCommand(nebulaCertPath, ['print', '-path', absolutePath, '-json'])

  if (!result.success) {
    throw new Error(`Failed to parse certificate: ${result.stderr}`)
  }

  const data = JSON.parse(result.stdout)
  const details = data.details

  return {
    name: details.name,
    nebulaIp: details.ips?.[0] ?? '',
    groups: details.groups ?? [],
    notAfter: new Date(details.notAfter),
    notBefore: new Date(details.notBefore),
    issuer: details.issuer ?? '',
    isCa: details.isCa ?? false,
    fingerprint: data.fingerprint,
  }
}

/**
 * Parse a certificate without using nebula-cert binary.
 * This is a fallback for environments where nebula-cert is not available.
 * Note: This parses the PEM format but cannot decode the actual certificate content.
 */
export async function parseCertificateFallback(
  certPath: string
): Promise<Partial<ParsedCertInfo>> {
  const resolvedPath = certPath.replace(/^~/, os.homedir())
  const absolutePath = path.isAbsolute(resolvedPath)
    ? resolvedPath
    : path.resolve(resolvedPath)

  const content = await fs.readFile(absolutePath, 'utf-8')

  // Check if it's a valid Nebula certificate
  if (!content.includes('-----BEGIN NEBULA CERTIFICATE-----')) {
    throw new Error('Invalid Nebula certificate format')
  }

  // We can't fully parse without nebula-cert, return partial info
  return {
    name: path.basename(certPath, '.crt'),
    groups: [],
  }
}

// =============================================================================
// Complete Setup Parser
// =============================================================================

/**
 * Parse a complete Nebula setup (config + certificate).
 *
 * @param configPath Path to nebula config.yaml
 * @param options Additional options
 * @returns Complete parsed setup
 */
export async function parseNebulaSetup(
  configPath: string,
  options: { nebulaCertPath?: string } = {}
): Promise<NebulaSetup> {
  const config = await parseNebulaConfig(configPath)

  // Verify certificate file exists
  try {
    await fs.access(config.pki.certPath)
  } catch {
    throw new Error(`Certificate file not found: ${config.pki.certPath}`)
  }

  // Verify key file exists
  try {
    await fs.access(config.pki.keyPath)
  } catch {
    throw new Error(`Key file not found: ${config.pki.keyPath}`)
  }

  // Verify CA file exists
  try {
    await fs.access(config.pki.caPath)
  } catch {
    throw new Error(`CA certificate not found: ${config.pki.caPath}`)
  }

  // Parse certificate
  let cert: ParsedCertInfo

  try {
    cert = await parseCertificate(config.pki.certPath, options.nebulaCertPath)
  } catch (error) {
    // Fallback to basic parsing
    const partial = await parseCertificateFallback(config.pki.certPath)
    cert = {
      name: partial.name ?? 'unknown',
      nebulaIp: '',
      groups: partial.groups ?? [],
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      notBefore: new Date(),
      issuer: '',
      isCa: false,
    }
  }

  // Resolve config path
  const resolvedConfigPath = configPath.replace(/^~/, os.homedir())

  return {
    config,
    cert,
    configPath: path.isAbsolute(resolvedConfigPath)
      ? resolvedConfigPath
      : path.resolve(resolvedConfigPath),
  }
}

// =============================================================================
// Helpers
// =============================================================================

interface CommandResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args)
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      })
    })

    proc.on('error', (error) => {
      resolve({
        success: false,
        stdout: '',
        stderr: error.message,
        exitCode: 1,
      })
    })
  })
}

/**
 * Validate that all required files exist for a Nebula configuration.
 */
export async function validateNebulaSetup(
  configPath: string
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = []

  try {
    const config = await parseNebulaConfig(configPath)

    // Check CA
    try {
      await fs.access(config.pki.caPath)
    } catch {
      errors.push(`CA certificate not found: ${config.pki.caPath}`)
    }

    // Check cert
    try {
      await fs.access(config.pki.certPath)
    } catch {
      errors.push(`Certificate not found: ${config.pki.certPath}`)
    }

    // Check key
    try {
      await fs.access(config.pki.keyPath)
    } catch {
      errors.push(`Key file not found: ${config.pki.keyPath}`)
    }
  } catch (error) {
    errors.push(`Failed to parse config: ${(error as Error).message}`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
