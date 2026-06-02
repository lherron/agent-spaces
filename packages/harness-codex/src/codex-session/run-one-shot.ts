import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { toError } from '../errors.js'
import {
  type AgentMessageDeltaNotification,
  type CodexThreadItem,
  type CommandExecutionOutputDeltaNotification,
  type ErrorNotification,
  type FileChangeOutputDeltaNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type McpToolCallProgressNotification,
  type ThreadResumeResponse,
  type ThreadStartResponse,
  type TurnStartResponse,
  mapItemCompleted,
  mapItemStarted,
} from './event-mapping.js'
import { CodexRpcClient, type JsonRpcNotification, type JsonRpcRequest } from './rpc-client.js'
import { type CodexApprovalPolicy, type CodexSandboxMode, toCodexSandboxPolicy } from './types.js'

const CLIENT_INFO = {
  name: 'agent-spaces',
  version: process.env['npm_package_version'] ?? 'unknown',
}

interface TurnCompletedNotification {
  turn: {
    id: string
    status?: string | undefined
    items?: CodexThreadItem[] | undefined
  }
}

interface ThreadTokenUsageUpdatedNotification {
  tokenUsage?: unknown
  token_usage?: unknown
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
    terminalError = toError(error)
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
        if (params.item.id) {
          items.set(params.item.id, params.item)
        }
        for (const event of mapItemStarted(params.item)) {
          await emitEvent(event)
        }
        return
      }
      case 'item/completed': {
        const params = notification.params as ItemCompletedNotification
        if (params.item.id) {
          items.set(params.item.id, params.item)
        }
        const mapped = mapItemCompleted(params.item)
        for (const event of mapped.events) {
          await emitEvent(event)
        }
        if (mapped.finalOutput !== undefined) {
          finalOutput = mapped.finalOutput
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

function resolveFinalOutput(items: CodexThreadItem[] | undefined): string | undefined {
  if (!items) return undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.type === 'agentMessage') {
      const text = (item as Extract<CodexThreadItem, { type: 'agentMessage' }>).text
      if (typeof text === 'string') {
        return text
      }
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
