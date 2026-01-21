import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { PermissionHandler, PermissionRequest } from '../session/permissions.js'
import type {
  AttachmentRef,
  PromptOptions,
  ToolResult,
  UnifiedSession,
  UnifiedSessionEvent,
  UnifiedSessionState,
} from '../session/types.js'
import {
  CodexRpcClient,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './rpc-client.js'
import type { CodexSessionConfig, CodexTurnArtifacts } from './types.js'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const CLIENT_INFO = {
  name: 'agent-spaces',
  version: process.env['npm_package_version'] ?? 'unknown',
}

type CodexThreadItem =
  | {
      type: 'agentMessage'
      id: string
      text: string
    }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
      status?: string | undefined
    }
  | {
      type: 'fileChange'
      id: string
      changes: Array<unknown>
      status?: string | undefined
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      arguments: unknown
      result: unknown | null
      error: unknown | null
      durationMs: number | null
      status?: string | undefined
    }
  | {
      type: 'webSearch'
      id: string
      query: string
    }
  | {
      type: 'imageView'
      id: string
      path: string
    }
  | {
      type: string
      id?: string | undefined
    }

interface TurnStartResponse {
  turn?: { id?: string | undefined } | undefined
}

interface ThreadStartResponse {
  thread?: { id?: string | undefined } | undefined
}

interface ThreadResumeResponse {
  thread?: { id?: string | undefined } | undefined
}

interface TurnStartedNotification {
  turn: { id: string }
}

interface TurnCompletedNotification {
  turn: { id: string }
}

interface ItemStartedNotification {
  item: CodexThreadItem
  turnId: string
}

interface ItemCompletedNotification {
  item: CodexThreadItem
  turnId: string
}

interface AgentMessageDeltaNotification {
  itemId: string
  delta: string
}

interface CommandExecutionOutputDeltaNotification {
  itemId: string
  delta: string
}

interface FileChangeOutputDeltaNotification {
  itemId: string
  delta: string
}

interface McpToolCallProgressNotification {
  itemId: string
  message: string
}

interface TurnDiffUpdatedNotification {
  turnId: string
  diff: string
}

interface TurnPlanUpdatedNotification {
  turnId: string
  explanation: string | null
  plan: Array<{ id?: string | undefined; text?: string | undefined; status?: string | undefined }>
}

interface ErrorNotification {
  error: { message: string; codexErrorInfo: unknown | null; additionalDetails: string | null }
  willRetry: boolean
  threadId: string
  turnId: string
}

interface CommandExecutionRequestApprovalParams {
  itemId: string
  reason: string | null
}

interface FileChangeRequestApprovalParams {
  itemId: string
  reason: string | null
  grantRoot: string | null
}

export class CodexSession implements UnifiedSession {
  readonly kind = 'codex' as const
  private state: UnifiedSessionState = 'idle'
  private lastActivityAt = Date.now()
  readonly sessionId: string
  private eventCallback?: ((event: UnifiedSessionEvent) => void) | undefined
  private permissionHandler?: PermissionHandler | undefined
  private proc?: ChildProcessWithoutNullStreams | undefined
  private rpc?: CodexRpcClient | undefined
  private threadId?: string | undefined
  private currentTurnId?: string | undefined
  private pendingTurn?: { resolve: () => void; reject: (error: Error) => void } | undefined
  private readonly items = new Map<string, CodexThreadItem>()
  private readonly turnArtifacts = new Map<string, CodexTurnArtifacts>()
  private eventsOutputPromise = Promise.resolve()

  constructor(private readonly config: CodexSessionConfig) {
    this.sessionId = config.sessionId ?? `codex-${config.ownerId}-${Date.now()}`
  }

