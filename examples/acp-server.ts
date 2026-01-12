// ExampleAcpServer - Minimal ACP server implementing the official SDK Agent interface
// This is NOT production-ready - it's for testing and demonstrating integration patterns
// Implements: s-4hjr, i-3s2q

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type CancelNotification,
  type Stream,
  type ContentBlock,
} from '@agentclientprotocol/sdk'

// =============================================================================
// Types
// =============================================================================

interface Session {
  id: string
  cwd: string
  createdAt: Date
  mode: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  pendingPrompt: AbortController | null
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

// =============================================================================
// ExampleAcpAgent - Implements the SDK Agent interface
// =============================================================================

/**
 * Example ACP Agent that implements the official SDK Agent interface.
 *
 * This agent demonstrates how to:
 * - Handle initialization and session creation
 * - Process prompts and send session updates
 * - Execute terminal commands
 * - Read/write files
 *
 * @example
 * ```typescript
 * import { AgentSideConnection } from '@agentclientprotocol/sdk'
 * import { meshStream } from 'agentic-mesh'
 *
 * const stream = meshStream(mesh, { peerId: 'client-peer' })
 * const connection = new AgentSideConnection(
 *   (conn) => new ExampleAcpAgent(conn),
 *   stream
 * )
 * ```
 */
export class ExampleAcpAgent implements Agent {
  private connection: AgentSideConnection
  private sessions: Map<string, Session> = new Map()
  private terminals: Map<string, Terminal> = new Map()
  private terminalIdCounter = 0
  private sessionCounter = 0

  constructor(connection: AgentSideConnection) {
    this.connection = connection
  }

  // ===========================================================================
  // Agent Interface Methods
  // ===========================================================================

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: 'ExampleAcpAgent',
        version: '0.1.0',
      },
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `session-${++this.sessionCounter}-${Date.now()}`
    const session: Session = {
      id: sessionId,
      cwd: params.cwd,
      createdAt: new Date(),
      mode: 'default',
      history: [],
      pendingPrompt: null,
    }
    this.sessions.set(sessionId, session)

    return {
      sessionId,
      availableModes: [
        { name: 'default', description: 'Default mode' },
        { name: 'agent', description: 'Autonomous agent mode' },
      ],
      currentMode: 'default',
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    // No authentication required for this example
    return {}
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)
    if (session) {
      // SDK sends modeId, not mode
      session.mode = params.modeId
    }
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`)
    }

    // Cancel any pending prompt
    session.pendingPrompt?.abort()
    session.pendingPrompt = new AbortController()

    try {
      // Extract text content from prompt
      const textContent = params.prompt
        .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
          block.type === 'text'
        )
        .map((block) => block.text)
        .join('\n')

      session.history.push({ role: 'user', content: textContent })

      // Send initial acknowledgment
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Processing: "${textContent.slice(0, 50)}${textContent.length > 50 ? '...' : ''}"`,
          },
        },
      })

      // Simulate some processing
      await this.delay(100, session.pendingPrompt.signal)

      // Generate response
      const response = `Echo: ${textContent}`
      session.history.push({ role: 'assistant', content: response })

      // Send response content
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: response,
          },
        },
      })

      session.pendingPrompt = null
      return { stopReason: 'end_turn' }
    } catch (error) {
      if (session.pendingPrompt?.signal.aborted) {
        return { stopReason: 'cancelled' }
      }
      throw error
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    if (session?.pendingPrompt) {
      session.pendingPrompt.abort()
      session.pendingPrompt = null
    }
  }

  // ===========================================================================
  // Terminal Operations (via Client interface on connection)
  // ===========================================================================

  /**
   * Create a terminal and execute a command.
   * This is called when the agent wants to run a command.
   */
  async createTerminal(sessionId: string, command: string, cwd?: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    const terminalId = `term-${++this.terminalIdCounter}`

    const terminal: Terminal = {
      id: terminalId,
      sessionId,
      command,
      process: null,
      output: '',
      exitCode: null,
      exited: false,
    }

    // Parse command
    const parts = command.split(' ')
    const executable = parts[0]
    const args = parts.slice(1)

    // Spawn process
    const proc = spawn(executable, args, {
      cwd: cwd || session?.cwd || process.cwd(),
      shell: true,
    })

    terminal.process = proc

    proc.stdout?.on('data', (data) => {
      terminal.output += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      terminal.output += data.toString()
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
    return terminalId
  }

  async getTerminalOutput(terminalId: string): Promise<{ output: string; exited: boolean; exitCode: number | null }> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }
    return {
      output: terminal.output,
      exited: terminal.exited,
      exitCode: terminal.exitCode,
    }
  }

  async waitForTerminalExit(terminalId: string, timeout = 30000): Promise<number> {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }

    if (terminal.exited) {
      return terminal.exitCode ?? 0
    }

    const startTime = Date.now()
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (terminal.exited) {
          clearInterval(check)
          resolve(terminal.exitCode ?? 0)
        } else if (Date.now() - startTime > timeout) {
          clearInterval(check)
          reject(new Error('Timeout waiting for terminal exit'))
        }
      }, 100)
    })
  }

  async killTerminal(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId)
    if (terminal?.process) {
      terminal.process.kill('SIGTERM')
    }
  }

  async releaseTerminal(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId)
    if (terminal) {
      if (terminal.process) {
        terminal.process.kill('SIGKILL')
      }
      this.terminals.delete(terminalId)
    }
  }

  // ===========================================================================
  // File System Operations
  // ===========================================================================

  async readTextFile(filePath: string): Promise<string> {
    const resolvedPath = path.resolve(filePath)
    return fs.readFile(resolvedPath, 'utf-8')
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    const resolvedPath = path.resolve(filePath)
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
    await fs.writeFile(resolvedPath, content, 'utf-8')
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values())
  }

  getTerminal(terminalId: string): Terminal | undefined {
    return this.terminals.get(terminalId)
  }

  async cleanup(): Promise<void> {
    for (const terminal of Array.from(this.terminals.values())) {
      if (terminal.process) {
        terminal.process.kill('SIGKILL')
      }
    }
    this.terminals.clear()
    this.sessions.clear()
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout)
        reject(new Error('Aborted'))
      })
    })
  }
}

