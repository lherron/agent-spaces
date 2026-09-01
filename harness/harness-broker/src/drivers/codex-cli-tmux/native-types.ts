/**
 * Codex CLI hook vocabulary (T-07853 §6.1).
 *
 * The broker writes Codex's hook configuration itself, so this is the complete
 * set of names it can receive; anything else means the harness started firing a
 * hook the broker never registered, which must fail loudly rather than be
 * dropped.
 */
export const CODEX_CLI_KNOWN_HOOK_NAMES: ReadonlySet<string> = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PermissionRequest',
])