  onEvent(callback: (event: UnifiedSessionEvent) => void): void {
    this.eventCallback = callback
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start session in state: ${this.state}`)
    }

    try {
      const command = this.config.appServerCommand ?? 'codex'
      const env = { ...process.env, CODEX_HOME: this.config.homeDir }
      this.proc = spawn(command, ['app-server'], {
        cwd: this.config.cwd,
        env,
        stdio: 'pipe',
      })

      this.rpc = new CodexRpcClient(this.proc, {
        onNotification: (notification) => {
          this.handleNotification(notification)
        },
        onRequest: async (request) => this.handleRequest(request),
        onMessage: (message) => {
          this.recordMessage(message)
        },
        onError: (error) => {
          this.handleError(error)
        },
      })

      await this.rpc.sendRequest('initialize', { clientInfo: CLIENT_INFO })
      await this.rpc.sendNotification('initialized', {})

      if (this.config.resumeThreadId) {
        const response = (await this.rpc.sendRequest('thread/resume', {
          threadId: this.config.resumeThreadId,
          history: null,
          path: null,
          model: this.config.model ?? null,
          modelProvider: null,
          cwd: this.config.cwd ?? null,
          approvalPolicy: this.config.approvalPolicy ?? null,
          sandbox: this.config.sandboxMode ?? null,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
        })) as ThreadResumeResponse
        this.threadId = response.thread?.id ?? this.config.resumeThreadId
      } else {
        const response = (await this.rpc.sendRequest('thread/start', {
          model: this.config.model ?? null,
          modelProvider: null,
          cwd: this.config.cwd ?? null,
          approvalPolicy: this.config.approvalPolicy ?? null,
          sandbox: this.config.sandboxMode ?? null,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
          experimentalRawEvents: false,
        })) as ThreadStartResponse
        this.threadId = response.thread?.id
      }

      if (!this.threadId) {
        throw new Error('Codex thread id missing after start')
      }

      this.emitEvent({ type: 'agent_start', sessionId: this.threadId })
      this.state = 'running'
    } catch (error) {
      this.state = 'error'
      throw error
    }
  }

  async sendPrompt(text: string, options?: PromptOptions): Promise<void> {
    if (this.state !== 'running' || !this.rpc || !this.threadId) {
      throw new Error(`Cannot send prompt in state: ${this.state}`)
    }

    this.lastActivityAt = Date.now()
    this.state = 'streaming'

    try {
      const input = await buildUserInputs(text, options?.attachments)
      const pending = new Promise<void>((resolve, reject) => {
        this.pendingTurn = { resolve, reject }
      })

      const response = (await this.rpc.sendRequest('turn/start', {
        threadId: this.threadId,
        input,
        cwd: this.config.cwd ?? null,
        approvalPolicy: this.config.approvalPolicy ?? null,
        sandboxPolicy: this.config.sandboxMode ?? null,
        model: this.config.model ?? null,
        effort: null,
        summary: null,
        outputSchema: null,
      })) as TurnStartResponse

      const turnId = response.turn?.id
      if (turnId) {
        this.currentTurnId = turnId
      }

      await pending
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      // Transition back to running if we're still streaming
      // (state may have changed to 'error' or 'stopped' via async handlers)
      if (this.state === 'streaming') {
        this.state = 'running'
      }
    }
  }

  async stop(reason?: string): Promise<void> {
    if (this.state === 'stopped') return

    try {
      this.rpc?.close()
      this.proc?.kill('SIGTERM')
    } finally {
      this.pendingTurn?.reject(new Error(reason ?? 'Codex session stopped'))
      this.pendingTurn = undefined
      this.state = 'stopped'
    }
  }

  isHealthy(): boolean {
    return this.state === 'running' || this.state === 'streaming'
  }

  getState(): UnifiedSessionState {
    return this.state
  }

  private emitEvent(event: UnifiedSessionEvent): void {
    this.lastActivityAt = Date.now()
    this.eventCallback?.(event)
  }

  private handleError(error: Error): void {
    if (this.state === 'error') return
    this.state = 'error'
    this.rpc?.close()
    this.proc?.kill('SIGTERM')
    if (this.pendingTurn) {
      this.pendingTurn.reject(error)
      this.pendingTurn = undefined
    }
  }

  private recordMessage(message: JsonRpcMessage): void {
    if (!this.config.eventsOutputPath) return
    this.eventsOutputPromise = this.eventsOutputPromise.then(() =>
      appendFile(this.config.eventsOutputPath as string, `${JSON.stringify(message)}\n`)
    )
    this.eventsOutputPromise.catch((error) => {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'error': {
        const params = notification.params as ErrorNotification
        const message = formatCodexError(params)
        this.handleError(new Error(message))
        return
      }
      case 'turn/started': {
        const params = notification.params as TurnStartedNotification
        const turnId = params.turn?.id
        if (turnId) {
          this.currentTurnId = turnId
        }
        this.emitEvent({ type: 'turn_start', ...(turnId ? { turnId } : {}) })
        return
      }
      case 'turn/completed': {
        const params = notification.params as TurnCompletedNotification
        const turnId = params.turn?.id
        if (turnId) {
          this.currentTurnId = turnId
        }
        const artifacts = turnId ? this.turnArtifacts.get(turnId) : undefined
        this.emitEvent({
          type: 'turn_end',
          ...(turnId ? { turnId } : {}),
          ...(artifacts ? { payload: artifacts } : {}),
        })
        if (turnId) {
          this.turnArtifacts.delete(turnId)
        }
        this.resolvePendingTurn(turnId)
        return
      }
      case 'turn/diff/updated': {
        const params = notification.params as TurnDiffUpdatedNotification
        if (params.turnId) {
          const entry = this.turnArtifacts.get(params.turnId) ?? {}
          entry.diff = params.diff
          this.turnArtifacts.set(params.turnId, entry)
        }
        return
      }
      case 'turn/plan/updated': {
        const params = notification.params as TurnPlanUpdatedNotification
        if (params.turnId) {
          const entry = this.turnArtifacts.get(params.turnId) ?? {}
          entry.plan = {
            explanation: params.explanation ?? null,
            plan: params.plan,
          }
          this.turnArtifacts.set(params.turnId, entry)
        }
        return
      }
      case 'item/started': {
        const params = notification.params as ItemStartedNotification
        this.handleItemStarted(params)
        return
      }
      case 'item/completed': {
        const params = notification.params as ItemCompletedNotification
        this.handleItemCompleted(params)
        return
      }
      case 'item/agentMessage/delta': {
        const params = notification.params as AgentMessageDeltaNotification
        this.emitEvent({
          type: 'message_update',
          messageId: params.itemId,
          textDelta: params.delta,
          payload: params,
        })
        return
      }
      case 'item/commandExecution/outputDelta': {
        const params = notification.params as CommandExecutionOutputDeltaNotification
        this.emitEvent({
          type: 'tool_execution_update',
          toolUseId: params.itemId,
          partialOutput: params.delta,
          payload: params,
        })
        return
      }
      case 'item/fileChange/outputDelta': {
        const params = notification.params as FileChangeOutputDeltaNotification
        this.emitEvent({
          type: 'tool_execution_update',
          toolUseId: params.itemId,
          partialOutput: params.delta,
          payload: params,
        })
        return
      }
      case 'item/mcpToolCall/progress': {
        const params = notification.params as McpToolCallProgressNotification
        this.emitEvent({
          type: 'tool_execution_update',
          toolUseId: params.itemId,
          message: params.message,
          payload: params,
        })
        return
      }
    }
  }

  private resolvePendingTurn(turnId?: string | undefined): void {
    if (!this.pendingTurn) return
    if (this.currentTurnId && turnId && this.currentTurnId !== turnId) return
    this.pendingTurn.resolve()
    this.pendingTurn = undefined
  }

  private handleItemStarted(params: ItemStartedNotification): void {
    const item = params.item
    if (item.id) {
      this.items.set(item.id, item)
    }

    switch (item.type) {
      case 'agentMessage': {
        // Type guard: we know this is the agentMessage variant
        const agentItem = item as Extract<CodexThreadItem, { type: 'agentMessage' }>
        this.emitEvent({
          type: 'message_start',
          messageId: agentItem.id,
          message: { role: 'assistant', content: agentItem.text ?? '' },
          payload: agentItem,
        })
        return
      }
      case 'commandExecution': {
        const cmdItem = item as Extract<CodexThreadItem, { type: 'commandExecution' }>
        this.emitEvent({
          type: 'tool_execution_start',
          toolUseId: cmdItem.id,
          toolName: 'command_execution',
          input: { command: cmdItem.command, cwd: cmdItem.cwd },
          payload: cmdItem,
        })
        return
      }
      case 'fileChange': {
        const fileItem = item as Extract<CodexThreadItem, { type: 'fileChange' }>
        this.emitEvent({
          type: 'tool_execution_start',
          toolUseId: fileItem.id,
          toolName: 'file_change',
          input: { changes: fileItem.changes },
          payload: fileItem,
        })
        return
      }
      case 'mcpToolCall': {
        const mcpItem = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>
        this.emitEvent({
          type: 'tool_execution_start',
          toolUseId: mcpItem.id,
          toolName: `mcp:${mcpItem.server}/${mcpItem.tool}`,
          input: { server: mcpItem.server, tool: mcpItem.tool, arguments: mcpItem.arguments },
          payload: mcpItem,
        })
        return
      }
      case 'webSearch': {
        const searchItem = item as Extract<CodexThreadItem, { type: 'webSearch' }>
        this.emitEvent({
          type: 'tool_execution_start',
          toolUseId: searchItem.id,
          toolName: 'web_search',
          input: { query: searchItem.query },
          payload: searchItem,
        })
        return
      }
      case 'imageView': {
        const imageItem = item as Extract<CodexThreadItem, { type: 'imageView' }>
        this.emitEvent({
          type: 'tool_execution_start',
          toolUseId: imageItem.id,
          toolName: 'image_view',
          input: { path: imageItem.path },
          payload: imageItem,
        })
        return
      }
    }
  }

  private handleItemCompleted(params: ItemCompletedNotification): void {
    const item = params.item
    if (item.id) {
      this.items.set(item.id, item)
    }

    switch (item.type) {
      case 'agentMessage': {
        const agentItem = item as Extract<CodexThreadItem, { type: 'agentMessage' }>
        this.emitEvent({
          type: 'message_end',
          messageId: agentItem.id,
          message: { role: 'assistant', content: agentItem.text ?? '' },
          payload: agentItem,
        })
        return
      }
      case 'commandExecution': {
        const cmdItem = item as Extract<CodexThreadItem, { type: 'commandExecution' }>
        const result = buildToolResult(cmdItem.aggregatedOutput ?? '', {
          exitCode: cmdItem.exitCode,
          durationMs: cmdItem.durationMs,
        })
        this.emitEvent({
          type: 'tool_execution_end',
          toolUseId: cmdItem.id,
          toolName: 'command_execution',
          result,
          ...(cmdItem.exitCode !== null && cmdItem.exitCode !== 0 ? { isError: true } : {}),
          ...(cmdItem.durationMs !== null ? { durationMs: cmdItem.durationMs } : {}),
          payload: cmdItem,
        })
        return
      }
      case 'fileChange': {
        const fileItem = item as Extract<CodexThreadItem, { type: 'fileChange' }>
        const result = buildToolResult(JSON.stringify(fileItem.changes ?? [], null, 2))
        this.emitEvent({
          type: 'tool_execution_end',
          toolUseId: fileItem.id,
          toolName: 'file_change',
          result,
          ...(fileItem.status && fileItem.status !== 'completed' ? { isError: true } : {}),
          payload: fileItem,
        })
        return
      }
      case 'mcpToolCall': {
        const mcpItem = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>
        const resultPayload = mcpItem.error ?? mcpItem.result ?? ''
        const result = buildToolResult(
          typeof resultPayload === 'string' ? resultPayload : JSON.stringify(resultPayload, null, 2)
        )
        this.emitEvent({
          type: 'tool_execution_end',
          toolUseId: mcpItem.id,
          toolName: `mcp:${mcpItem.server}/${mcpItem.tool}`,
          result,
          ...(mcpItem.error ? { isError: true } : {}),
          ...(mcpItem.durationMs !== null ? { durationMs: mcpItem.durationMs } : {}),
          payload: mcpItem,
        })
        return
      }
      case 'webSearch': {
        const searchItem = item as Extract<CodexThreadItem, { type: 'webSearch' }>
        const result = buildToolResult(`web_search: ${searchItem.query}`)
        this.emitEvent({
          type: 'tool_execution_end',
          toolUseId: searchItem.id,
          toolName: 'web_search',
          result,
          payload: searchItem,
        })
        return
      }
      case 'imageView': {
        const imageItem = item as Extract<CodexThreadItem, { type: 'imageView' }>
        const result = buildToolResult(`image_view: ${imageItem.path}`)
        this.emitEvent({
          type: 'tool_execution_end',
          toolUseId: imageItem.id,
          toolName: 'image_view',
          result,
          payload: imageItem,
        })
        return
      }
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params as CommandExecutionRequestApprovalParams
        const item = params.itemId ? this.items.get(params.itemId) : undefined
        const requestInput = {
          ...(item ? { item } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        }
        const decision = await this.resolvePermission({
          toolName: 'command_execution',
          toolUseId: params.itemId,
          input: requestInput,
          ...(params.reason ? { summary: params.reason } : {}),
        })
        return { decision }
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as FileChangeRequestApprovalParams
        const item = params.itemId ? this.items.get(params.itemId) : undefined
        const requestInput = {
          ...(item ? { item } : {}),
          ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        }
        const decision = await this.resolvePermission({
          toolName: 'file_change',
          toolUseId: params.itemId,
          input: requestInput,
          ...(params.reason ? { summary: params.reason } : {}),
        })
        return { decision }
      }
    }

    throw new Error(`Unhandled Codex request: ${request.method}`)
  }

  private async resolvePermission(
    request: PermissionRequest
  ): Promise<'acceptForSession' | 'decline'> {
    const handler = this.permissionHandler
    if (!handler) return 'acceptForSession'
    if (handler.isAutoAllowed(request.toolName)) {
      return 'acceptForSession'
    }
    const result = await handler.requestPermission(request)
    return result.allowed ? 'acceptForSession' : 'decline'
  }
}

function buildToolResult(content: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: content }],
    ...(details ? { details } : {}),
  }
}

function isImagePath(path: string): boolean {
  const trimmed = path.split('?')[0]?.split('#')[0] ?? path
  const ext = extname(trimmed).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

function formatCodexError(params: ErrorNotification): string {
  const headerParts: string[] = ['Codex error']
  if (params.turnId) {
    headerParts.push(`turn ${params.turnId}`)
  }
  if (params.threadId) {
    headerParts.push(`thread ${params.threadId}`)
  }
  if (params.willRetry) {
    headerParts.push('will retry')
  }
  const header = headerParts.join(' - ')
  const message = params.error?.message ?? 'Unknown error'
  const details = params.error?.additionalDetails ? ` (${params.error.additionalDetails})` : ''
  const info = params.error?.codexErrorInfo ? ` ${JSON.stringify(params.error.codexErrorInfo)}` : ''
  return `${header}: ${message}${details}${info}`
}

async function buildUserInputs(
  text: string,
  attachments: AttachmentRef[] | undefined
): Promise<Array<Record<string, unknown>>> {
  const inputs: Array<Record<string, unknown>> = [{ type: 'text', text, text_elements: [] }]
  if (!attachments) return inputs

  for (const attachment of attachments) {
    if (attachment.kind === 'url' && attachment.url) {
      if (isImagePath(attachment.url)) {
        inputs.push({ type: 'image', url: attachment.url })
      } else {
        inputs.push({ type: 'text', text: `Attached URL: ${attachment.url}`, text_elements: [] })
      }
      continue
    }

    if (attachment.kind === 'file' && attachment.path) {
      if (isImagePath(attachment.path)) {
        const stats = await stat(attachment.path)
        if (stats.size > MAX_IMAGE_BYTES) {
          throw new Error(`Attachment exceeds ${MAX_IMAGE_BYTES} bytes: ${attachment.path}`)
        }
        inputs.push({ type: 'localImage', path: attachment.path })
      } else {
        inputs.push({
          type: 'text',
          text: `Attached file: ${attachment.path}`,
          text_elements: [],
        })
      }
    }
  }

  return inputs
}