// =============================================================================
// Legacy ExampleAcpServer (for backward compatibility with existing tests)
// =============================================================================

import type {
  AcpRequest,
  AcpResponse,
  AcpNotification,
  AcpMessage,
  AcpError,
} from '../src/acp/types'
import { isAcpRequest } from '../src/acp/types'

interface LegacySession {
  id: string
  createdAt: Date
  mode: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

interface LegacyTerminal {
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

/**
 * Legacy ACP server for backward compatibility with existing tests.
 * Use ExampleAcpAgent with AgentSideConnection for new code.
 */
export class ExampleAcpServer extends EventEmitter {
  private sessions: Map<string, LegacySession> = new Map()
  private terminals: Map<string, LegacyTerminal> = new Map()
  private terminalIdCounter = 0

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

  async handleMessage(message: AcpMessage): Promise<AcpResponse | undefined> {
    if (isAcpRequest(message)) {
      return this.handleRequest(message)
    }
    return undefined
  }

  private async dispatch(request: AcpRequest): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request.params)
      case 'session/new':
        return this.handleSessionNew(request.params)
      case 'session/prompt':
        return this.handleSessionPrompt(request.params)
      case 'session/cancel':
        return this.handleSessionCancel(request.params)
      case 'session/list':
        return this.handleSessionList(request.params)
      case 'session/observe':
        return this.handleSessionObserve(request.params)
      case 'session/unobserve':
        return this.handleSessionUnobserve(request.params)
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
      case 'fs/read_text_file':
        return this.handleFsReadTextFile(request.params)
      case 'fs/write_text_file':
        return this.handleFsWriteTextFile(request.params)
      default:
        throw new Error(`Unknown method: ${request.method}`)
    }
  }

  private async handleInitialize(_params: unknown): Promise<unknown> {
    return {
      protocolVersion: PROTOCOL_VERSION,
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

  private async handleSessionNew(_params: unknown): Promise<unknown> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const session: LegacySession = {
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

    session.history.push({ role: 'user', content })

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

    await new Promise((r) => setTimeout(r, 100))

    const response = `Received: "${content}"`
    session.history.push({ role: 'assistant', content: response })

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

  private async handleSessionCancel(_params: unknown): Promise<unknown> {
    return { success: true }
  }

  private async handleSessionList(_params: unknown): Promise<unknown> {
    const sessions = Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.id,
      createdAt: session.createdAt.toISOString(),
      mode: session.mode,
    }))
    return { sessions }
  }

  private async handleSessionObserve(params: unknown): Promise<unknown> {
    const { sessionId } = params as { sessionId: string }
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return { success: true }
  }

  private async handleSessionUnobserve(_params: unknown): Promise<unknown> {
    return { success: true }
  }

  private async handleTerminalCreate(params: unknown): Promise<unknown> {
    const { command, cwd, env, sessionId } = params as {
      command: string
      cwd?: string
      env?: Record<string, string>
      sessionId?: string
    }

    const terminalId = `term-${++this.terminalIdCounter}`
    const terminal: LegacyTerminal = {
      id: terminalId,
      sessionId: sessionId || '',
      command,
      process: null,
      output: '',
      exitCode: null,
      exited: false,
    }

    const parts = command.split(' ')
    const executable = parts[0]
    const args = parts.slice(1)

    const proc = spawn(executable, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      shell: true,
    })

    terminal.process = proc

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
    return { output: terminal.output, truncated: false }
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

    if (terminal.process) {
      terminal.process.kill('SIGKILL')
    }
    this.terminals.delete(terminalId)
    return { success: true }
  }

  private async handleFsReadTextFile(params: unknown): Promise<unknown> {
    const { path: filePath } = params as { path: string }
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
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
      await fs.writeFile(resolvedPath, content, 'utf-8')
      return { success: true }
    } catch (error) {
      throw new Error(`Failed to write file: ${error instanceof Error ? error.message : error}`)
    }
  }

  private emitSessionUpdate(sessionId: string, update: Omit<SessionUpdate, 'sessionId'>): void {
    if (!sessionId) return

    const fullUpdate: SessionUpdate = { sessionId, ...update }
    const notification: AcpNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: fullUpdate,
    }

    this.emit('session:update', notification)
  }

  getSession(sessionId: string): LegacySession | undefined {
    return this.sessions.get(sessionId)
  }

  getAllSessions(): LegacySession[] {
    return Array.from(this.sessions.values())
  }

  getTerminal(terminalId: string): LegacyTerminal | undefined {
    return this.terminals.get(terminalId)
  }

  async cleanup(): Promise<void> {
    for (const terminal of Array.from(this.terminals.values())) {
      if (terminal.process) {
        terminal.process.kill('SIGKILL')
      }
    }
    this.terminals.clear()
    this.sessions.clear()
  }
}
