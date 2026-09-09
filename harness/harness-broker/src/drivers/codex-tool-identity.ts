import type { ToolCallId } from 'spaces-harness-broker-protocol'

const COMMAND_ITEM_TYPES = new Set(['commandExecution', 'CommandExecution'])

/**
 * Identity/name semantics genuinely shared by Codex transports.
 *
 * Lifecycle, timestamps, input and result stay with the adapter that observed
 * them. In particular, this helper does not turn a completed rollout item into
 * a start or equate code-mode orchestration with a child command execution.
 */
export function codexNativeToolIdentity(
  nativeType: string,
  item: Record<string, unknown>,
  fallbackName: string
): { itemId: string; toolCallId: ToolCallId; name: string } | undefined {
  const itemId = typeof item['id'] === 'string' ? item['id'] : undefined
  if (itemId === undefined || itemId.length === 0) return undefined
  return {
    itemId,
    toolCallId: itemId as ToolCallId,
    name:
      COMMAND_ITEM_TYPES.has(nativeType) && fallbackName === nativeType ? 'command' : fallbackName,
  }
}
