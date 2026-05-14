import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ToolResult, UnifiedSessionEvent } from 'spaces-runtime'

import { CodexRpcClient, type JsonRpcNotification, type JsonRpcRequest } from './rpc-client.js'
import { type CodexApprovalPolicy, type CodexSandboxMode, toCodexSandboxPolicy } from './types.js'

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
      type: 'unknown'
      id?: string | undefined
    }

interface ThreadStartResponse {
  thread?: { id?: string | undefined } | undefined
}

interface ThreadResumeResponse {
  thread?: { id?: string | undefined } | undefined
}

interface TurnStartResponse {
  turn?: { id?: string | undefined } | undefined
}

interface TurnCompletedNotification {
  turn: {
    id: string
    status?: string | undefined
    items?: CodexThreadItem[] | undefined
  }
}

interface ItemStartedNotification {
  item: CodexThreadItem
  turnId: string
}

interface ItemCompletedNotification {
  item: CodexThreadItem
  turnId: string
}

interface ThreadTokenUsageUpdatedNotification {
  tokenUsage?: unknown
  token_usage?: unknown
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

interface ErrorNotification {
  error: {
    message?: string | undefined
    codexErrorInfo?: unknown
    additionalDetails?: string | null
  }
  willRetry?: boolean | undefined
  threadId?: string | undefined
  turnId?: string | undefined
}

export interface CodexAppServerOneShotOptions {
  proc: ChildProcessWithoutNullStreams
  cwd: string
  prompt: string
  resumeThreadId?: string | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  approvalPolicy?: CodexApprovalPolicy | undefined
  sandboxMode?: CodexSandboxMode | undefined
  imageAttachments?: string[] | undefined
  onContinuation?: (threadId: string) => void | Promise<void>
  onEvent?: (event: UnifiedSessionEvent | Record<string, unknown>) => void | Promise<void>
}

export interface CodexAppServerOneShotResult {
  threadId: string
  turnCompleted: boolean
  success: boolean
  finalOutput?: string | undefined
  usage?: unknown
  terminalState: 'completed' | 'failed' | 'interrupted'
}

export async function runCodexAppServerOneShot(
  options: CodexAppServerOneShotOptions
): Promise<CodexAppServerOneShotResult> {
  const items = new Map<string, CodexThreadItem>()
  let threadId: string | undefined
  let currentTurnId: string | undefined
  let finalOutput: string | undefined
  let latestUsage: unknown
  let turnCompleted: TurnCompletedNotification | undefined
  let terminalError: Error | undefined

  const emitEvent = async (event: UnifiedSessionEvent | Record<string, unknown>): Promise<void> => {
    await options.onEvent?.(event)
  }

  let resolveTurn: (() => void) | undefined
  let rejectTurn: ((error: Error) => void) | undefined
  const turnPromise = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })
  let notificationQueue = Promise.resolve()

  const rpc = new CodexRpcClient(options.proc, {
    onNotification: (notification) => {
      notificationQueue = notificationQueue
        .then(() => handleNotification(notification))
        .catch((error) => {
          rejectWith(error)
        })
    },
    onRequest: async (request) => handleRequest(request),
    onError: (error) => {
      rejectWith(error)
    },
  })

  function rejectWith(error: unknown): void {
    if (terminalError) return
    terminalError = error instanceof Error ? error : new Error(String(error))
    rejectTurn?.(terminalError)
  }

  async function handleNotification(notification: JsonRpcNotification): Promise<void> {
    switch (notification.method) {
      case 'error': {
        rejectWith(new Error(formatCodexError(notification.params as ErrorNotification)))
        return
      }
      case 'turn/started': {
        const params = notification.params as { turn?: { id?: string | undefined } | undefined }
        if (params.turn?.id) {
          currentTurnId = params.turn.id
        }
        await emitEvent({ type: 'turn_start', ...(currentTurnId ? { turnId: currentTurnId } : {}) })
        return
      }
      case 'thread/tokenUsage/updated': {
        const params = notification.params as ThreadTokenUsageUpdatedNotification
        latestUsage = params.tokenUsage ?? params.token_usage
        return
      }
      case 'item/started': {
        const params = notification.params as ItemStartedNotification
        await handleItemStarted(params, items, emitEvent)
        return
      }
      case 'item/completed': {
        const params = notification.params as ItemCompletedNotification
        const output = await handleItemCompleted(params, items, emitEvent)
        if (output !== undefined) {
          finalOutput = output
        }
        return
      }
      case 'item/agentMessage/delta': {
        const params = notification.params as AgentMessageDeltaNotification
        await emitEvent({
          type: 'message_update',
          messageId: params.itemId,
          textDelta: params.delta,
          payload: params,
        })
        return
      }
      case 'item/commandExecution/outputDelta': {
        const params = notification.params as CommandExecutionOutputDeltaNotification
        await emitEvent({
          type: 'tool_execution_update',
          toolUseId: params.itemId,
          partialOutput: params.delta,
          payload: params,
        })
        return
      }
      case 'item/fileChange/outputDelta': {
        const params = notification.params as FileChangeOutputDeltaNotification
        await emitEvent({
          type: 'tool_execution_update',
          toolUseId: params.itemId,
          partialOutput: params.delta,
          payload: params,
        })
        return
      }
      case 'item/mcpToolCall/progress': {
        const params = notification.params as McpToolCallProgressNotification
        await emitEvent({
          type: 'tool_execution_update',
          toolUseId: params.itemId,
          message: params.message,
          payload: params,
        })
        return
      }
      case 'turn/completed': {
        turnCompleted = notification.params as TurnCompletedNotification
        currentTurnId = turnCompleted.turn?.id ?? currentTurnId
        finalOutput = finalOutput ?? resolveFinalOutput(turnCompleted.turn?.items)
        await emitEvent({
          type: 'turn_end',
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          payload: turnCompleted.turn,
        })
        resolveTurn?.()
        return
      }
    }
  }

  try {
    await rpc.sendRequest('initialize', { clientInfo: CLIENT_INFO })
    await rpc.sendNotification('initialized', {})

    const threadStartParams = {
      model: options.model ?? null,
      modelProvider: null,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? 'never',
      sandbox: options.sandboxMode ?? null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      experimentalRawEvents: false,
    }

    if (options.resumeThreadId) {
      const threadResumeParams = {
        threadId: options.resumeThreadId,
        history: null,
        path: null,
        model: options.model ?? null,
        modelProvider: null,
        cwd: options.cwd,
        approvalPolicy: options.approvalPolicy ?? 'never',
        sandbox: options.sandboxMode ?? null,
        config: null,
        baseInstructions: null,
        developerInstructions: null,
      }
      const response = (await rpc
        .sendRequest('thread/resume', threadResumeParams)
        .catch(async (error: unknown) => {
          if (!isNoRolloutFoundResumeError(error)) {
            throw error
          }

          await emitEvent({
            type: 'notice',
            level: 'warn',
            message: 'Prior Codex thread was lost; starting a fresh thread.',
          })

          return rpc.sendRequest('thread/start', threadStartParams)
        })) as ThreadResumeResponse | ThreadStartResponse
      threadId = response.thread?.id ?? options.resumeThreadId
    } else {
      const response = (await rpc.sendRequest(
        'thread/start',
        threadStartParams
      )) as ThreadStartResponse
      threadId = response.thread?.id
    }

    if (!threadId) {
      throw new Error('Codex thread id missing after app-server thread start')
    }

    await options.onContinuation?.(threadId)
    await emitEvent({
      type: 'agent_start',
      sessionId: threadId,
      sdkSessionId: threadId,
    })

    await emitEvent({ type: 'codex.user_prompt', prompt: options.prompt })

    const input = buildUserInputs(options.prompt, options.imageAttachments)
    const response = (await rpc.sendRequest('turn/start', {
      threadId,
      input,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? 'never',
      sandboxPolicy: toCodexSandboxPolicy(options.sandboxMode),
      model: options.model ?? null,
      effort: options.modelReasoningEffort ?? null,
      summary: null,
      outputSchema: null,
    })) as TurnStartResponse

    if (response.turn?.id) {
      currentTurnId = response.turn.id
    }

    await turnPromise
    const status = turnCompleted?.turn?.status
    const terminalState =
      status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed'
    const success = terminalState === 'completed'
    return {
      threadId,
      turnCompleted: true,
      success,
      ...(finalOutput !== undefined ? { finalOutput } : {}),
      ...(latestUsage !== undefined ? { usage: latestUsage } : {}),
      terminalState,
    }
  } finally {
    rpc.close()
  }

  async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
    if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      return { decision: 'decline' }
    }

    throw new Error(`Unhandled Codex app-server request: ${request.method}`)
  }
}

function isNoRolloutFoundResumeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /^JSON-RPC error -32600:/i.test(error.message) && /no rollout found/i.test(error.message)
}

function buildUserInputs(
  text: string,
  imageAttachments: string[] | undefined
): Record<string, unknown>[] {
  const inputs: Record<string, unknown>[] = [{ type: 'text', text, text_elements: [] }]
  for (const path of imageAttachments ?? []) {
    inputs.push({ type: 'localImage', path })
  }
  return inputs
}

async function handleItemStarted(
  params: ItemStartedNotification,
  items: Map<string, CodexThreadItem>,
  emitEvent: (event: UnifiedSessionEvent) => Promise<void>
): Promise<void> {
  const item = params.item
  if (item.id) {
    items.set(item.id, item)
  }

  switch (item.type) {
    case 'agentMessage': {
      await emitEvent({
        type: 'message_start',
        messageId: item.id,
        message: { role: 'assistant', content: item.text ?? '' },
        payload: item,
      })
      return
    }
    case 'commandExecution': {
      await emitEvent({
        type: 'tool_execution_start',
        toolUseId: item.id,
        toolName: 'command_execution',
        input: { command: item.command, cwd: item.cwd },
        payload: item,
      })
      return
    }
    case 'fileChange': {
      await emitEvent({
        type: 'tool_execution_start',
        toolUseId: item.id,
        toolName: 'file_change',
        input: { changes: item.changes },
        payload: item,
      })
      return
    }
    case 'mcpToolCall': {
      await emitEvent({
        type: 'tool_execution_start',
        toolUseId: item.id,
        toolName: `mcp:${item.server}/${item.tool}`,
        input: { server: item.server, tool: item.tool, arguments: item.arguments },
        payload: item,
      })
      return
    }
    case 'webSearch': {
      await emitEvent({
        type: 'tool_execution_start',
        toolUseId: item.id,
        toolName: 'web_search',
        input: { query: item.query },
        payload: item,
      })
      return
    }
    case 'imageView': {
      await emitEvent({
        type: 'tool_execution_start',
        toolUseId: item.id,
        toolName: 'image_view',
        input: { path: item.path },
        payload: item,
      })
      return
    }
  }
}

