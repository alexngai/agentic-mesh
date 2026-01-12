// ExampleAcpServer - Minimal ACP server for testing AcpMeshAdapter
// This is NOT production-ready - it's for testing and demonstrating integration patterns
// Implements: s-4hjr, i-3s2q

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpMessage,
  AcpError,
} from '../src/acp/types'
import { isAcpRequest } from '../src/acp/types'

// =============================================================================
// Types
// =============================================================================

interface Session {
  id: string
  createdAt: Date
  mode: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

interface Terminal {
  id: string
  sessionId: string
  command: string
  process: ChildProcess | null
  output: string
  exitCode: number | null
  exited: boolean
}

interface SessionUpdate {
  sessionId: string
  type: 'tool_call' | 'content' | 'status'
  data: unknown
}

interface ToolCall {
  toolCallId: string
  title: string
  kind: 'read' | 'edit' | 'execute' | 'other'
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  content?: string
}

// =============================================================================
// ExampleAcpServer
// =============================================================================

/**
 * Minimal ACP server implementation for testing.
 *
 * This server implements core ACP methods to demonstrate how to integrate
 * with AcpMeshAdapter. It is NOT production-ready.
 *
 * @example
 * ```typescript
 * const server = new ExampleAcpServer()
 *
 * // Handle incoming ACP requests
 * const response = await server.handleRequest(request)
 *
 * // Listen for session updates to broadcast
 * server.on('session:update', (update) => {
 *   adapter.broadcast(update)
 * })
 * ```
 */
export class ExampleAcpServer extends EventEmitter {
  private sessions: Map<string, Session> = new Map()
  private terminals: Map<string, Terminal> = new Map()
  private terminalIdCounter = 0

  // ===========================================================================
  // Main Request Handler
  // ===========================================================================

  /**
   * Handle an incoming ACP request and return a response.
   */
  async handleRequest(request: AcpRequest): Promise<AcpResponse> {
    try {
      const result = await this.dispatch(request)
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      }
    } catch (error) {
      const acpError: AcpError = {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: acpError,
      }
    }
  }

  /**
   * Handle an incoming ACP message (request or notification).
   * For requests, returns a response. For notifications, returns undefined.
   */
  async handleMessage(message: AcpMessage): Promise<AcpResponse | undefined> {
    if (isAcpRequest(message)) {
      return this.handleRequest(message)
    }
    // Notifications don't get responses
    return undefined
  }

  // ===========================================================================
  // Method Dispatch
  // ===========================================================================

  private async dispatch(request: AcpRequest): Promise<unknown> {
    switch (request.method) {
      // Lifecycle
      case 'initialize':
        return this.handleInitialize(request.params)

      // Session management
      case 'session/new':
        return this.handleSessionNew(request.params)
      case 'session/prompt':
        return this.handleSessionPrompt(request.params)
      case 'session/cancel':
        return this.handleSessionCancel(request.params)

      // Terminal operations
      case 'terminal/create':
        return this.handleTerminalCreate(request.params)
      case 'terminal/output':
        return this.handleTerminalOutput(request.params)
      case 'terminal/wait_for_exit':
        return this.handleTerminalWaitForExit(request.params)
      case 'terminal/kill':
        return this.handleTerminalKill(request.params)
      case 'terminal/release':
        return this.handleTerminalRelease(request.params)

      // File system operations
      case 'fs/read_text_file':
        return this.handleFsReadTextFile(request.params)
      case 'fs/write_text_file':
        return this.handleFsWriteTextFile(request.params)

      default:
        throw new Error(`Unknown method: ${request.method}`)
    }
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  private async handleInitialize(params: unknown): Promise<unknown> {
    // Return server capabilities
    return {
      protocolVersion: '0.1.0',
      serverInfo: {
        name: 'ExampleAcpServer',
        version: '0.1.0',
      },
      capabilities: {
        sessionLoad: false,
        terminal: true,
        fileSystem: {
          read: true,
          write: true,
        },
      },
    }
  }

  // ===========================================================================
  // Session Methods
  // ===========================================================================

  private async handleSessionNew(params: unknown): Promise<unknown> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const session: Session = {
      id: sessionId,
      createdAt: new Date(),
      mode: 'default',
      history: [],
    }
    this.sessions.set(sessionId, session)

    return {
      sessionId,
      modes: [
        { name: 'default', description: 'Default mode' },
        { name: 'agent', description: 'Autonomous agent mode' },
      ],
      currentMode: 'default',
    }
  }

