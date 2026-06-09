import type { PermissionHandler } from 'spaces-runtime'
import {
  SDK_TOOL_ID_PREFIX,
  extractStructuredContent,
  extractToolInput,
  extractToolName,
  forEachToolBlock,
  isSynthesizableUserToolResult,
  isToolResultError,
  normalizeToolResultBlocks,
  resolveToolUseId,
} from './sdk-message-decode.js'

export interface HookPermissionResponse {
  decision: 'allow' | 'deny'
  updatedInput?: unknown
  message?: string
  interrupt?: boolean
}

/**
 * Interface for the HookEventBus that this bridge will emit to.
 * This allows the bridge to work with a host control-plane event bus.
 */
export interface HookEventBusAdapter {
  emitHook(ownerId: string, hook: Record<string, unknown>): void
  requestPermission(ownerId: string, hook: Record<string, unknown>): Promise<HookPermissionResponse>
  isToolAutoAllowed(ownerId: string, toolName: string): boolean
}

/**
 * Default message used when a tool permission is denied without an explicit
 * reason.
 */
const PERMISSION_DENIED_MESSAGE = 'Permission denied'

/**
 * SDK tool use result for canUseTool callback.
 * This matches the SDK's PermissionResult type.
 */
export type CanUseToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

/**
 * Bridge between Claude Agent SDK hooks and a host HookEventBus.
 *
 * This bridge:
 * - Converts SDK hook events (PreToolUse, PostToolUse, etc.) to host hook format
 * - Handles permission decisions via the `canUseTool` callback
 * - Emits progress events to the HookEventBus
 */
export class HooksBridge {
  private currentToolUseId = 0
  private readonly toolUses = new Map<string, { name: string; input: unknown }>()
  private readonly emittedToolUseIds = new Set<string>()
  private permissionHandler: PermissionHandler | undefined

  constructor(
    private readonly ownerId: string,
    private readonly hookEventBus?: HookEventBusAdapter,
    private readonly cwd?: string,
    private readonly sessionId?: string
  ) {}

  setPermissionHandler(handler: PermissionHandler | undefined): void {
    this.permissionHandler = handler
  }

  /**
   * Create the canUseTool callback for the SDK.
   * This is called by the SDK before each tool execution for permission checking.
   */
  createCanUseToolCallback(): (
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { signal: AbortSignal }
  ) => Promise<CanUseToolResult> {
    return async (toolName, toolInput, _opts) => {
      const toolUseId =
        typeof (_opts as { toolUseID?: unknown }).toolUseID === 'string'
          ? (_opts as { toolUseID?: string }).toolUseID
          : undefined
      if (toolUseId) {
        this.registerToolUse(toolUseId, toolName, toolInput)
      }

      return this.resolvePermission(toolName, toolInput, toolUseId)
    }
  }

