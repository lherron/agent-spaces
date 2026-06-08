/**
 * Named constants for the Pi SDK agent-session event-type strings and the
 * hook-event-name strings they map to. Centralizing these avoids scattered
 * string literals (which are typo-prone and hard to grep) while keeping the
 * exact runtime values that the SDK and the hook event bus expect.
 */

/** Pi SDK `AgentSession` event `type` discriminators. */
export const PI_EVENT = {
  AGENT_START: 'agent_start',
  AGENT_END: 'agent_end',
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  MESSAGE_START: 'message_start',
  MESSAGE_UPDATE: 'message_update',
  MESSAGE_END: 'message_end',
  TOOL_EXECUTION_START: 'tool_execution_start',
  TOOL_EXECUTION_UPDATE: 'tool_execution_update',
  TOOL_EXECUTION_END: 'tool_execution_end',
} as const

/** Hook-event names emitted to the hook event bus for lifecycle/tool events. */
export const HOOK_EVENT = {
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  STOP: 'Stop',
  SESSION_END: 'SessionEnd',
} as const
