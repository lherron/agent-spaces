/**
 * Pi hook vocabulary (T-07853 §6.1). Pi reports its own event name under
 * `eventName`; the broker registers this set, so anything outside it is
 * vocabulary drift.
 */
export const PI_KNOWN_HOOK_NAMES: ReadonlySet<string> = new Set([
  'session_start',
  'session_shutdown',
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
])