  /**
   * Resolve a tool permission decision.
   *
   * Resolution order:
   * 1. An explicit {@link PermissionHandler}, if one is set.
   * 2. The {@link HookEventBus} policy (auto-allow) and request flow.
   * 3. Allow-by-default when neither is configured.
   */
  private async resolvePermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId?: string
  ): Promise<CanUseToolResult> {
    const permissionHandler = this.permissionHandler
    if (permissionHandler) {
      return this.resolveViaPermissionHandler(permissionHandler, toolName, toolInput, toolUseId)
    }

    if (!this.hookEventBus) {
      return { behavior: 'allow', updatedInput: toolInput }
    }

    return this.resolveViaHookEventBus(this.hookEventBus, toolName, toolInput, toolUseId)
  }

  private async resolveViaPermissionHandler(
    permissionHandler: PermissionHandler,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId?: string
  ): Promise<CanUseToolResult> {
    this.emitPreToolUse(toolName, toolInput, toolUseId)

    if (permissionHandler.isAutoAllowed(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput }
    }

    const response = await permissionHandler.requestPermission({
      toolName,
      toolUseId: toolUseId ?? '',
      input: toolInput,
    })

    if (response.allowed) {
      return {
        behavior: 'allow',
        updatedInput: (response.modifiedInput as Record<string, unknown>) ?? toolInput,
      }
    }

    return {
      behavior: 'deny',
      message: response.reason ?? PERMISSION_DENIED_MESSAGE,
    }
  }

  private async resolveViaHookEventBus(
    hookEventBus: HookEventBusAdapter,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId?: string
  ): Promise<CanUseToolResult> {
    // Check if tool is auto-allowed by policy
    if (hookEventBus.isToolAutoAllowed(this.ownerId, toolName)) {
      // Still emit PreToolUse for progress tracking
      this.emitPreToolUse(toolName, toolInput, toolUseId)
      return { behavior: 'allow', updatedInput: toolInput }
    }

    // Request permission via HookEventBus
    const hook = this.buildPreToolUseHook(toolName, toolInput, toolUseId)
    const response = await hookEventBus.requestPermission(this.ownerId, hook)

    if (response.decision === 'allow') {
      return {
        behavior: 'allow',
        updatedInput: (response.updatedInput as Record<string, unknown>) ?? toolInput,
      }
    }
    return {
      behavior: 'deny',
      message: response.message ?? PERMISSION_DENIED_MESSAGE,
      ...(response.interrupt !== undefined ? { interrupt: response.interrupt } : {}),
    }
  }

  /**
   * Emit a PreToolUse hook event (for progress tracking).
   */
  emitPreToolUse(toolName: string, toolInput: unknown, toolUseId?: string): void {
    if (!this.hookEventBus) return
    const hook = this.buildPreToolUseHook(toolName, toolInput, toolUseId)
    const resolvedToolUseId =
      typeof hook['tool_use_id'] === 'string' ? hook['tool_use_id'] : undefined
    if (resolvedToolUseId) {
      if (this.emittedToolUseIds.has(resolvedToolUseId)) return
      this.emittedToolUseIds.add(resolvedToolUseId)
    }
    this.hookEventBus.emitHook(this.ownerId, hook)
  }

  /**
   * Emit a PostToolUse hook event (for progress tracking).
   */
  emitPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
    toolUseId?: string,
    isError?: boolean
  ): void {
    if (!this.hookEventBus) return
    const hook: Record<string, unknown> = {
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: toolUseId ?? this.generateToolUseId(),
      is_error: isError === true ? true : undefined,
      cwd: this.cwd,
      session_id: this.sessionId,
    }
    this.hookEventBus.emitHook(this.ownerId, hook)
  }

  /**
   * Emit a Notification hook event.
   */
  emitNotification(message: string): void {
    if (!this.hookEventBus) return
    const hook: Record<string, unknown> = {
      hook_event_name: 'Notification',
      message,
      cwd: this.cwd,
      session_id: this.sessionId,
    }
    this.hookEventBus.emitHook(this.ownerId, hook)
  }

  /**
   * Emit a Stop hook event (run completion).
   */
  emitStop(transcriptPath?: string, lastResponse?: string): void {
    if (!this.hookEventBus) return
    const hook: Record<string, unknown> = {
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      last_response: lastResponse,
      cwd: this.cwd,
      session_id: this.sessionId,
    }
    this.hookEventBus.emitHook(this.ownerId, hook)
  }

  /**
   * Emit a SessionEnd hook event.
   */
  emitSessionEnd(): void {
    if (!this.hookEventBus) return
    const hook: Record<string, unknown> = {
      hook_event_name: 'SessionEnd',
      cwd: this.cwd,
      session_id: this.sessionId,
    }
    this.hookEventBus.emitHook(this.ownerId, hook)
  }

  /**
   * Build a PreToolUse hook payload.
   */
  private buildPreToolUseHook(
    toolName: string,
    toolInput: unknown,
    toolUseId?: string
  ): Record<string, unknown> {
    const resolvedToolUseId = toolUseId ?? this.generateToolUseId()
    return {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: resolvedToolUseId,
      cwd: this.cwd,
      session_id: this.sessionId,
    }
  }

  /**
   * Generate a unique tool use ID for correlation.
   */
  private generateToolUseId(): string {
    return `${SDK_TOOL_ID_PREFIX}${++this.currentToolUseId}`
  }

  registerToolUse(toolUseId: string, toolName: string, toolInput: unknown): void {
    this.toolUses.set(toolUseId, { name: toolName, input: toolInput })
  }

  getToolUse(toolUseId: string): { name: string; input: unknown } | undefined {
    return this.toolUses.get(toolUseId)
  }

  clearToolUse(toolUseId: string | undefined): void {
    if (!toolUseId) return
    this.toolUses.delete(toolUseId)
    this.emittedToolUseIds.delete(toolUseId)
  }
}

