import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ScopeManager } from '../../src/map/server/scope-manager'
import type { Scope, ScopeId } from '../../src/map/types'

describe('ScopeManager', () => {
  let manager: ScopeManager

  beforeEach(() => {
    manager = new ScopeManager()
  })

  describe('Create', () => {
    it('should create a scope with generated ID', () => {
      const scope = manager.create({
        name: 'Test Scope',
      })

      expect(scope.id).toBeDefined()
      expect(scope.name).toBe('Test Scope')
    })

    it('should create a scope with provided ID', () => {
      const scope = manager.create({
        scopeId: 'custom-scope',
        name: 'Custom Scope',
      })

      expect(scope.id).toBe('custom-scope')
    })

    it('should throw if scope ID already exists', () => {
      manager.create({ scopeId: 'duplicate' })

      expect(() => {
        manager.create({ scopeId: 'duplicate' })
      }).toThrow('Scope already exists')
    })

    it('should emit scope:created event', () => {
      const handler = vi.fn()
      manager.on('scope:created', handler)

      const scope = manager.create({ name: 'Test' })

      expect(handler).toHaveBeenCalledWith(scope)
    })

    it('should set default values', () => {
      const scope = manager.create({})

      expect(scope.joinPolicy).toBe('open')
      expect(scope.visibility).toBe('public')
      expect(scope.messageVisibility).toBe('members')
      expect(scope.sendPolicy).toBe('members')
    })

    it('should allow custom configuration', () => {
      const scope = manager.create({
        scopeId: 'restricted',
        joinPolicy: 'invite',
        visibility: 'members',
        messageVisibility: 'members',
        sendPolicy: 'members',
        persistent: true,
        autoDelete: false,
      })

      expect(scope.joinPolicy).toBe('invite')
      expect(scope.visibility).toBe('members')
      expect(scope.persistent).toBe(true)
      expect(scope.autoDelete).toBe(false)
    })
  })

  describe('Delete', () => {
    it('should delete a scope', () => {
      manager.create({ scopeId: 'scope-1' })

      const deleted = manager.delete('scope-1')

      expect(deleted.id).toBe('scope-1')
      expect(manager.has('scope-1')).toBe(false)
    })

    it('should throw if scope not found', () => {
      expect(() => {
        manager.delete('non-existent')
      }).toThrow('Scope not found')
    })

    it('should emit scope:deleted event', () => {
      const handler = vi.fn()
      manager.on('scope:deleted', handler)

      manager.create({ scopeId: 'scope-1' })
      manager.delete('scope-1')

      expect(handler).toHaveBeenCalled()
    })

    it('should remove all members when deleted', () => {
      manager.create({ scopeId: 'scope-1' })
      manager.join('scope-1', 'agent-1')
      manager.join('scope-1', 'agent-2')

      manager.delete('scope-1')

      // Scope should no longer exist
      expect(manager.has('scope-1')).toBe(false)
    })
  })

  describe('Membership', () => {
    beforeEach(() => {
      manager.create({ scopeId: 'scope-1' })
    })

    it('should join a scope', () => {
      manager.join('scope-1', 'agent-1')

      const members = manager.getMembers('scope-1')
      expect(members).toContain('agent-1')
    })

    it('should not duplicate members', () => {
      manager.join('scope-1', 'agent-1')
      manager.join('scope-1', 'agent-1')

      const members = manager.getMembers('scope-1')
      expect(members.filter((m) => m === 'agent-1')).toHaveLength(1)
    })

    it('should leave a scope', () => {
      manager.join('scope-1', 'agent-1')
      manager.leave('scope-1', 'agent-1')

      const members = manager.getMembers('scope-1')
      expect(members).not.toContain('agent-1')
    })

    it('should emit scope:member:joined event', () => {
      const handler = vi.fn()
      manager.on('scope:member:joined', handler)

      manager.join('scope-1', 'agent-1')

      expect(handler).toHaveBeenCalledWith('scope-1', 'agent-1')
    })

    it('should emit scope:member:left event', () => {
      const handler = vi.fn()
      manager.on('scope:member:left', handler)

      manager.join('scope-1', 'agent-1')
      manager.leave('scope-1', 'agent-1')

      expect(handler).toHaveBeenCalledWith('scope-1', 'agent-1')
    })

    it('should check if agent is member', () => {
      manager.join('scope-1', 'agent-1')

      expect(manager.isMember('scope-1', 'agent-1')).toBe(true)
      expect(manager.isMember('scope-1', 'agent-2')).toBe(false)
    })

    it('should get all scopes for an agent', () => {
      manager.create({ scopeId: 'scope-2' })
      manager.join('scope-1', 'agent-1')
      manager.join('scope-2', 'agent-1')

      const scopes = manager.getAgentScopes('agent-1')
      expect(scopes.sort()).toEqual(['scope-1', 'scope-2'])
    })

    it('should remove agent from all scopes', () => {
      manager.create({ scopeId: 'scope-2' })
      manager.join('scope-1', 'agent-1')
      manager.join('scope-2', 'agent-1')

      manager.removeAgentFromAllScopes('agent-1')

      expect(manager.getAgentScopes('agent-1')).toHaveLength(0)
      expect(manager.isMember('scope-1', 'agent-1')).toBe(false)
      expect(manager.isMember('scope-2', 'agent-1')).toBe(false)
    })
  })

  describe('Auto-delete', () => {
    it('should auto-delete scope when last member leaves', () => {
      manager.create({ scopeId: 'auto-scope', autoDelete: true })
      manager.join('auto-scope', 'agent-1')
      manager.leave('auto-scope', 'agent-1')

      expect(manager.has('auto-scope')).toBe(false)
    })

    it('should not auto-delete if autoDelete is false', () => {
      manager.create({ scopeId: 'persistent-scope', autoDelete: false })
      manager.join('persistent-scope', 'agent-1')
      manager.leave('persistent-scope', 'agent-1')

      expect(manager.has('persistent-scope')).toBe(true)
    })
  })

  describe('Hierarchy', () => {
    it('should create child scopes', () => {
      manager.create({ scopeId: 'parent' })
      manager.create({ scopeId: 'child', parent: 'parent' })

      const child = manager.get('child')
      expect(child?.parent).toBe('parent')
    })

    it('should list child scopes', () => {
      manager.create({ scopeId: 'parent' })
      manager.create({ scopeId: 'child1', parent: 'parent' })
      manager.create({ scopeId: 'child2', parent: 'parent' })

      const children = manager.getChildren('parent')
      expect(children.map((s) => s.id).sort()).toEqual(['child1', 'child2'])
    })
  })

  describe('Query', () => {
    beforeEach(() => {
      manager.create({ scopeId: 'public-scope', visibility: 'public' })
      manager.create({ scopeId: 'members-scope', visibility: 'members' })
      manager.create({ scopeId: 'child-scope', parent: 'public-scope' })
    })

    it('should list all scopes', () => {
      const scopes = manager.list()
      expect(scopes).toHaveLength(3)
    })

    it('should filter by parent', () => {
      const children = manager.list({ parent: 'public-scope' })
      expect(children).toHaveLength(1)
      expect(children[0].id).toBe('child-scope')
    })

    it('should filter by visibility', () => {
      const publicScopes = manager.list({ visibility: 'public' })
      expect(publicScopes).toHaveLength(2) // public-scope and child-scope
    })
  })

  describe('Clear', () => {
    it('should clear all scopes', () => {
      manager.create({ scopeId: 'scope-1' })
      manager.create({ scopeId: 'scope-2' })

      manager.clear()

      expect(manager.size).toBe(0)
      expect(manager.list()).toHaveLength(0)
    })
  })
})
