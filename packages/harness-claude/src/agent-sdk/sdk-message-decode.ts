/**
 * Shared decoding helpers for Claude Agent SDK messages.
 *
 * WHY: SDK output messages arrive as loosely-typed `Record<string, unknown>`
 * objects whose content blocks (`text`, `image`, `media_ref`, `resource_link`,
 * `resource`, `tool_use`, `tool_result`) must be normalized into the unified
 * session/content vocabulary. This logic was previously copy-pasted (and had
 * already started to drift) between `agent-session.ts` and `hooks-bridge.ts`.
 * Centralizing it here gives both consumers a single source of truth and a
 * single place to add support for a new block type.
 */

import type { ContentBlock } from 'spaces-runtime'

/**
 * Resolve a tool-use id from a block/message, tolerating the several casings
 * the SDK has used (`tool_use_id`, `toolUseId`, `id`).
 */
export function resolveToolUseId(blockObj: Record<string, unknown>): string | undefined {
  if (typeof blockObj['tool_use_id'] === 'string') return blockObj['tool_use_id']
  if (typeof blockObj['toolUseId'] === 'string') return blockObj['toolUseId']
  if (typeof blockObj['id'] === 'string') return blockObj['id']
  return undefined
}

/**
 * Extract a tool name from a block/message, falling back through the casings
 * the SDK has used (`name`, `tool_name`) and finally a literal `'tool'`.
 */
export function extractToolName(blockObj: Record<string, unknown>): string {
  if (typeof blockObj['name'] === 'string') return blockObj['name']
  if (typeof blockObj['tool_name'] === 'string') return blockObj['tool_name']
  return 'tool'
}

/**
 * Extract a tool input payload from a block/message, tolerating `input` and
 * `tool_input` keys.
 */
export function extractToolInput(blockObj: Record<string, unknown>): unknown {
  if ('input' in blockObj) return blockObj['input']
  if ('tool_input' in blockObj) return blockObj['tool_input']
  return undefined
}

/**
 * Whether a tool-result block carries an error flag (either casing).
 */
export function isToolResultError(blockObj: Record<string, unknown>): true | undefined {
  return blockObj['is_error'] === true || blockObj['isError'] === true ? true : undefined
}

/**
 * Read the structured-content payload from a tool-result block, tolerating
 * both `structuredContent` (camel) and `structured_content` (snake).
 */
export function extractStructuredContent(blockObj: Record<string, unknown>): unknown {
  if (blockObj['structuredContent'] !== undefined) return blockObj['structuredContent']
  if (blockObj['structured_content'] !== undefined) return blockObj['structured_content']
  return undefined
}

/**
 * Coerce an arbitrary tool input into a `Record<string, unknown>` shape.
 */
export function normalizeToolInput(toolInput: unknown): Record<string, unknown> {
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    return toolInput as Record<string, unknown>
  }
  if (toolInput === undefined) return {}
  return { value: toolInput }
}

/**
 * A handler converts a single SDK content block into a unified `ContentBlock`
 * (or `undefined` to skip it). The handler may also append plain text to
 * `textParts` so callers can recover a flattened string representation.
 */
type BlockHandler = (
  block: Record<string, unknown>,
  textParts: string[]
) => ContentBlock | undefined

/**
 * Handler table keyed by SDK block `type`. Adding support for a new block kind
 * is a single new entry here rather than an `if (type === ...)` arm scattered
 * across multiple functions.
 */
const TOOL_RESULT_BLOCK_HANDLERS: Record<string, BlockHandler> = {
  text: (block, textParts) => {
    if (typeof block['text'] !== 'string') return undefined
    textParts.push(block['text'])
    return { type: 'text', text: block['text'] }
  },
  image: (block) => {
    if (typeof block['data'] !== 'string' || typeof block['mimeType'] !== 'string') {
      return undefined
    }
    return { type: 'image', data: block['data'], mimeType: block['mimeType'] }
  },
  media_ref: (block) => mediaRefFromUrlKey(block, 'url'),
  resource_link: (block) => mediaRefFromUrlKey(block, 'uri'),
  resource: (block, textParts) => {
    const resource = block['resource']
    if (!resource || typeof resource !== 'object') return undefined
    const resourceObj = resource as Record<string, unknown>
    if (typeof resourceObj['text'] === 'string') {
      textParts.push(resourceObj['text'])
      return { type: 'text', text: resourceObj['text'] }
    }
    if (
      typeof resourceObj['blob'] === 'string' &&
      typeof block['mimeType'] === 'string' &&
      block['mimeType'].startsWith('image/')
    ) {
      return { type: 'image', data: resourceObj['blob'], mimeType: block['mimeType'] }
    }
    return undefined
  },
}

function mediaRefFromUrlKey(
  block: Record<string, unknown>,
  urlKey: 'url' | 'uri'
): ContentBlock | undefined {
  const url = block[urlKey]
  if (typeof url !== 'string') return undefined
  const entry: ContentBlock = { type: 'media_ref', url }
  if (typeof block['mimeType'] === 'string') entry.mimeType = block['mimeType']
  if (typeof block['filename'] === 'string') entry.filename = block['filename']
  if (typeof block['alt'] === 'string') entry.alt = block['alt']
  return entry
}

/**
 * Normalize the `content` of a tool-result block into unified content blocks
 * plus a flattened text representation.
 */
export function normalizeToolResultBlocks(content: unknown): {
  blocks: ContentBlock[]
  text: string
} {
  const blocks: ContentBlock[] = []
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
    const handler = type ? TOOL_RESULT_BLOCK_HANDLERS[type] : undefined
    const result = handler?.(block, textParts)
    if (result) blocks.push(result)
  }

  return { blocks, text: textParts.join('') }
}

/**
 * Convert a single non-tool SDK content block (`text`, `image`, `media_ref`,
 * `resource_link`, `resource`) into a unified `ContentBlock`, or `undefined`
 * for unrecognized/tool blocks. Adding a new content-block kind is a single new
 * entry in the handler table rather than a new arm in every decode function.
 */
export function convertContentBlock(block: Record<string, unknown>): ContentBlock | undefined {
  const type = typeof block['type'] === 'string' ? block['type'] : undefined
  const handler = type ? TOOL_RESULT_BLOCK_HANDLERS[type] : undefined
  // textParts is unused by callers that only want the converted block.
  return handler?.(block, [])
}

export interface ToolBlockVisitor {
  onToolUse?: (block: Record<string, unknown>) => void
  onToolResult?: (block: Record<string, unknown>) => void
}

/**
 * Walk the `content` of an assistant/user message, invoking the visitor for
 * each `tool_use`/`tool_result` block. Returns whether any `tool_result` block
 * was seen (callers use this to decide whether to synthesize a tool result
 * from `tool_use_result`).
 */
export function forEachToolBlock(content: unknown, visitor: ToolBlockVisitor): boolean {
  if (!content) return false
  const blocks = Array.isArray(content) ? content : [content]
  let sawToolResultBlock = false

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const blockObj = block as Record<string, unknown>
    const blockType = typeof blockObj['type'] === 'string' ? blockObj['type'] : undefined

    if (blockType === 'tool_use') {
      visitor.onToolUse?.(blockObj)
      continue
    }

    if (blockType === 'tool_result') {
      sawToolResultBlock = true
      visitor.onToolResult?.(blockObj)
    }
  }

  return sawToolResultBlock
}
