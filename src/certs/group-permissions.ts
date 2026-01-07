// Group Permission Helpers
// Implements: i-22a2

import { EventEmitter } from 'events'
import { CertificateInfo } from './types'

/**
 * Permission levels in hierarchical order (higher includes lower)
 */
export enum PermissionLevel {
  NONE = 0,
  READ = 1,
  WRITE = 2,
  ADMIN = 3,
}

/**
 * Group hierarchy configuration
 * Maps permission levels to required groups
 */
export interface GroupHierarchy {
  admin: string[]
  write: string[]
  read: string[]
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  allowed: boolean
  level: PermissionLevel
  matchedGroups: string[]
  missingGroups?: string[]
}

/**
 * Configuration for GroupPermissions
 */
export interface GroupPermissionsConfig {
  /**
   * Group hierarchy mapping permission levels to group names
   * Higher levels implicitly include lower levels
   */
  hierarchy?: GroupHierarchy

  /**
   * If true, admin group has all permissions
   * Default: true
   */
  adminImpliesAll?: boolean

  /**
   * Custom permission resolver for complex scenarios
   * Return undefined to use default hierarchy check
   */
  customResolver?: (
    groups: string[],
    requiredLevel: PermissionLevel
  ) => PermissionCheckResult | undefined
}

/**
 * Permission denied error with details
 */
export class PermissionDeniedError extends Error {
  constructor(
    public readonly requiredLevel: PermissionLevel,
    public readonly actualLevel: PermissionLevel,
    public readonly userGroups: string[],
    public readonly requiredGroups?: string[]
  ) {
    const levelName = PermissionLevel[requiredLevel].toLowerCase()
    super(`Permission denied: requires ${levelName} access`)
    this.name = 'PermissionDeniedError'
  }
}

/**
 * GroupPermissions - Helper class for group-based permission checking
 *
 * Provides configurable permission hierarchy and enforcement utilities.
 * Groups are extracted from Nebula certificates and can be used for
 * access control in mesh operations.
 *
 * @example
 * ```typescript
 * const permissions = new GroupPermissions({
 *   hierarchy: {
 *     admin: ['mesh-admins'],
 *     write: ['mesh-writers', 'mesh-editors'],
 *     read: ['mesh-readers', 'mesh-viewers'],
 *   }
 * })
 *
 * // Check permissions
 * if (permissions.canWrite(['mesh-writers'])) {
 *   // Allow write operation
 * }
 *
 * // Enforce permissions (throws on failure)
 * permissions.enforceAdmin(['mesh-readers']) // throws PermissionDeniedError
 * ```
 */
export class GroupPermissions extends EventEmitter {
  private readonly config: Required<GroupPermissionsConfig>

  constructor(config: GroupPermissionsConfig = {}) {
    super()

    this.config = {
      hierarchy: config.hierarchy ?? {
        admin: ['admin', 'admins'],
        write: ['write', 'writers', 'editor', 'editors'],
        read: ['read', 'readers', 'viewer', 'viewers'],
      },
      adminImpliesAll: config.adminImpliesAll ?? true,
      customResolver: config.customResolver ?? (() => undefined),
    }
  }

  /**
   * Get the hierarchy configuration
   */
  getHierarchy(): GroupHierarchy {
    return { ...this.config.hierarchy }
  }

  /**
   * Update the hierarchy configuration
   */
  setHierarchy(hierarchy: GroupHierarchy): void {
    this.config.hierarchy = hierarchy
    this.emit('hierarchy-changed', hierarchy)
  }

  // =========================================================================
  // Group Checking Methods
  // =========================================================================

  /**
   * Check if user has a specific group
   */
  hasGroup(userGroups: string[], group: string): boolean {
    return userGroups.includes(group)
  }

  /**
   * Check if user has any of the specified groups
   */
  hasAnyGroup(userGroups: string[], groups: string[]): boolean {
    return groups.some((g) => userGroups.includes(g))
  }

  /**
   * Check if user has all of the specified groups
   */
  hasAllGroups(userGroups: string[], groups: string[]): boolean {
    return groups.every((g) => userGroups.includes(g))
  }

  // =========================================================================
  // Permission Level Checking
  // =========================================================================

  /**
   * Get the effective permission level for a set of groups
   */
  getPermissionLevel(userGroups: string[]): PermissionLevel {
    // Check custom resolver first
    const customResult = this.config.customResolver(userGroups, PermissionLevel.ADMIN)
    if (customResult !== undefined) {
      return customResult.level
    }

    // Check hierarchy from highest to lowest
    if (this.hasAnyGroup(userGroups, this.config.hierarchy.admin)) {
      return PermissionLevel.ADMIN
    }
    if (this.hasAnyGroup(userGroups, this.config.hierarchy.write)) {
      return PermissionLevel.WRITE
    }
    if (this.hasAnyGroup(userGroups, this.config.hierarchy.read)) {
      return PermissionLevel.READ
    }

    return PermissionLevel.NONE
  }

  /**
   * Check if user has at least the specified permission level
   */
  hasPermissionLevel(userGroups: string[], requiredLevel: PermissionLevel): boolean {
    const actualLevel = this.getPermissionLevel(userGroups)

    // Admin implies all if configured
    if (this.config.adminImpliesAll && actualLevel === PermissionLevel.ADMIN) {
      return true
    }

    return actualLevel >= requiredLevel
  }

