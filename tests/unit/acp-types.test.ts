// ACP types unit tests
// Implements: s-4hjr, i-4rwk

import { describe, it, expect } from 'vitest'
import {
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  isSessionObserveRequest,
  isSessionUnobserveRequest,
  isSessionListRequest,
  isSessionEndedNotification,
} from '../../src/acp/types'
import type {
  AcpRequest,
  AcpResponse,
  AcpNotification,
  SessionObserveRequest,
  SessionUnobserveRequest,
  SessionListRequest,
  SessionEndedNotification,
  SessionInfo,
} from '../../src/acp/types'

describe('ACP Types', () => {
  describe('core type guards', () => {
    it('should identify ACP request', () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
        params: {},
      }
      expect(isAcpRequest(request)).toBe(true)
      expect(isAcpResponse(request)).toBe(false)
      expect(isAcpNotification(request)).toBe(false)
    })

    it('should identify ACP response', () => {
      const response: AcpResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: { success: true },
      }
      expect(isAcpRequest(response)).toBe(false)
      expect(isAcpResponse(response)).toBe(true)
      expect(isAcpNotification(response)).toBe(false)
    })

    it('should identify ACP notification', () => {
      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'test/notify',
        params: {},
      }
      expect(isAcpRequest(notification)).toBe(false)
      expect(isAcpResponse(notification)).toBe(false)
      expect(isAcpNotification(notification)).toBe(true)
    })
  })

  describe('session observation type guards', () => {
    it('should identify session/observe request', () => {
      const request: SessionObserveRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/observe',
        params: { sessionId: 'session-1' },
      }
      expect(isSessionObserveRequest(request)).toBe(true)
      expect(isSessionUnobserveRequest(request)).toBe(false)
      expect(isSessionListRequest(request)).toBe(false)
    })

    it('should identify session/unobserve request', () => {
      const request: SessionUnobserveRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/unobserve',
        params: { sessionId: 'session-1' },
      }
      expect(isSessionObserveRequest(request)).toBe(false)
      expect(isSessionUnobserveRequest(request)).toBe(true)
      expect(isSessionListRequest(request)).toBe(false)
    })

    it('should identify session/list request', () => {
      const request: SessionListRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/list',
        params: {},
      }
      expect(isSessionObserveRequest(request)).toBe(false)
      expect(isSessionUnobserveRequest(request)).toBe(false)
      expect(isSessionListRequest(request)).toBe(true)
    })

    it('should identify session/list request with includeInactive', () => {
      const request: SessionListRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'session/list',
        params: { includeInactive: true },
      }
      expect(isSessionListRequest(request)).toBe(true)
    })

    it('should identify session/ended notification', () => {
      const notification: SessionEndedNotification = {
        jsonrpc: '2.0',
        method: 'session/ended',
        params: { sessionId: 'session-1', reason: 'completed' },
      }
      expect(isSessionEndedNotification(notification)).toBe(true)
      expect(isSessionObserveRequest(notification)).toBe(false)
    })

    it('should not identify other requests as session observation', () => {
      const request: AcpRequest = {
        jsonrpc: '2.0',
        id: 5,
        method: 'terminal/create',
        params: { command: 'echo hello' },
      }
      expect(isSessionObserveRequest(request)).toBe(false)
      expect(isSessionUnobserveRequest(request)).toBe(false)
      expect(isSessionListRequest(request)).toBe(false)
    })

    it('should not identify other notifications as session/ended', () => {
      const notification: AcpNotification = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'session-1', data: 'test' },
      }
      expect(isSessionEndedNotification(notification)).toBe(false)
    })
  })

  describe('SessionInfo type', () => {
    it('should have required metadata fields', () => {
      const session: SessionInfo = {
        sessionId: 'session-1',
        mode: 'default',
        createdAt: '2026-01-12T00:00:00Z',
        active: true,
      }
      expect(session.sessionId).toBe('session-1')
      expect(session.mode).toBe('default')
      expect(session.createdAt).toBe('2026-01-12T00:00:00Z')
      expect(session.active).toBe(true)
      expect(session.activity).toBeUndefined()
    })

    it('should support optional activity field', () => {
      const session: SessionInfo = {
        sessionId: 'session-2',
        mode: 'agent',
        createdAt: '2026-01-12T01:00:00Z',
        active: true,
        activity: 'processing prompt',
      }
      expect(session.activity).toBe('processing prompt')
    })

    it('should support inactive sessions', () => {
      const session: SessionInfo = {
        sessionId: 'session-3',
        mode: 'default',
        createdAt: '2026-01-12T00:00:00Z',
        active: false,
      }
      expect(session.active).toBe(false)
    })
  })
})