/**
 * Process SDK output messages and emit corresponding hook events.
 *
 * @param message - SDK output message
 * @param bridge - HooksBridge to emit events to
 */
export function processSDKMessage(message: unknown, bridge: HooksBridge): void {
  if (!message || typeof message !== 'object') return

  const msg = message as Record<string, unknown>
  const msgType = typeof msg['type'] === 'string' ? msg['type'] : undefined

  const content =
    msgType === 'assistant' || msgType === 'user'
      ? ((msg['message'] as Record<string, unknown> | undefined)?.['content'] as unknown)
      : undefined

  // Handle assistant/user messages (may contain tool_use/tool_result blocks)
  const sawToolResultBlock = forEachToolBlock(content, {
    onToolUse: (block) => processToolUseBlock(block, bridge),
    onToolResult: (block) => processToolResultBlock(block, bridge),
  })

  emitUserToolResultIfNeeded(msg, msgType, sawToolResultBlock, bridge)

  // Note: result messages are handled by AgentSession.listenToOutput()
  // which extracts the response text and emits Stop with last_response
}

function processToolUseBlock(blockObj: Record<string, unknown>, bridge: HooksBridge): void {
  const toolUseId = resolveToolUseId(blockObj)
  const toolName = extractToolName(blockObj)
  const toolInput = extractToolInput(blockObj)
  if (toolUseId) {
    bridge.registerToolUse(toolUseId, toolName, toolInput)
  }
  bridge.emitPreToolUse(toolName, toolInput, toolUseId)
}

function processToolResultBlock(blockObj: Record<string, unknown>, bridge: HooksBridge): void {
  const toolUseId = resolveToolUseId(blockObj)
  const toolMeta = toolUseId ? bridge.getToolUse(toolUseId) : undefined
  const toolName = toolMeta?.name ?? extractToolName(blockObj)
  const toolInput = toolMeta?.input ?? extractToolInput(blockObj)
  const isError = isToolResultError(blockObj)
  const { blocks: resultBlocks, text } = normalizeToolResultBlocks(blockObj['content'])
  const toolResponse: Record<string, unknown> = {}
  if (resultBlocks.length > 0) toolResponse['content'] = resultBlocks
  if (text) toolResponse['stdout'] = text
  const structuredContent = extractStructuredContent(blockObj)
  if (structuredContent !== undefined) {
    toolResponse['structured_content'] = structuredContent
  }

  bridge.emitPostToolUse(toolName, toolInput, toolResponse, toolUseId, isError)
  bridge.clearToolUse(toolUseId)
}

function emitUserToolResultIfNeeded(
  msg: Record<string, unknown>,
  msgType: string | undefined,
  sawToolResultBlock: boolean,
  bridge: HooksBridge
): void {
  if (!isSynthesizableUserToolResult(msg, msgType, sawToolResultBlock)) {
    return
  }
  const toolUseId = msg['parent_tool_use_id'] as string
  const toolMeta = bridge.getToolUse(toolUseId)
  const toolName = toolMeta?.name ?? 'tool'
  const toolInput = toolMeta?.input
  const toolResponse = msg['tool_use_result'] as unknown
  bridge.emitPostToolUse(toolName, toolInput, toolResponse, toolUseId)
  bridge.clearToolUse(toolUseId)
}
