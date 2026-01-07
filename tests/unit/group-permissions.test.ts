import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  GroupPermissions,
  PermissionLevel,
  PermissionDeniedError,
  groupPermissions,
} from '../../src/certs/group-permissions'
import { CertificateInfo } from '../../src/certs/types'

describe('GroupPermissions', () => {
  describe('Constructor and Configuration', () => {
    it('should create with default configuration', () => {
      const perms = new GroupPermissions()
      const hierarchy = perms.getHierarchy()

      expect(hierarchy.admin).toContain('admin')
      expect(hierarchy.write).toContain('write')
      expect(hierarchy.read).toContain('read')
    })

    it('should create with custom hierarchy', () => {
      const perms = new GroupPermissions({
        hierarchy: {
          admin: ['superuser'],
          write: ['editor'],
          read: ['viewer'],
        },
      })
      const hierarchy = perms.getHierarchy()

      expect(hierarchy.admin).toEqual(['superuser'])
      expect(hierarchy.write).toEqual(['editor'])
      expect(hierarchy.read).toEqual(['viewer'])
    })

    it('should allow updating hierarchy', () => {
      const perms = new GroupPermissions()
      const listener = vi.fn()
      perms.on('hierarchy-changed', listener)

      perms.setHierarchy({
        admin: ['root'],
        write: ['contrib'],
        read: ['guest'],
      })

      expect(perms.getHierarchy().admin).toEqual(['root'])
      expect(listener).toHaveBeenCalledWith({
        admin: ['root'],
        write: ['contrib'],
        read: ['guest'],
      })
    })
  })

  describe('Group Checking Methods', () => {
    let perms: GroupPermissions

    beforeEach(() => {
      perms = new GroupPermissions()
    })

    it('should check single group membership with hasGroup', () => {
      expect(perms.hasGroup(['admin', 'users'], 'admin')).toBe(true)
      expect(perms.hasGroup(['admin', 'users'], 'users')).toBe(true)
      expect(perms.hasGroup(['admin', 'users'], 'guest')).toBe(false)
    })

    it('should check any group membership with hasAnyGroup', () => {
      expect(perms.hasAnyGroup(['viewer'], ['admin', 'viewer'])).toBe(true)
      expect(perms.hasAnyGroup(['admin'], ['admin', 'viewer'])).toBe(true)
      expect(perms.hasAnyGroup(['guest'], ['admin', 'viewer'])).toBe(false)
      expect(perms.hasAnyGroup([], ['admin', 'viewer'])).toBe(false)
    })

    it('should check all groups membership with hasAllGroups', () => {
      expect(perms.hasAllGroups(['admin', 'viewer', 'user'], ['admin', 'viewer'])).toBe(true)
      expect(perms.hasAllGroups(['admin'], ['admin', 'viewer'])).toBe(false)
      expect(perms.hasAllGroups(['admin', 'viewer'], ['admin', 'viewer'])).toBe(true)
      expect(perms.hasAllGroups([], ['admin'])).toBe(false)
    })
  })

  describe('Permission Level Checking', () => {
    let perms: GroupPermissions

    beforeEach(() => {
      perms = new GroupPermissions({
        hierarchy: {
          admin: ['mesh-admin'],
          write: ['mesh-writer'],
          read: ['mesh-reader'],
        },
      })
    })

    it('should return ADMIN level for admin groups', () => {
      expect(perms.getPermissionLevel(['mesh-admin'])).toBe(PermissionLevel.ADMIN)
    })

    it('should return WRITE level for write groups', () => {
      expect(perms.getPermissionLevel(['mesh-writer'])).toBe(PermissionLevel.WRITE)
    })

    it('should return READ level for read groups', () => {
      expect(perms.getPermissionLevel(['mesh-reader'])).toBe(PermissionLevel.READ)
    })

    it('should return NONE level for unknown groups', () => {
      expect(perms.getPermissionLevel(['unknown'])).toBe(PermissionLevel.NONE)
      expect(perms.getPermissionLevel([])).toBe(PermissionLevel.NONE)
    })

    it('should return highest level when user has multiple groups', () => {
      expect(perms.getPermissionLevel(['mesh-reader', 'mesh-admin'])).toBe(PermissionLevel.ADMIN)
      expect(perms.getPermissionLevel(['mesh-reader', 'mesh-writer'])).toBe(PermissionLevel.WRITE)
    })

    it('should check permission level correctly', () => {
      expect(perms.hasPermissionLevel(['mesh-admin'], PermissionLevel.ADMIN)).toBe(true)
      expect(perms.hasPermissionLevel(['mesh-admin'], PermissionLevel.WRITE)).toBe(true)
      expect(perms.hasPermissionLevel(['mesh-admin'], PermissionLevel.READ)).toBe(true)

      expect(perms.hasPermissionLevel(['mesh-writer'], PermissionLevel.ADMIN)).toBe(false)
      expect(perms.hasPermissionLevel(['mesh-writer'], PermissionLevel.WRITE)).toBe(true)
      expect(perms.hasPermissionLevel(['mesh-writer'], PermissionLevel.READ)).toBe(true)

      expect(perms.hasPermissionLevel(['mesh-reader'], PermissionLevel.ADMIN)).toBe(false)
      expect(perms.hasPermissionLevel(['mesh-reader'], PermissionLevel.WRITE)).toBe(false)
      expect(perms.hasPermissionLevel(['mesh-reader'], PermissionLevel.READ)).toBe(true)
    })
  })

  describe('Permission Check with Details', () => {
    let perms: GroupPermissions

    beforeEach(() => {
      perms = new GroupPermissions({
        hierarchy: {
          admin: ['admin'],
          write: ['writer'],
          read: ['reader'],
        },
      })
    })

    it('should return allowed=true for sufficient permissions', () => {
      const result = perms.checkPermission(['admin'], PermissionLevel.READ)
      expect(result.allowed).toBe(true)
      expect(result.level).toBe(PermissionLevel.ADMIN)
      expect(result.matchedGroups).toContain('admin')
    })

    it('should return allowed=false for insufficient permissions', () => {
      const result = perms.checkPermission(['reader'], PermissionLevel.WRITE)
      expect(result.allowed).toBe(false)
      expect(result.level).toBe(PermissionLevel.READ)
      expect(result.missingGroups).toContain('admin')
      expect(result.missingGroups).toContain('writer')
    })

    it('should include matched groups in result', () => {
      const result = perms.checkPermission(['writer', 'reader'], PermissionLevel.WRITE)
      expect(result.matchedGroups).toContain('writer')
      expect(result.matchedGroups).toContain('reader')
    })

    it('should not include missingGroups when allowed', () => {
      const result = perms.checkPermission(['admin'], PermissionLevel.ADMIN)
      expect(result.allowed).toBe(true)
      expect(result.missingGroups).toBeUndefined()
    })
  })

  describe('Convenience Check Methods', () => {
    let perms: GroupPermissions

    beforeEach(() => {
      perms = new GroupPermissions({
        hierarchy: {
          admin: ['admin'],
          write: ['writer'],
          read: ['reader'],
        },
      })
    })

    it('should check canRead correctly', () => {
      expect(perms.canRead(['admin'])).toBe(true)
      expect(perms.canRead(['writer'])).toBe(true)
      expect(perms.canRead(['reader'])).toBe(true)
      expect(perms.canRead(['unknown'])).toBe(false)
    })

    it('should check canWrite correctly', () => {
      expect(perms.canWrite(['admin'])).toBe(true)
      expect(perms.canWrite(['writer'])).toBe(true)
      expect(perms.canWrite(['reader'])).toBe(false)
      expect(perms.canWrite(['unknown'])).toBe(false)
    })

    it('should check canAdmin correctly', () => {
      expect(perms.canAdmin(['admin'])).toBe(true)
      expect(perms.canAdmin(['writer'])).toBe(false)
      expect(perms.canAdmin(['reader'])).toBe(false)
      expect(perms.canAdmin(['unknown'])).toBe(false)
    })
  })

  describe('Permission Enforcement Methods', () => {
    let perms: GroupPermissions

    beforeEach(() => {
      perms = new GroupPermissions({
        hierarchy: {
          admin: ['admin'],
          write: ['writer'],
          read: ['reader'],
        },
      })
    })

    it('should not throw when permission is granted', () => {
      expect(() => perms.enforceRead(['reader'])).not.toThrow()
      expect(() => perms.enforceWrite(['writer'])).not.toThrow()
      expect(() => perms.enforceAdmin(['admin'])).not.toThrow()
    })

    it('should throw PermissionDeniedError when permission is denied', () => {
      expect(() => perms.enforceAdmin(['reader'])).toThrow(PermissionDeniedError)
      expect(() => perms.enforceWrite(['reader'])).toThrow(PermissionDeniedError)
      expect(() => perms.enforceRead(['unknown'])).toThrow(PermissionDeniedError)
    })

    it('should include details in PermissionDeniedError', () => {
      try {
        perms.enforceAdmin(['reader'])
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionDeniedError)
        const permError = error as PermissionDeniedError
        expect(permError.requiredLevel).toBe(PermissionLevel.ADMIN)
        expect(permError.actualLevel).toBe(PermissionLevel.READ)
        expect(permError.userGroups).toContain('reader')
        expect(permError.requiredGroups).toContain('admin')
        expect(permError.message).toContain('admin')
      }
    })

    it('should work with enforcePermission for custom level', () => {
      expect(() => perms.enforcePermission(['writer'], PermissionLevel.WRITE)).not.toThrow()
      expect(() => perms.enforcePermission(['reader'], PermissionLevel.WRITE)).toThrow(
        PermissionDeniedError
      )
    })
  })

  describe('Admin Implies All', () => {
    it('should grant all permissions to admin when adminImpliesAll is true', () => {
      const perms = new GroupPermissions({
        hierarchy: {
          admin: ['superadmin'],
          write: ['writer'],
          read: ['reader'],
        },
        adminImpliesAll: true,
      })

      expect(perms.canRead(['superadmin'])).toBe(true)
      expect(perms.canWrite(['superadmin'])).toBe(true)
      expect(perms.canAdmin(['superadmin'])).toBe(true)
    })

    it('should not grant extra permissions when adminImpliesAll is false', () => {
      const perms = new GroupPermissions({
        hierarchy: {
          admin: ['superadmin'],
          write: ['writer'],
          read: ['reader'],
        },
        adminImpliesAll: false,
      })

      // Admin level should still be >= all other levels
      expect(perms.canRead(['superadmin'])).toBe(true)
      expect(perms.canWrite(['superadmin'])).toBe(true)
      expect(perms.canAdmin(['superadmin'])).toBe(true)
    })
  })

  describe('Custom Resolver', () => {
    it('should use custom resolver when provided', () => {
      const customResolver = vi.fn().mockReturnValue({
        allowed: true,
        level: PermissionLevel.ADMIN,
        matchedGroups: ['custom-group'],
      })

      const perms = new GroupPermissions({
        customResolver,
      })

      const result = perms.checkPermission(['any-group'], PermissionLevel.WRITE)

      expect(customResolver).toHaveBeenCalledWith(['any-group'], PermissionLevel.WRITE)
      expect(result.allowed).toBe(true)
      expect(result.matchedGroups).toContain('custom-group')
    })

    it('should fall back to default when resolver returns undefined', () => {
      const customResolver = vi.fn().mockReturnValue(undefined)

      const perms = new GroupPermissions({
        hierarchy: {
          admin: ['admin'],
          write: ['writer'],
          read: ['reader'],
        },
        customResolver,
      })

      const result = perms.checkPermission(['writer'], PermissionLevel.WRITE)

      expect(customResolver).toHaveBeenCalled()
      expect(result.allowed).toBe(true)
      expect(result.level).toBe(PermissionLevel.WRITE)
    })
  })

  describe('Certificate Integration', () => {
    let perms: GroupPermissions
    let mockCert: CertificateInfo

    beforeEach(() => {
      perms = new GroupPermissions({
        hierarchy: {
          admin: ['mesh-admin'],
          write: ['mesh-writer'],
          read: ['mesh-reader'],
        },
      })

      mockCert = {
        name: 'test-peer',
        type: 'server',
        groups: ['mesh-writer', 'mesh-reader'],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        certPath: '/certs/test.crt',
        keyPath: '/certs/test.key',
        revoked: false,
      }
    })

    it('should extract groups from certificate', () => {
      const groups = perms.getGroupsFromCert(mockCert)
      expect(groups).toContain('mesh-writer')
      expect(groups).toContain('mesh-reader')
    })

    it('should check certificate permissions', () => {
      const result = perms.checkCertPermission(mockCert, PermissionLevel.WRITE)
      expect(result.allowed).toBe(true)
      expect(result.level).toBe(PermissionLevel.WRITE)
    })

    it('should enforce certificate permissions', () => {
      expect(() => perms.enforceCertPermission(mockCert, PermissionLevel.WRITE)).not.toThrow()
      expect(() => perms.enforceCertPermission(mockCert, PermissionLevel.ADMIN)).toThrow(
        PermissionDeniedError
      )
    })

    it('should check certCanRead correctly', () => {
      expect(perms.certCanRead(mockCert)).toBe(true)

      const noReadCert = { ...mockCert, groups: ['unknown'] }
      expect(perms.certCanRead(noReadCert)).toBe(false)
    })

    it('should check certCanWrite correctly', () => {
      expect(perms.certCanWrite(mockCert)).toBe(true)

      const readOnlyCert = { ...mockCert, groups: ['mesh-reader'] }
      expect(perms.certCanWrite(readOnlyCert)).toBe(false)
    })

    it('should check certCanAdmin correctly', () => {
      expect(perms.certCanAdmin(mockCert)).toBe(false)

      const adminCert = { ...mockCert, groups: ['mesh-admin'] }
      expect(perms.certCanAdmin(adminCert)).toBe(true)
    })
  })

  describe('Middleware-style Helpers', () => {
    let perms: GroupPermissions

    beforeEach(() => {
      perms = new GroupPermissions({
        hierarchy: {
          admin: ['admin'],
          write: ['writer'],
          read: ['reader'],
        },
      })
    })

    it('should create checker function', () => {
      const canWrite = perms.createChecker(PermissionLevel.WRITE)

      expect(canWrite(['admin'])).toBe(true)
      expect(canWrite(['writer'])).toBe(true)
      expect(canWrite(['reader'])).toBe(false)
    })

    it('should create enforcer function', () => {
      const enforceWrite = perms.createEnforcer(PermissionLevel.WRITE)

      expect(() => enforceWrite(['writer'])).not.toThrow()
      expect(() => enforceWrite(['reader'])).toThrow(PermissionDeniedError)
    })

    it('should create cert checker function', () => {
      const certCanWrite = perms.createCertChecker(PermissionLevel.WRITE)
      const cert: CertificateInfo = {
        name: 'test',
        type: 'server',
        groups: ['writer'],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        certPath: '/certs/test.crt',
        keyPath: '/certs/test.key',
        revoked: false,
      }

      expect(certCanWrite(cert)).toBe(true)

      cert.groups = ['reader']
      expect(certCanWrite(cert)).toBe(false)
    })

    it('should create cert enforcer function', () => {
      const enforceCertWrite = perms.createCertEnforcer(PermissionLevel.WRITE)
      const cert: CertificateInfo = {
        name: 'test',
        type: 'server',
        groups: ['writer'],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        certPath: '/certs/test.crt',
        keyPath: '/certs/test.key',
        revoked: false,
      }

      expect(() => enforceCertWrite(cert)).not.toThrow()

      cert.groups = ['reader']
      expect(() => enforceCertWrite(cert)).toThrow(PermissionDeniedError)
    })
  })

  describe('Global Instance', () => {
    it('should export a default global instance', () => {
      expect(groupPermissions).toBeInstanceOf(GroupPermissions)
    })

    it('should have default configuration', () => {
      const hierarchy = groupPermissions.getHierarchy()
      expect(hierarchy.admin).toContain('admin')
    })
  })

  describe('PermissionLevel Enum', () => {
    it('should have correct hierarchy values', () => {
      expect(PermissionLevel.NONE).toBe(0)
      expect(PermissionLevel.READ).toBe(1)
      expect(PermissionLevel.WRITE).toBe(2)
      expect(PermissionLevel.ADMIN).toBe(3)
    })

    it('should support comparison operations', () => {
      expect(PermissionLevel.ADMIN > PermissionLevel.WRITE).toBe(true)
      expect(PermissionLevel.WRITE > PermissionLevel.READ).toBe(true)
      expect(PermissionLevel.READ > PermissionLevel.NONE).toBe(true)
    })
  })
})
