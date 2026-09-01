/**
 * Pi hook vocabulary (T-07853 §6.1).
 *
 * ENUMERATED FROM A REAL SESSION, not from reading the normalizer. The first
 * live pi-tui-tmux smoke run against this code fired `before_agent_start` and
 * `message_start` — two names the broker's normalizer ignores and that a
 * source-read table therefore missed entirely. Pi reports its own event name
 * under `eventName` (falling back to `type`).
 */
export const PI_KNOWN_HOOK_NAMES: ReadonlySet<string> = new Set([
  'session_start',
  'session_shutdown',
  'before_agent_start',
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
])