async function handleItemCompleted(
  params: ItemCompletedNotification,
  items: Map<string, CodexThreadItem>,
  emitEvent: (event: UnifiedSessionEvent) => Promise<void>
): Promise<string | undefined> {
  const item = params.item
  if (item.id) {
    items.set(item.id, item)
  }

  switch (item.type) {
    case 'agentMessage': {
      const text = item.text ?? ''
      await emitEvent({
        type: 'message_end',
        messageId: item.id,
        message: { role: 'assistant', content: text },
        payload: item,
      })
      return text
    }
    case 'commandExecution': {
      const result = buildToolResult(item.aggregatedOutput ?? '', {
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      })
      await emitEvent({
        type: 'tool_execution_end',
        toolUseId: item.id,
        toolName: 'command_execution',
        result,
        ...(item.exitCode !== null && item.exitCode !== 0 ? { isError: true } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
        payload: item,
      })
      return undefined
    }
    case 'fileChange': {
      await emitEvent({
        type: 'tool_execution_end',
        toolUseId: item.id,
        toolName: 'file_change',
        result: buildToolResult(JSON.stringify(item.changes ?? [], null, 2)),
        ...(item.status && item.status !== 'completed' ? { isError: true } : {}),
        payload: item,
      })
      return undefined
    }
    case 'mcpToolCall': {
      const resultPayload = item.error ?? item.result ?? ''
      await emitEvent({
        type: 'tool_execution_end',
        toolUseId: item.id,
        toolName: `mcp:${item.server}/${item.tool}`,
        result: buildToolResult(
          typeof resultPayload === 'string' ? resultPayload : JSON.stringify(resultPayload, null, 2)
        ),
        ...(item.error ? { isError: true } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
        payload: item,
      })
      return undefined
    }
    case 'webSearch': {
      await emitEvent({
        type: 'tool_execution_end',
        toolUseId: item.id,
        toolName: 'web_search',
        result: buildToolResult(`web_search: ${item.query}`),
        payload: item,
      })
      return undefined
    }
    case 'imageView': {
      await emitEvent({
        type: 'tool_execution_end',
        toolUseId: item.id,
        toolName: 'image_view',
        result: buildToolResult(`image_view: ${item.path}`),
        payload: item,
      })
      return undefined
    }
  }

  return undefined
}

function buildToolResult(content: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: content }],
    ...(details ? { details } : {}),
  }
}

function resolveFinalOutput(items: CodexThreadItem[] | undefined): string | undefined {
  if (!items) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      return item.text
    }
  }
  return undefined
}

function formatCodexError(params: ErrorNotification): string {
  const message = params.error?.message ?? 'Unknown error'
  const details = params.error?.additionalDetails ? ` (${params.error.additionalDetails})` : ''
  const info = params.error?.codexErrorInfo ? ` ${JSON.stringify(params.error.codexErrorInfo)}` : ''
  return `Codex app-server error: ${message}${details}${info}`
}
