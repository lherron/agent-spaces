import { type Query, query } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_SDK_MODEL_MAP } from 'spaces-config'
import type {
  ContentBlock,
  Message,
  PermissionHandler,
  PromptOptions,
  SessionMetadataSnapshot,
  ToolResult,
  UnifiedSession,
  UnifiedSessionEvent,
  UnifiedSessionState,
} from 'spaces-runtime'
import type { HookEventBusAdapter } from './hooks-bridge.js'
import { HooksBridge, processSDKMessage } from './hooks-bridge.js'
import { PromptQueue } from './prompt-queue.js'
import {
  convertContentBlock,
  extractStructuredContent,
  extractToolInput,
  extractToolName,
  forEachToolBlock,
  isToolResultError,
  normalizeToolInput,
  normalizeToolResultBlocks,
  resolveToolUseId,
} from './sdk-message-decode.js'

/**
 * Default cap on SDK turns when the caller does not specify one. The SDK has no
 * implicit limit, so we bound runaway multi-turn loops.
 */
const DEFAULT_MAX_TURNS = 100

/**
 * Shell forced into the SDK child environment so tool invocations have a
 * predictable, POSIX-compatible shell regardless of the host's login shell.
 */
const SDK_CHILD_SHELL = '/bin/bash'

/**
 * Factory for the SDK `query()` call. Defaults to the real SDK function but can
 * be injected for tests so the session lifecycle / error paths can be exercised
 * against a fake `Query` without spinning up the real SDK.
 */
export type QueryFactory = typeof query

/**
 * Seam over process globals (pid + env) so the session does not read
 * `process.*` directly, enabling deterministic substitution in tests.
 */
export interface RuntimeEnv {
  pid: number
  env: Record<string, string | undefined>
}

const defaultRuntimeEnv: RuntimeEnv = {
  get pid() {
    return process.pid
  },
  get env() {
    return process.env
  },
}

/**
 * Optional collaborators / seams for an {@link AgentSession}.
 */
export interface AgentSessionOpts {
  onSdkSessionId?: (sdkSessionId: string) => void
  /** Override the SDK `query()` entrypoint (defaults to the real SDK). */
  queryFactory?: QueryFactory
  /** Override the process pid/env seam (defaults to real `process`). */
  runtimeEnv?: RuntimeEnv
}

/**
 * Configuration for an agent session.
 */
export interface AgentSessionConfig {
  ownerId: string
  cwd: string
  model: 'haiku' | 'sonnet' | 'opus' | 'opus-4-6'
  allowedTools?: string[]
  maxTurns?: number
  sessionId?: string
  plugins?: Array<{ type: 'local'; path: string }>
  /** Custom system prompt to override default Claude Code prompt */
  systemPrompt?: string
  /**
   * How systemPrompt is applied to the SDK session:
   * - 'replace' (default): systemPrompt replaces the entire default prompt
   * - 'append': systemPrompt is appended to the default Claude Code preset prompt
   *
   * When mode is 'append', the SDK receives:
   *   `{ type: 'preset', preset: 'claude_code', append: systemPrompt }`
   * When mode is 'replace' (or omitted), the SDK receives the raw string.
   */
  systemPromptMode?: 'replace' | 'append'
  /** Provider-native continuation key (loads conversation history from previous session) */
  continuationKey?: string
}

/**
 * State of an agent session.
 */
export type AgentSessionState = 'idle' | 'running' | 'stopped' | 'error'

/**
 * Manages a single Claude Agent SDK session for an owner (project/run/session).
 *
 * Each owner gets one AgentSession that:
 * - Owns the SDK query iterator
 * - Accepts user prompts via the prompt queue
 * - Streams outputs and hook callbacks back to the host
 */
