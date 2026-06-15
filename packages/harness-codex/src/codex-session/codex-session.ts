import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type {
  AttachmentRef,
  PermissionHandler,
  PermissionRequest,
  PromptOptions,
  SessionMetadataSnapshot,
  UnifiedSession,
  UnifiedSessionEvent,
  UnifiedSessionState,
} from 'spaces-runtime'
import { toError } from '../errors.js'
import {
  CLIENT_INFO,
  type CodexThreadItem,
  type ErrorNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type ThreadResumeResponse,
  type ThreadStartResponse,
  type TurnStartResponse,
  type TurnStartedNotification,
  classifyNotification,
  formatCodexErrorBody,
  localImageInput,
  mapItemCompleted,
  mapItemStarted,
  textInput,
} from './event-mapping.js'
import {
  CodexRpcClient,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './rpc-client.js'
import { type CodexSessionConfig, type CodexTurnArtifacts, toCodexSandboxPolicy } from './types.js'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface TurnCompletedNotification {
  turn: { id: string }
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
      const args: string[] = []
      if (this.config.profile) {
        args.push('-c', `profile="${this.config.profile}"`)
      }
      for (const feature of this.config.featureFlags ?? []) {
        args.push('--enable', feature)
      }
      args.push('app-server')
      if (this.config.extraArgs) {
        args.push(...this.config.extraArgs)
      }
      const env = { ...process.env, CODEX_HOME: this.config.homeDir }
      const spawnProc = this.config.spawnProc ?? spawn
      this.proc = spawnProc(command, args, {
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

      this.emitEvent({
        type: 'agent_start',
        sessionId: this.sessionId,
        sdkSessionId: this.threadId,
      })
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
        sandboxPolicy: toCodexSandboxPolicy(this.config.sandboxMode),
        model: this.config.model ?? null,
        effort: this.config.modelReasoningEffort ?? null,
        summary: null,
        outputSchema: null,
      })) as TurnStartResponse

      const turnId = response.turn?.id
      if (turnId) {
        this.currentTurnId = turnId
      }

      await pending
    } catch (error) {
      this.handleError(toError(error))
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

  getMetadata(): SessionMetadataSnapshot {
    return {
      sessionId: this.sessionId,
      kind: this.kind,
      state: this.getState(),
      lastActivityAt: this.lastActivityAt,
      ...(this.threadId !== undefined ? { nativeIdentity: this.threadId } : {}),
      ...(this.threadId !== undefined ? { continuationKey: this.threadId } : {}),
      capabilities: {
        supportsInterrupt: false,
        supportsInFlightInput: false,
        supportsNativeResume: true,
        supportsAttach: false,
      },
    }
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
      this.handleError(toError(error))
    })
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const shared = classifyNotification(notification.method, notification.params)
    if (shared) {
      for (const event of shared) {
        this.emitEvent(event)
      }
      return
    }
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
    for (const event of mapItemStarted(item)) {
      this.emitEvent(event)
    }
  }

  private handleItemCompleted(params: ItemCompletedNotification): void {
    const item = params.item
    if (item.id) {
      this.items.set(item.id, item)
    }
    for (const event of mapItemCompleted(item).events) {
      this.emitEvent(event)
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === 'item/commandExecution/requestApproval') {
      const params = request.params as CommandExecutionRequestApprovalParams
      return this.approveItemRequest('command_execution', params)
    }
    if (request.method === 'item/fileChange/requestApproval') {
      const params = request.params as FileChangeRequestApprovalParams
      return this.approveItemRequest('file_change', params, params.grantRoot)
    }

    throw new Error(`Unhandled Codex request: ${request.method}`)
  }

  private async approveItemRequest(
    toolName: 'command_execution' | 'file_change',
    params: { itemId: string; reason: string | null },
    grantRoot?: string | null
  ): Promise<{ decision: 'acceptForSession' | 'decline' }> {
    const item = params.itemId ? this.items.get(params.itemId) : undefined
    const requestInput = {
      ...(item ? { item } : {}),
      ...(grantRoot ? { grantRoot } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    }
    const decision = await this.resolvePermission({
      toolName,
      toolUseId: params.itemId,
      input: requestInput,
      ...(params.reason ? { summary: params.reason } : {}),
    })
    return { decision }
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

function isImagePath(path: string): boolean {
  const trimmed = path.split('?')[0]?.split('#')[0] ?? path
  const ext = extname(trimmed).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

function isImageAttachment(attachment: AttachmentRef, ref: string): boolean {
  return attachment.contentType?.toLowerCase().startsWith('image/') === true || isImagePath(ref)
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
  return `${header}: ${formatCodexErrorBody(params)}`
}

async function buildUserInputs(
  text: string,
  attachments: AttachmentRef[] | undefined
): Promise<Array<Record<string, unknown>>> {
  const inputs: Array<Record<string, unknown>> = [textInput(text)]
  if (!attachments) return inputs

  for (const attachment of attachments) {
    if (attachment.kind === 'url' && attachment.url) {
      if (isImageAttachment(attachment, attachment.url)) {
        inputs.push({ type: 'image', url: attachment.url })
      } else {
        inputs.push(textInput(`Attached URL: ${attachment.url}`))
      }
      continue
    }

    if (attachment.kind === 'file' && attachment.path) {
      if (isImageAttachment(attachment, attachment.path)) {
        const stats = await stat(attachment.path)
        if (stats.size > MAX_IMAGE_BYTES) {
          throw new Error(`Attachment exceeds ${MAX_IMAGE_BYTES} bytes: ${attachment.path}`)
        }
        inputs.push(localImageInput(attachment.path))
      } else {
        inputs.push(textInput(`Attached file: ${attachment.path}`))
      }
    }
  }

  return inputs
}