  private async handleSessionPrompt(params: unknown): Promise<unknown> {
    const { sessionId, content } = params as { sessionId: string; content: string }
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Add user message to history
    session.history.push({ role: 'user', content })

    // Emit session update (tool call in progress)
    const toolCallId = `tc-${Date.now()}`
    this.emitSessionUpdate(sessionId, {
      type: 'tool_call',
      data: {
        toolCallId,
        title: 'Processing prompt',
        kind: 'other',
        status: 'in_progress',
      } as ToolCall,
    })

    // Simulate processing
    await new Promise((r) => setTimeout(r, 100))

    // Generate simple response
    const response = `Received: "${content}"`
    session.history.push({ role: 'assistant', content: response })

    // Emit completion
    this.emitSessionUpdate(sessionId, {
      type: 'tool_call',
      data: {
        toolCallId,
        title: 'Processing prompt',
        kind: 'other',
        status: 'completed',
        content: response,
      } as ToolCall,
    })

    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: response }],
    }
  }

  private async handleSessionCancel(params: unknown): Promise<unknown> {
    // In a real implementation, this would cancel ongoing operations
    return { success: true }
  }

  // ===========================================================================
  // Terminal Methods
  // ===========================================================================

  private async handleTerminalCreate(params: unknown): Promise<unknown> {
    const { command, cwd, env, sessionId } = params as {
      command: string
      cwd?: string
      env?: Record<string, string>
      sessionId?: string
    }

    const terminalId = `term-${++this.terminalIdCounter}`
    const terminal: Terminal = {
      id: terminalId,
      sessionId: sessionId || '',
      command,
      process: null,
      output: '',
      exitCode: null,
      exited: false,
    }

    // Parse command into executable and args
    const parts = command.split(' ')
    const executable = parts[0]
    const args = parts.slice(1)

    // Spawn the process
    const proc = spawn(executable, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      shell: true,
    })

    terminal.process = proc

    // Capture output
    proc.stdout?.on('data', (data) => {
      terminal.output += data.toString()
      this.emitSessionUpdate(terminal.sessionId, {
        type: 'content',
        data: { terminalId, stdout: data.toString() },
      })
    })

    proc.stderr?.on('data', (data) => {
      terminal.output += data.toString()
      this.emitSessionUpdate(terminal.sessionId, {
        type: 'content',
        data: { terminalId, stderr: data.toString() },
      })
    })

    proc.on('exit', (code, signal) => {
      terminal.exitCode = code ?? (signal ? 1 : 0)
      terminal.exited = true
      terminal.process = null
    })

    proc.on('error', (error) => {
      terminal.output += `Error: ${error.message}\n`
      terminal.exitCode = 1
      terminal.exited = true
      terminal.process = null
    })

    this.terminals.set(terminalId, terminal)

    return { terminalId }
  }

  private async handleTerminalOutput(params: unknown): Promise<unknown> {
    const { terminalId } = params as { terminalId: string }
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }

    return {
      output: terminal.output,
      truncated: false,
    }
  }

  private async handleTerminalWaitForExit(params: unknown): Promise<unknown> {
    const { terminalId, timeout } = params as { terminalId: string; timeout?: number }
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }

    if (terminal.exited) {
      return { exitCode: terminal.exitCode }
    }

    // Wait for exit
    const timeoutMs = timeout || 30000
    const startTime = Date.now()

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (terminal.exited) {
          clearInterval(checkInterval)
          resolve({ exitCode: terminal.exitCode })
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval)
          reject(new Error('Timeout waiting for terminal exit'))
        }
      }, 100)
    })
  }

  private async handleTerminalKill(params: unknown): Promise<unknown> {
    const { terminalId, signal } = params as { terminalId: string; signal?: string }
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }

    if (terminal.process) {
      terminal.process.kill(signal as NodeJS.Signals || 'SIGTERM')
    }

    return { success: true }
  }

  private async handleTerminalRelease(params: unknown): Promise<unknown> {
    const { terminalId } = params as { terminalId: string }
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }

    // Kill if still running
    if (terminal.process) {
      terminal.process.kill('SIGKILL')
    }

    this.terminals.delete(terminalId)
    return { success: true }
  }

  // ===========================================================================
  // File System Methods
  // ===========================================================================

  private async handleFsReadTextFile(params: unknown): Promise<unknown> {
    const { path: filePath } = params as { path: string }

    // Resolve path (basic security: don't allow absolute paths outside cwd in production)
    const resolvedPath = path.resolve(filePath)

    try {
      const content = await fs.readFile(resolvedPath, 'utf-8')
      return { content }
    } catch (error) {
      throw new Error(`Failed to read file: ${error instanceof Error ? error.message : error}`)
    }
  }

  private async handleFsWriteTextFile(params: unknown): Promise<unknown> {
    const { path: filePath, content } = params as { path: string; content: string }

    const resolvedPath = path.resolve(filePath)

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
      await fs.writeFile(resolvedPath, content, 'utf-8')
      return { success: true }
    } catch (error) {
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : error}`)
    }
  }

  // ===========================================================================
  // Session Updates
  // ===========================================================================

  private emitSessionUpdate(sessionId: string, update: Omit<SessionUpdate, 'sessionId'>): void {
    if (!sessionId) return

    const fullUpdate: SessionUpdate = {
      sessionId,
      ...update,
    }

    // Emit as ACP notification format
    const notification: AcpNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: fullUpdate,
    }

    this.emit('session:update', notification)
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Get all sessions.
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
  }

  /**
   * Get a terminal by ID.
   */
  getTerminal(terminalId: string): Terminal | undefined {
    return this.terminals.get(terminalId)
  }

  /**
   * Clean up all resources.
   */
  async cleanup(): Promise<void> {
    // Kill all running terminals
    for (const terminal of Array.from(this.terminals.values())) {
      if (terminal.process) {
        terminal.process.kill('SIGKILL')
      }
    }
    this.terminals.clear()
    this.sessions.clear()
  }
}