export class AgentSession implements UnifiedSession {
  readonly kind = 'agent-sdk' as const
  readonly sessionId: string
  private readonly promptQueue: PromptQueue
  private readonly hooksBridge: HooksBridge
  private outputIterator: AsyncIterator<unknown> | null = null
  private sdkQuery: Query | null = null
  private outputListener?: Promise<void>
  private state: AgentSessionState = 'idle'
  private isListening = false
  private lastActivityAt: number = Date.now()
  private pid?: number
  private lastResponse = ''
  private sdkSessionId?: string
  private readonly onSdkSessionId: ((sdkSessionId: string) => void) | undefined
  private eventCallback?: (event: UnifiedSessionEvent) => void
  private hasEmittedAgentStart = false
  private hasEmittedAgentEnd = false
  private stopReason: string | undefined
  private stopEmitted = false
  private turnCounter = 0
  private pendingTurnIds: string[] = []
  private readonly toolUses = new Map<string, { name: string; input: unknown }>()
  private toolUseCounter = 0
  private stopResolve?: () => void
  private stopPromise?: Promise<void>
  private abortController?: AbortController
  /**
   * Tracks the current subagent context (parent Task tool use ID).
   * Set when we receive a user message with parent_tool_use_id,
   * cleared when the corresponding Task tool result is received.
   */
  private currentSubagentContext: string | undefined
  private readonly queryFactory: QueryFactory
  private readonly runtimeEnv: RuntimeEnv

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly hookEventBus?: HookEventBusAdapter,
    opts?: AgentSessionOpts
  ) {
    this.promptQueue = new PromptQueue(config.sessionId)
    this.hooksBridge = new HooksBridge(config.ownerId, hookEventBus, config.cwd, config.sessionId)
    this.onSdkSessionId = opts?.onSdkSessionId
    this.queryFactory = opts?.queryFactory ?? query
    this.runtimeEnv = opts?.runtimeEnv ?? defaultRuntimeEnv
    this.sessionId = config.sessionId ?? config.ownerId
  }

  onEvent(callback: (event: UnifiedSessionEvent) => void): void {
    this.eventCallback = callback
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.hooksBridge.setPermissionHandler(handler)
  }

  /**
   * Start the SDK session by initializing the query.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start session in state: ${this.state}`)
    }

    this.state = 'running'
    this.lastActivityAt = Date.now()

    // Create stop promise for graceful shutdown
    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve
    })

    // Store PID of current process (the SDK runs in-process)
    this.pid = this.runtimeEnv.pid

    // Map short model names to full SDK model names
    const sdkModel = AGENT_SDK_MODEL_MAP[this.config.model] ?? this.config.model

    // Initialize the SDK query with the prompt queue as input
    const permissionMode = 'default' as const
    this.abortController = new AbortController()
    const options = {
      maxTurns: this.config.maxTurns ?? DEFAULT_MAX_TURNS,
      model: sdkModel,
      cwd: this.config.cwd,
      env: { ...this.runtimeEnv.env, SHELL: SDK_CHILD_SHELL },
      permissionMode,
      abortController: this.abortController,
      // biome-ignore lint/suspicious/noExplicitAny: SDK type compatibility for canUseTool callback
      canUseTool: this.hooksBridge.createCanUseToolCallback() as any,
      ...(this.config.allowedTools ? { allowedTools: this.config.allowedTools } : {}),
      ...(this.config.plugins ? { plugins: this.config.plugins } : {}),
      ...this.resolveSystemPromptOption(),
      ...(this.config.continuationKey ? { resume: this.config.continuationKey } : {}),
    }

    console.log(
      `[agent-sdk] session.start ${this.config.ownerId} model=${sdkModel} resume=${this.config.continuationKey ? truncateId(this.config.continuationKey) : 'none'} plugins=${this.config.plugins?.length ?? 0} maxTurns=${options.maxTurns}`
    )

    const result = this.queryFactory({
      // biome-ignore lint/suspicious/noExplicitAny: SDK type compatibility - accepts simpler message formats at runtime
      prompt: this.promptQueue as any,
      options,
    })

    this.sdkQuery = result
    this.outputIterator = result[Symbol.asyncIterator]()
    this.startOutputListener()
  }

  /**
   * Build the systemPrompt option for the SDK query based on systemPromptMode.
   *
   * - 'append': uses the SDK's preset+append form so the default Claude Code
   *   system prompt is preserved and systemPrompt text is appended.
   * - 'replace' (default): passes systemPrompt as a raw string, fully replacing
   *   the default prompt.
   */
  private resolveSystemPromptOption(): {
    systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string }
  } {
    const { systemPrompt, systemPromptMode } = this.config
    if (!systemPrompt) return {}

    if (systemPromptMode === 'append') {
      // SDK natively supports append via the preset form:
      //   { type: 'preset', preset: 'claude_code', append: '...' }
      return {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      }
    }

    // Default: replace mode — pass raw string
    return { systemPrompt }
  }

  /**
   * Send a user prompt to the session.
   */
  async sendPrompt(content: string, _options?: PromptOptions): Promise<void> {
    if (this.state !== 'running') {
      throw new Error(`Cannot send prompt in state: ${this.state}`)
    }
    this.lastActivityAt = Date.now()
    this.stopEmitted = false
    const turnId = `turn-${++this.turnCounter}`
    this.pendingTurnIds.push(turnId)
    this.emitEvent({ type: 'turn_start', turnId })
    this.promptQueue.push(content)
  }

  /**
   * Interrupt the currently active turn while keeping the session alive.
   */
  async interrupt(_reason?: string): Promise<void> {
    if (this.state !== 'running') return
    this.lastActivityAt = Date.now()

    if (!this.sdkQuery) return
    try {
      await this.sdkQuery.interrupt()
    } catch (error) {
      console.error(
        `[agent-sdk] Failed to interrupt turn for session ${this.config.ownerId}:`,
        error
      )
      throw error
    }
  }

  /**
   * Stop the session.
   */
  async stop(reason?: string): Promise<void> {
    if (this.state === 'stopped') return

    const priorState = this.state
    this.state = 'stopped'
    this.stopReason = reason
    this.promptQueue.close(reason)

    // Signal the listener loop to stop
    this.stopResolve?.()

    if (this.sdkQuery) {
      try {
        await this.sdkQuery.interrupt()
      } catch (error) {
        // When the SDK child process has already exited (e.g. crashed with
        // code 1 earlier in the turn), interrupt() surfaces a
        // "ProcessTransport is not ready for writing" error. That's not an
        // error from our perspective — we're already stopping. Log it at
        // debug level and continue with local teardown so callers don't see
        // a cleanup failure masquerade as a turn failure.
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('ProcessTransport is not ready')) {
          console.log(
            `[agent-sdk] session ${this.config.ownerId} child already exited; skipping interrupt (priorState=${priorState}, reason=${reason ?? 'none'})`
          )
        } else {
          console.error(
            `[agent-sdk] Failed to interrupt session ${this.config.ownerId} (priorState=${priorState}, reason=${reason ?? 'none'}):`,
            error
          )
        }
      }
    }

    this.abortController?.abort()

    // Terminate the output iterator (fire and forget - awaiting may hang)
    if (this.outputIterator?.return) {
      void this.outputIterator.return().catch((error) => {
        console.error(
          `[agent-sdk] Failed to close output iterator for session ${this.config.ownerId}:`,
          error
        )
      })
    }

    if (this.outputListener) {
      await this.outputListener
    }

    this.hooksBridge.emitSessionEnd()
    this.emitAgentEnd(reason)
  }

  /**
   * Get the current session state.
   */
  getState(): UnifiedSessionState {
    return this.state
  }

  /**
   * Get the PID of the session (for status reporting).
   */
  getPid(): number | undefined {
    return this.pid
  }

  /**
   * Get the SDK session ID (for session resume via `claude -r`).
   * This is captured from the SDK's system/init message.
   */
  getSdkSessionId(): string | undefined {
    return this.sdkSessionId
  }

  /**
   * Get the last activity timestamp.
   */
  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  /**
   * Check if the session is healthy.
   */
  isHealthy(): boolean {
    return this.state === 'running'
  }

  getMetadata(): SessionMetadataSnapshot {
    return {
      sessionId: this.sessionId,
      kind: this.kind,
      state: this.getState(),
      lastActivityAt: this.lastActivityAt,
      ...(this.sdkSessionId !== undefined ? { nativeIdentity: this.sdkSessionId } : {}),
      ...(this.config.continuationKey !== undefined
        ? { continuationKey: this.config.continuationKey }
        : {}),
      capabilities: {
        supportsInterrupt: true,
        supportsInFlightInput: false,
        supportsNativeResume: true,
        supportsAttach: false,
      },
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
    }
  }

  /**
   * Start listening to SDK output messages.
   */
  private startOutputListener(): void {
    if (this.isListening) return
    this.isListening = true

    this.outputListener = this.listenToOutput().catch((error) => {
      console.error(`[agent-sdk] Error in session ${this.config.ownerId}:`, error)
    })
  }

  /**
   * Listen to SDK output and process messages.
   */
  private async listenToOutput(): Promise<void> {
    if (!this.outputIterator) return

    const STOP_SENTINEL = Symbol('stop')

    try {
      while (this.state === 'running') {
        // Race iterator.next() against stop signal
        const result = await Promise.race([
          this.outputIterator.next(),
          this.stopPromise?.then(() => STOP_SENTINEL),
        ])

        // Check if we received the stop signal
        if (result === STOP_SENTINEL || this.state !== 'running') break

        const { value, done } = result as IteratorResult<unknown>
        if (done) break

        this.processMessage(value)
      }
    } catch (error) {
      this.state = 'error'
      this.stopReason = this.stopReason ?? 'error'
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error(
        `[agent-sdk] listenToOutput failed for session ${this.config.ownerId} (sdkSessionId=${this.sdkSessionId ?? 'none'}, pendingTurns=${this.pendingTurnIds.length}, lastResponseLen=${this.lastResponse.length}): ${errMsg}`
      )
      this.emitStopIfNeeded(undefined, this.lastResponse || undefined)
      // Flush any pending turn_end events so callers awaiting turnPromise
      // resolve instead of hanging. Without this, a mid-turn child crash
      // leaves runPlacementTurnNonInteractive blocked until the outer
      // abort/timeout fires, or worse, the turn is tracked as wedged.
      this.flushPendingTurns()
      throw error
    } finally {
      this.isListening = false
      if (this.state === 'running') {
        this.state = 'stopped'
      }
      // Emit final stop if session ends without a result
      if (this.lastResponse) {
        this.emitStopIfNeeded(undefined, this.lastResponse)
      }
      // Flush any pending turn_end events for the clean-exit case too —
      // the SDK can end the iterator without emitting a terminal result
      // (e.g. child exits 0 after an empty resume), and callers need to
      // unblock on turn_end.
      this.flushPendingTurns()
      this.emitAgentEnd(this.stopReason ?? (this.state === 'error' ? 'error' : 'stopped'))
    }
  }

  /**
   * Process a single SDK output message: capture session id from init, emit
   * agent_start, track the last assistant response, dispatch the message to the
   * event/hook streams, and flush a turn when a terminal result arrives.
   */
  private processMessage(value: unknown): void {
    this.lastActivityAt = Date.now()

    const msg = value as Record<string, unknown>
    const msgType = typeof msg['type'] === 'string' ? msg['type'] : undefined

    if (msgType === 'system' && msg['subtype'] === 'init') {
      this.captureInitMessage(msg)
    }
    this.emitAgentStartIfNeeded()

    // Extract assistant response text from SDK messages
    const responseText = this.extractResponseText(value)
    if (responseText) {
      this.lastResponse = responseText
    }

    this.handleSdkMessage(msg, msgType)
    processSDKMessage(value, this.hooksBridge)

    // When we receive a result message, emit Stop to complete the current run.
    // The SDK session stays alive for subsequent prompts.
    if (msgType === 'result') {
      this.emitStopIfNeeded(undefined, this.lastResponse || undefined)
      // Clear lastResponse for next prompt
      this.lastResponse = ''
      this.emitTurnEndIfNeeded()
    }
  }

  /**
   * Capture the SDK session id (for resume) and log discovered plugins from a
   * `system`/`init` message.
   */
  private captureInitMessage(msg: Record<string, unknown>): void {
    const sessionId = msg['session_id']
    if (typeof sessionId === 'string' && this.sdkSessionId !== sessionId) {
      this.sdkSessionId = sessionId
      this.onSdkSessionId?.(sessionId)
      // Emit dedicated event for SDK session ID (used for resume)
      this.emitEvent({ type: 'sdk_session_id', sdkSessionId: sessionId })
    }
    const pluginList = Array.isArray(msg['plugins']) ? msg['plugins'] : []
    const pluginNames = pluginList
      .map((plugin) => {
        if (plugin && typeof plugin === 'object' && typeof plugin.name === 'string') {
          return plugin.name
        }
        return null
      })
      .filter((name): name is string => Boolean(name))
    if (pluginNames.length > 0) {
      console.log(`[agent-sdk] init plugins for ${this.config.ownerId}: ${pluginNames.join(', ')}`)
    }
  }

  /**
   * Drain all pending turn ids, emitting a `turn_end` for each so callers
   * awaiting a turn promise unblock on every exit path.
   */
  private flushPendingTurns(): void {
    while (this.pendingTurnIds.length > 0) {
      this.emitTurnEndIfNeeded()
    }
  }

  private emitEvent(event: UnifiedSessionEvent): void {
    this.eventCallback?.(event)
  }

  private emitStopIfNeeded(transcriptPath?: string, lastResponse?: string): void {
    if (this.stopEmitted) return
    this.stopEmitted = true
    this.hooksBridge.emitStop(transcriptPath, lastResponse)
  }

  private emitAgentStartIfNeeded(): void {
    if (this.hasEmittedAgentStart) return
    this.hasEmittedAgentStart = true
    const event: UnifiedSessionEvent = {
      type: 'agent_start',
      sessionId: this.sessionId,
      ...(this.sdkSessionId !== undefined ? { sdkSessionId: this.sdkSessionId } : {}),
    }
    this.emitEvent(event)
  }

  private emitAgentEnd(reason?: string): void {
    if (this.hasEmittedAgentEnd) return
    this.hasEmittedAgentEnd = true
    const event: UnifiedSessionEvent = {
      type: 'agent_end',
      sessionId: this.sessionId,
      ...(this.sdkSessionId !== undefined ? { sdkSessionId: this.sdkSessionId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    }
    this.emitEvent(event)
  }

  private emitTurnEndIfNeeded(): void {
    const turnId = this.pendingTurnIds.shift()
    if (!turnId) return
    this.emitEvent({ type: 'turn_end', turnId })
  }

  private handleSdkMessage(msg: Record<string, unknown>, msgType: string | undefined): void {
    const message = mapSdkMessage(msgType, msg)
    if (message) {
      const messageId = resolveMessageId(msg)
      const messageEventBase = messageId !== undefined ? { messageId } : {}
      this.emitEvent({ type: 'message_start', message, ...messageEventBase, payload: msg })
      if (Array.isArray(message.content)) {
        this.emitEvent({
          type: 'message_update',
          contentBlocks: message.content,
          ...messageEventBase,
          payload: msg,
        })
      } else if (typeof message.content === 'string') {
        this.emitEvent({
          type: 'message_update',
          textDelta: message.content,
          ...messageEventBase,
          payload: msg,
        })
      }
      this.emitEvent({ type: 'message_end', message, ...messageEventBase, payload: msg })
    }

    // Track subagent context from user messages with parent_tool_use_id
    // This indicates we're inside a Task tool's subagent execution
    const messageParentToolUseId =
      typeof msg['parent_tool_use_id'] === 'string' ? msg['parent_tool_use_id'] : undefined

    if (msgType === 'user' && messageParentToolUseId) {
      // Entering subagent context
      this.currentSubagentContext = messageParentToolUseId
    }

    // For tool_use type messages (standalone tool calls), use current subagent context
    // These come from the subagent's assistant response
    if (msgType === 'tool_use') {
      const toolUseId = resolveToolUseId(msg) ?? `sdk-tool-${++this.toolUseCounter}`
      const toolName = extractToolName(msg)
      const toolInput = extractToolInput(msg)

      this.toolUses.set(toolUseId, { name: toolName, input: toolInput })
      this.emitEvent({
        type: 'tool_execution_start',
        toolUseId,
        toolName,
        input: normalizeToolInput(toolInput),
        payload: msg,
        ...(this.currentSubagentContext ? { parentToolUseId: this.currentSubagentContext } : {}),
      })
      return
    }

    // For tool_result type messages, use and potentially clear subagent context
    if (msgType === 'tool_result') {
      const resultToolUseId = resolveToolUseId(msg)
      const contextToUse = this.currentSubagentContext
      // If this result is for the Task tool itself, clear the subagent context
      if (resultToolUseId && resultToolUseId === this.currentSubagentContext) {
        this.currentSubagentContext = undefined
      }
      this.processToolResultBlock(msg, contextToUse)
      return
    }

    const content = getMessageContent(msgType, msg)
    // Use either the message-level parent_tool_use_id or the current subagent context
    const parentToolUseId = messageParentToolUseId ?? this.currentSubagentContext

    const sawToolResultBlock = this.handleToolBlocks(content, parentToolUseId)
    this.emitUserToolResultIfNeeded(msg, msgType, sawToolResultBlock)
  }

  private handleToolBlocks(content: unknown, parentToolUseId?: string): boolean {
    return forEachToolBlock(content, {
      onToolUse: (block) => this.processToolUseBlock(block, parentToolUseId),
      onToolResult: (block) => this.processToolResultBlock(block, parentToolUseId),
    })
  }

  private processToolUseBlock(blockObj: Record<string, unknown>, parentToolUseId?: string): void {
    const toolUseId = resolveToolUseId(blockObj) ?? `sdk-tool-${++this.toolUseCounter}`
    const toolName = extractToolName(blockObj)
    const toolInput = extractToolInput(blockObj)

    this.toolUses.set(toolUseId, { name: toolName, input: toolInput })
    this.emitEvent({
      type: 'tool_execution_start',
      toolUseId,
      toolName,
      input: normalizeToolInput(toolInput),
      payload: blockObj,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    })
  }

  private processToolResultBlock(
    blockObj: Record<string, unknown>,
    parentToolUseId?: string
  ): void {
    const toolUseId = resolveToolUseId(blockObj)
    const resolvedToolUseId = toolUseId ?? `sdk-tool-${++this.toolUseCounter}`
    const toolMeta = toolUseId ? this.toolUses.get(toolUseId) : undefined
    const toolName = toolMeta?.name ?? extractToolName(blockObj)
    const isError = isToolResultError(blockObj)
    const { blocks } = normalizeToolResultBlocks(blockObj['content'])
    const details: Record<string, unknown> = {}
    const structuredContent = extractStructuredContent(blockObj)
    if (structuredContent !== undefined) {
      details['structured_content'] = structuredContent
    }
    const result: ToolResult = {
      content: blocks,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    }

    this.emitEvent({
      type: 'tool_execution_end',
      toolUseId: resolvedToolUseId,
      toolName,
      result,
      ...(isError !== undefined ? { isError } : {}),
      payload: blockObj,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    })
    if (toolUseId) {
      this.toolUses.delete(toolUseId)
    }
  }

  private emitUserToolResultIfNeeded(
    msg: Record<string, unknown>,
    msgType: string | undefined,
    sawToolResultBlock: boolean
  ): void {
    if (
      msgType !== 'user' ||
      sawToolResultBlock ||
      typeof msg['parent_tool_use_id'] !== 'string' ||
      msg['tool_use_result'] === undefined
    ) {
      return
    }
    const toolUseId = msg['parent_tool_use_id']
    const toolMeta = this.toolUses.get(toolUseId)
    const toolName = toolMeta?.name ?? 'tool'
    const { blocks } = normalizeToolResultBlocks(msg['tool_use_result'])
    const result: ToolResult = { content: blocks }
    this.emitEvent({
      type: 'tool_execution_end',
      toolUseId,
      toolName,
      result,
      payload: msg,
    })
    this.toolUses.delete(toolUseId)
  }

  /**
   * Extract text response from SDK message.
   */
  private extractResponseText(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') return undefined

    const msg = message as Record<string, unknown>

    // Handle result messages (final completion with result string)
    if (msg['type'] === 'result' && typeof msg['result'] === 'string') {
      return msg['result']
    }

    // Handle assistant messages
    if (msg['type'] === 'assistant' && msg['message']) {
      const assistantMsg = msg['message'] as Record<string, unknown>
      const content = assistantMsg['content']

      if (typeof content === 'string') {
        return content
      }

      if (Array.isArray(content)) {
        // Extract text from content blocks
        const textParts: string[] = []
        for (const block of content) {
          if (block && typeof block === 'object') {
            const blockObj = block as Record<string, unknown>
            if (blockObj['type'] === 'text' && typeof blockObj['text'] === 'string') {
              textParts.push(blockObj['text'])
            }
          }
        }
        if (textParts.length > 0) {
          return textParts.join('\n')
        }
      }
    }

    return undefined
  }
}

function getMessageContent(msgType: string | undefined, msg: Record<string, unknown>): unknown {
  if (msgType !== 'assistant' && msgType !== 'user') return undefined
  const message = msg['message']
  if (!message || typeof message !== 'object') return undefined
  return (message as Record<string, unknown>)['content']
}

function resolveMessageId(msg: Record<string, unknown>): string | undefined {
  const message = msg['message']
  if (message && typeof message === 'object') {
    const id = (message as Record<string, unknown>)['id']
    if (typeof id === 'string') return id
  }
  if (typeof msg['message_id'] === 'string') return msg['message_id']
  if (typeof msg['messageId'] === 'string') return msg['messageId']
  return undefined
}

function mapSdkMessage(msgType: string | undefined, msg: Record<string, unknown>): Message | null {
  if (msgType !== 'assistant' && msgType !== 'user') return null
  const message = msg['message']
  if (!message || typeof message !== 'object') return null
  const messageObj = message as Record<string, unknown>
  const content = mapSdkContent(messageObj['content'])
  if (content === undefined) return null

  const roleRaw = typeof messageObj['role'] === 'string' ? messageObj['role'] : msgType
  const role = roleRaw === 'toolResult' || roleRaw === 'tool' ? 'toolResult' : roleRaw

  if (role !== 'assistant' && role !== 'user' && role !== 'toolResult') return null
  return { role, content }
}

function mapSdkContent(content: unknown): ContentBlock[] | string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined

  const blocks: ContentBlock[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      const text = typeof item === 'string' ? item : String(item)
      if (text) {
        blocks.push({ type: 'text', text })
      }
      continue
    }

    const block = item as Record<string, unknown>
    const type = typeof block['type'] === 'string' ? block['type'] : undefined

    // Plain (non-tool) blocks are converted via the shared handler table.
    if (type === 'text' || type === 'image' || type === 'media_ref' || type === 'resource_link') {
      const converted = convertContentBlock(block)
      if (converted) blocks.push(converted)
      continue
    }

    if (type === 'tool_use') {
      const toolUseId = resolveToolUseId(block)
      const toolName =
        typeof block['name'] === 'string'
          ? block['name']
          : typeof block['tool_name'] === 'string'
            ? block['tool_name']
            : undefined
      if (toolUseId && toolName) {
        blocks.push({
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: normalizeToolInput(extractToolInput(block)),
        })
      }
      continue
    }

    if (type === 'tool_result') {
      const toolUseId = resolveToolUseId(block)
      const { text } = normalizeToolResultBlocks(block['content'])
      if (toolUseId && text) {
        const entry: ContentBlock = {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: text,
        }
        if (block['is_error'] === true || block['isError'] === true) {
          entry.is_error = true
        }
        blocks.push(entry)
      }
    }
  }

  return blocks.length > 0 ? blocks : undefined
}

// Shorten a UUID-like identifier for log lines. Full UUIDs are noisy and
// the first segment is enough to correlate against DB records.
function truncateId(id: string): string {
  const dash = id.indexOf('-')
  return dash > 0 ? id.slice(0, dash) : id.slice(0, 8)
}
