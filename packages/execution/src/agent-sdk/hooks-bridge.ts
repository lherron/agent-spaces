import type { PermissionHandler } from '../session/permissions.js'

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

      const permissionHandler = this.permissionHandler
      if (permissionHandler) {
        if (permissionHandler.isAutoAllowed(toolName)) {
          this.emitPreToolUse(toolName, toolInput, toolUseId)
          return { behavior: 'allow', updatedInput: toolInput }
        }

        this.emitPreToolUse(toolName, toolInput, toolUseId)
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
          message: response.reason ?? 'Permission denied',
        }
      }

      if (!this.hookEventBus) {
        return { behavior: 'allow', updatedInput: toolInput }
      }

      // Check if tool is auto-allowed by policy
      if (this.hookEventBus.isToolAutoAllowed(this.ownerId, toolName)) {
        // Still emit PreToolUse for progress tracking
        this.emitPreToolUse(toolName, toolInput, toolUseId)
        return { behavior: 'allow', updatedInput: toolInput }
      }

      // Request permission via HookEventBus
      const hook = this.buildPreToolUseHook(toolName, toolInput, toolUseId)
      const response = await this.hookEventBus.requestPermission(this.ownerId, hook)

      if (response.decision === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: (response.updatedInput as Record<string, unknown>) ?? toolInput,
        }
      }
      if (response.interrupt === undefined) {
        return {
          behavior: 'deny',
          message: response.message ?? 'Permission denied',
        }
      }
      return {
        behavior: 'deny',
        message: response.message ?? 'Permission denied',
        interrupt: response.interrupt,
      }
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
    return `sdk-tool-${++this.currentToolUseId}`
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
  let sawToolResultBlock = false
  if (content) {
    const blocks = Array.isArray(content) ? content : [content]

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const blockObj = block as Record<string, unknown>
      const blockType = typeof blockObj['type'] === 'string' ? blockObj['type'] : undefined

      if (blockType === 'tool_use') {
        processToolUseBlock(blockObj, bridge)
        continue
      }

      if (blockType === 'tool_result') {
        sawToolResultBlock = true
        processToolResultBlock(blockObj, bridge)
      }
    }
  }

  emitUserToolResultIfNeeded(msg, msgType, sawToolResultBlock, bridge)

  // Note: result messages are handled by AgentSession.listenToOutput()
  // which extracts the response text and emits Stop with last_response
}

function processToolUseBlock(blockObj: Record<string, unknown>, bridge: HooksBridge): void {
  const toolUseId = resolveToolUseId(blockObj)
  const toolName =
    typeof blockObj['name'] === 'string'
      ? blockObj['name']
      : typeof blockObj['tool_name'] === 'string'
        ? blockObj['tool_name']
        : 'tool'
  const toolInput =
    'input' in blockObj
      ? blockObj['input']
      : 'tool_input' in blockObj
        ? blockObj['tool_input']
        : undefined
  if (toolUseId) {
    bridge.registerToolUse(toolUseId, toolName, toolInput)
  }
  bridge.emitPreToolUse(toolName, toolInput, toolUseId)
}

