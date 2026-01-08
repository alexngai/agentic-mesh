// Extension Loader - Platform-specific cr-sqlite extension detection
// Implements: s-iidh

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { DbSyncError } from './types'

// =============================================================================
// Platform Detection
// =============================================================================

type Platform = 'darwin' | 'linux' | 'win32'
type Arch = 'x64' | 'arm64'

interface PlatformInfo {
  platform: Platform
  arch: Arch
  extensionName: string
}

function getPlatformInfo(): PlatformInfo {
  const platform = os.platform() as Platform
  const arch = os.arch() as Arch

  let extensionName: string
  switch (platform) {
    case 'darwin':
      extensionName = 'crsqlite.dylib'
      break
    case 'linux':
      extensionName = 'crsqlite.so'
      break
    case 'win32':
      extensionName = 'crsqlite.dll'
      break
    default:
      throw new DbSyncError(
        `Unsupported platform: ${platform}`,
        'EXTENSION_NOT_FOUND',
        false
      )
  }

  return { platform, arch, extensionName }
}

// =============================================================================
// Search Paths
// =============================================================================

function getSearchPaths(extensionName: string): string[] {
  const paths: string[] = []
  const cwd = process.cwd()
  const homeDir = os.homedir()

  // 1. Current working directory
  paths.push(path.join(cwd, extensionName))
  paths.push(path.join(cwd, 'extensions', extensionName))
  paths.push(path.join(cwd, 'lib', extensionName))

  // 2. Node modules (if installed via npm)
  paths.push(path.join(cwd, 'node_modules', '@aspect-build', 'aspect-rules-cr-sqlite', extensionName))
  paths.push(path.join(cwd, 'node_modules', 'cr-sqlite', extensionName))
  paths.push(path.join(cwd, 'node_modules', '.cr-sqlite', extensionName))

  // 3. User-level locations
  paths.push(path.join(homeDir, '.cr-sqlite', extensionName))
  paths.push(path.join(homeDir, '.local', 'lib', extensionName))

  // 4. System locations (Unix)
  if (process.platform !== 'win32') {
    paths.push(path.join('/usr', 'local', 'lib', extensionName))
    paths.push(path.join('/usr', 'lib', extensionName))
    paths.push(path.join('/opt', 'cr-sqlite', extensionName))
  }

  // 5. Environment variable
  const envPath = process.env.CRSQLITE_EXTENSION_PATH
  if (envPath) {
    paths.unshift(envPath) // Highest priority
  }

  return paths
}

// =============================================================================
// Extension Discovery
// =============================================================================

/**
 * Detect the cr-sqlite extension path.
 * Searches common locations and returns the first valid path found.
 *
 * @returns Path to the cr-sqlite extension
 * @throws DbSyncError if extension not found
 */
export function detectExtensionPath(): string {
  const { extensionName } = getPlatformInfo()
  const searchPaths = getSearchPaths(extensionName)

  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath)) {
      return searchPath
    }
  }

  throw new DbSyncError(
    `cr-sqlite extension not found. Searched:\n${searchPaths.slice(0, 5).join('\n')}\n...\n\n` +
      `Install via: npm install @aspect-build/aspect-rules-cr-sqlite\n` +
      `Or download from: https://github.com/vlcn-io/cr-sqlite/releases\n` +
      `Or set CRSQLITE_EXTENSION_PATH environment variable`,
    'EXTENSION_NOT_FOUND',
    false
  )
}

/**
 * Validate that a given path points to a valid cr-sqlite extension.
 *
 * @param extensionPath - Path to validate
 * @returns true if valid
 * @throws DbSyncError if invalid
 */
export function validateExtensionPath(extensionPath: string): boolean {
  if (!fs.existsSync(extensionPath)) {
    throw new DbSyncError(
      `cr-sqlite extension not found at: ${extensionPath}`,
      'EXTENSION_NOT_FOUND',
      false
    )
  }

  const stats = fs.statSync(extensionPath)
  if (!stats.isFile()) {
    throw new DbSyncError(
      `cr-sqlite extension path is not a file: ${extensionPath}`,
      'EXTENSION_NOT_FOUND',
      false
    )
  }

  return true
}

/**
 * Get the extension path, either from config or auto-detected.
 *
 * @param configPath - Optional path from config
 * @returns Validated extension path
 */
export function getExtensionPath(configPath?: string): string {
  if (configPath) {
    validateExtensionPath(configPath)
    return configPath
  }
  return detectExtensionPath()
}

// =============================================================================
// Installation Helper
// =============================================================================

/**
 * Get installation instructions for the current platform.
 */
export function getInstallInstructions(): string {
  const { platform, arch } = getPlatformInfo()

  const baseUrl = 'https://github.com/vlcn-io/cr-sqlite/releases/latest/download'
  let assetName: string

  switch (platform) {
    case 'darwin':
      assetName = arch === 'arm64' ? 'crsqlite-darwin-aarch64.dylib' : 'crsqlite-darwin-x86_64.dylib'
      break
    case 'linux':
      assetName = arch === 'arm64' ? 'crsqlite-linux-aarch64.so' : 'crsqlite-linux-x86_64.so'
      break
    case 'win32':
      assetName = 'crsqlite-windows-x86_64.dll'
      break
    default:
      assetName = 'crsqlite-<platform>-<arch>.<ext>'
  }

  return `
cr-sqlite Installation Instructions
====================================

Option 1: npm (recommended)
  npm install @aspect-build/aspect-rules-cr-sqlite

Option 2: Direct download
  curl -LO ${baseUrl}/${assetName}
  mkdir -p ~/.cr-sqlite
  mv ${assetName} ~/.cr-sqlite/crsqlite.${platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'}

Option 3: Environment variable
  export CRSQLITE_EXTENSION_PATH=/path/to/crsqlite.${platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'}

For more info: https://vlcn.io/docs/cr-sqlite/installation
`.trim()
}