  /**
   * Check permission and return detailed result
   */
  checkPermission(userGroups: string[], requiredLevel: PermissionLevel): PermissionCheckResult {
    // Check custom resolver first
    const customResult = this.config.customResolver(userGroups, requiredLevel)
    if (customResult !== undefined) {
      return customResult
    }

    const actualLevel = this.getPermissionLevel(userGroups)
    const allowed =
      actualLevel >= requiredLevel ||
      (this.config.adminImpliesAll && actualLevel === PermissionLevel.ADMIN)

    // Find matched groups
    const matchedGroups: string[] = []
    const allConfiguredGroups = [
      ...this.config.hierarchy.admin,
      ...this.config.hierarchy.write,
      ...this.config.hierarchy.read,
    ]
    for (const group of userGroups) {
      if (allConfiguredGroups.includes(group)) {
        matchedGroups.push(group)
      }
    }

    // Find missing groups if not allowed
    let missingGroups: string[] | undefined
    if (!allowed) {
      switch (requiredLevel) {
        case PermissionLevel.ADMIN:
          missingGroups = this.config.hierarchy.admin
          break
        case PermissionLevel.WRITE:
          missingGroups = [...this.config.hierarchy.admin, ...this.config.hierarchy.write]
          break
        case PermissionLevel.READ:
          missingGroups = [
            ...this.config.hierarchy.admin,
            ...this.config.hierarchy.write,
            ...this.config.hierarchy.read,
          ]
          break
      }
    }

    return {
      allowed,
      level: actualLevel,
      matchedGroups,
      missingGroups,
    }
  }

  // =========================================================================
  // Permission Check Convenience Methods
  // =========================================================================

  /**
   * Check if user can read (has READ or higher permission)
   */
  canRead(userGroups: string[]): boolean {
    return this.hasPermissionLevel(userGroups, PermissionLevel.READ)
  }

  /**
   * Check if user can write (has WRITE or higher permission)
   */
  canWrite(userGroups: string[]): boolean {
    return this.hasPermissionLevel(userGroups, PermissionLevel.WRITE)
  }

  /**
   * Check if user can admin (has ADMIN permission)
   */
  canAdmin(userGroups: string[]): boolean {
    return this.hasPermissionLevel(userGroups, PermissionLevel.ADMIN)
  }

  // =========================================================================
  // Permission Enforcement Methods (throw on failure)
  // =========================================================================

  /**
   * Enforce read permission, throw PermissionDeniedError on failure
   */
  enforceRead(userGroups: string[]): void {
    this.enforcePermission(userGroups, PermissionLevel.READ)
  }

  /**
   * Enforce write permission, throw PermissionDeniedError on failure
   */
  enforceWrite(userGroups: string[]): void {
    this.enforcePermission(userGroups, PermissionLevel.WRITE)
  }

  /**
   * Enforce admin permission, throw PermissionDeniedError on failure
   */
  enforceAdmin(userGroups: string[]): void {
    this.enforcePermission(userGroups, PermissionLevel.ADMIN)
  }

  /**
   * Enforce a specific permission level, throw on failure
   */
  enforcePermission(userGroups: string[], requiredLevel: PermissionLevel): void {
    const result = this.checkPermission(userGroups, requiredLevel)
    if (!result.allowed) {
      throw new PermissionDeniedError(requiredLevel, result.level, userGroups, result.missingGroups)
    }
  }

  // =========================================================================
  // Certificate Integration
  // =========================================================================

  /**
   * Extract groups from a certificate
   */
  getGroupsFromCert(cert: CertificateInfo): string[] {
    return [...cert.groups]
  }

  /**
   * Check permission for a certificate
   */
  checkCertPermission(cert: CertificateInfo, requiredLevel: PermissionLevel): PermissionCheckResult {
    return this.checkPermission(cert.groups, requiredLevel)
  }

  /**
   * Enforce permission for a certificate
   */
  enforceCertPermission(cert: CertificateInfo, requiredLevel: PermissionLevel): void {
    this.enforcePermission(cert.groups, requiredLevel)
  }

  /**
   * Check if certificate can read
   */
  certCanRead(cert: CertificateInfo): boolean {
    return this.canRead(cert.groups)
  }

  /**
   * Check if certificate can write
   */
  certCanWrite(cert: CertificateInfo): boolean {
    return this.canWrite(cert.groups)
  }

  /**
   * Check if certificate can admin
   */
  certCanAdmin(cert: CertificateInfo): boolean {
    return this.canAdmin(cert.groups)
  }

  // =========================================================================
  // Middleware-style Helpers
  // =========================================================================

  /**
   * Create a permission checker function for a specific level
   * Useful for middleware patterns
   */
  createChecker(requiredLevel: PermissionLevel): (groups: string[]) => boolean {
    return (groups: string[]) => this.hasPermissionLevel(groups, requiredLevel)
  }

  /**
   * Create a permission enforcer function for a specific level
   * Useful for middleware patterns
   */
  createEnforcer(requiredLevel: PermissionLevel): (groups: string[]) => void {
    return (groups: string[]) => this.enforcePermission(groups, requiredLevel)
  }

  /**
   * Create a certificate permission checker
   */
  createCertChecker(requiredLevel: PermissionLevel): (cert: CertificateInfo) => boolean {
    return (cert: CertificateInfo) => this.hasPermissionLevel(cert.groups, requiredLevel)
  }

  /**
   * Create a certificate permission enforcer
   */
  createCertEnforcer(requiredLevel: PermissionLevel): (cert: CertificateInfo) => void {
    return (cert: CertificateInfo) => this.enforceCertPermission(cert, requiredLevel)
  }
}

/**
 * Default global instance with standard configuration
 */
export const groupPermissions = new GroupPermissions()