function processToolResultBlock(blockObj: Record<string, unknown>, bridge: HooksBridge): void {
  const toolUseId = resolveToolUseId(blockObj)
  const toolMeta = toolUseId ? bridge.getToolUse(toolUseId) : undefined
  const toolName =
    toolMeta?.name ??
    (typeof blockObj['tool_name'] === 'string'
      ? blockObj['tool_name']
      : typeof blockObj['name'] === 'string'
        ? blockObj['name']
        : 'tool')
  const toolInput =
    toolMeta?.input ??
    ('tool_input' in blockObj
      ? blockObj['tool_input']
      : 'input' in blockObj
        ? blockObj['input']
        : undefined)
  const isError = blockObj['is_error'] === true || blockObj['isError'] === true ? true : undefined
  const { blocks: resultBlocks, text } = normalizeToolResultBlocks(blockObj['content'])
  const toolResponse: Record<string, unknown> = {}
  if (resultBlocks.length > 0) toolResponse['content'] = resultBlocks
  if (text) toolResponse['stdout'] = text
  if (blockObj['structuredContent'] !== undefined) {
    toolResponse['structured_content'] = blockObj['structuredContent']
  } else if (blockObj['structured_content'] !== undefined) {
    toolResponse['structured_content'] = blockObj['structured_content']
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
  if (
    msgType !== 'user' ||
    sawToolResultBlock ||
    typeof msg['parent_tool_use_id'] !== 'string' ||
    msg['tool_use_result'] === undefined
  ) {
    return
  }
  const toolUseId = msg['parent_tool_use_id']
  const toolMeta = bridge.getToolUse(toolUseId)
  const toolName = toolMeta?.name ?? 'tool'
  const toolInput = toolMeta?.input
  const toolResponse = msg['tool_use_result'] as unknown
  bridge.emitPostToolUse(toolName, toolInput, toolResponse, toolUseId)
  bridge.clearToolUse(toolUseId)
}

function resolveToolUseId(blockObj: Record<string, unknown>): string | undefined {
  if (typeof blockObj['tool_use_id'] === 'string') return blockObj['tool_use_id']
  if (typeof blockObj['toolUseId'] === 'string') return blockObj['toolUseId']
  if (typeof blockObj['id'] === 'string') return blockObj['id']
  return undefined
}

type RexContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'media_ref'; url: string; mimeType?: string; filename?: string; alt?: string }

function normalizeToolResultBlocks(content: unknown): { blocks: RexContentBlock[]; text: string } {
  const blocks: RexContentBlock[] = []
  const textParts: string[] = []
  if (content === undefined || content === null) {
    return { blocks, text: '' }
  }

  const items = Array.isArray(content) ? content : [content]
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      const text = typeof item === 'string' ? item : String(item)
      if (text) {
        blocks.push({ type: 'text', text })
        textParts.push(text)
      }
      continue
    }

    const block = item as Record<string, unknown>
    const type = typeof block['type'] === 'string' ? block['type'] : undefined

    if (type === 'text' && typeof block['text'] === 'string') {
      blocks.push({ type: 'text', text: block['text'] })
      textParts.push(block['text'])
      continue
    }

    if (
      type === 'image' &&
      typeof block['data'] === 'string' &&
      typeof block['mimeType'] === 'string'
    ) {
      blocks.push({ type: 'image', data: block['data'], mimeType: block['mimeType'] })
      continue
    }

    if (type === 'media_ref' && typeof block['url'] === 'string') {
      const entry: RexContentBlock = { type: 'media_ref', url: block['url'] }
      if (typeof block['mimeType'] === 'string') entry.mimeType = block['mimeType']
      if (typeof block['filename'] === 'string') entry.filename = block['filename']
      if (typeof block['alt'] === 'string') entry.alt = block['alt']
      blocks.push(entry)
      continue
    }

    if (type === 'resource_link' && typeof block['uri'] === 'string') {
      const entry: RexContentBlock = { type: 'media_ref', url: block['uri'] }
      if (typeof block['mimeType'] === 'string') entry.mimeType = block['mimeType']
      if (typeof block['filename'] === 'string') entry.filename = block['filename']
      if (typeof block['alt'] === 'string') entry.alt = block['alt']
      blocks.push(entry)
      continue
    }

    if (type === 'resource' && block['resource'] && typeof block['resource'] === 'object') {
      const resource = block['resource'] as Record<string, unknown>
      if (typeof resource['text'] === 'string') {
        blocks.push({ type: 'text', text: resource['text'] })
        textParts.push(resource['text'])
        continue
      }
      if (
        typeof resource['blob'] === 'string' &&
        typeof block['mimeType'] === 'string' &&
        block['mimeType'].startsWith('image/')
      ) {
        blocks.push({
          type: 'image',
          data: resource['blob'],
          mimeType: block['mimeType'],
        })
      }
    }
  }

  return { blocks, text: textParts.join('') }
}
