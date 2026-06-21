/**
 * hooks.toml parser and translator
 *
 * WHY: hooks.toml provides a harness-agnostic way to declare hooks.
 * This module parses hooks.toml and translates it to harness-specific formats:
 * - Claude: generates hooks/hooks.json with Claude event names
 * - Pi: generates hook definitions for the hook bridge extension
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import TOML from '@iarna/toml'
import type { HarnessId } from '../core/types/harness.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Canonical hook definition from hooks.toml.
 *
 * This is the harness-agnostic format that gets translated per-harness.
 */
export interface CanonicalHookDefinition {
  /** Abstract event name (pre_tool_use, post_tool_use, session_start, session_end) */
  event: string
  /** Path to script relative to space root */
  script: string
  /** Optional: filter to specific tools (e.g., ["Bash", "Write"]) */
  tools?: string[] | undefined
  /** Optional: matcher for non-tool events (e.g., "compact" for session_start, "auto" for pre_compact) */
  matcher?: string | undefined
  /** Optional: whether hook should attempt to block (semantics vary by harness) */
  blocking?: boolean | undefined
  /** Optional: harness-specific hook (only runs on specified harness) */
  harness?: string | undefined
}

/**
 * Parsed hooks.toml configuration.
 */
export interface HooksTomlConfig {
  /** Array of hook definitions */
  hook: CanonicalHookDefinition[]
}

/**
 * Claude hook command configuration.
 */
export interface ClaudeHookCommand {
  /** Hook type (currently only "command") */
  type: 'command'
  /** Command path using ${CLAUDE_PLUGIN_ROOT} */
  command: string
  /** Optional timeout in seconds */
  timeout?: number | undefined
}

/**
 * Claude hook matcher configuration.
 */
export interface ClaudeHookDefinition {
  /** Optional matcher (tool pattern) */
  matcher?: string | undefined
  /** Array of hook configurations */
  hooks: ClaudeHookCommand[]
}

/**
 * Claude hooks.json format.
 */
export interface ClaudeHooksConfig {
  /** Optional description for plugin hooks */
  description?: string | undefined
  /** Hook definitions keyed by Claude event name */
  hooks: Record<string, ClaudeHookDefinition[]>
}

// ============================================================================
// Constants
// ============================================================================

/** Filename for hooks.toml */
export const HOOKS_TOML_FILENAME = 'hooks.toml'

/** Filename for hooks.json (legacy format) */
export const HOOKS_JSON_FILENAME = 'hooks.json'

/**
 * Event mapping from abstract event names to Claude event names.
 */
export const ABSTRACT_TO_CLAUDE_EVENTS: Record<string, string> = {
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  post_tool_use_failure: 'PostToolUseFailure',
  permission_request: 'PermissionRequest',
  notification: 'Notification',
  user_prompt_submit: 'UserPromptSubmit',
  stop: 'Stop',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  pre_compact: 'PreCompact',
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
}

/**
 * Event mapping from abstract event names to Pi event names.
 */
export const ABSTRACT_TO_PI_EVENTS: Record<string, string> = {
  pre_tool_use: 'tool_call',
  post_tool_use: 'tool_result',
  session_start: 'session_start',
  session_end: 'session_end',
}

const CLAUDE_TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])

function buildClaudeMatcher(tools?: string[] | undefined): string {
  if (!tools || tools.length === 0) {
    return '*'
  }
  if (tools.includes('*')) {
    return '*'
  }
  return tools.join('|')
}

// ============================================================================
// Parsing
// ============================================================================

/** Narrow a parsed value to a string array, or undefined when not an array. */
function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v as string[]) : undefined
}

/**
 * Parse hooks.toml content.
 *
 * @param content - Raw TOML string content
 * @returns Parsed hooks configuration
 * @throws Error if parsing fails
 */
export function parseHooksToml(content: string): HooksTomlConfig {
  const parsed = TOML.parse(content) as unknown as { hook?: unknown[] }

  // Ensure hook is an array
  const hookArray = Array.isArray(parsed.hook) ? parsed.hook : []

  return {
    hook: hookArray.map((h) => {
      const hook = h as Record<string, unknown>
      return {
        event: String(hook['event'] ?? ''),
        script: String(hook['script'] ?? ''),
        tools: asStringArray(hook['tools']),
        matcher: typeof hook['matcher'] === 'string' ? hook['matcher'] : undefined,
        blocking: typeof hook['blocking'] === 'boolean' ? hook['blocking'] : undefined,
        harness: typeof hook['harness'] === 'string' ? hook['harness'] : undefined,
      }
    }),
  }
}

/**
 * Read and parse hooks.toml from a hooks directory.
 *
 * @param hooksDir - Path to the hooks directory
 * @returns Parsed hooks configuration, or null if hooks.toml doesn't exist
 */
export async function readHooksToml(hooksDir: string): Promise<HooksTomlConfig | null> {
  const hooksTomlPath = join(hooksDir, HOOKS_TOML_FILENAME)

  try {
    const content = await readFile(hooksTomlPath, 'utf8')
    return parseHooksToml(content)
  } catch (err) {
    // A missing hooks.toml is the common, optional case — treat as "none".
    // Any other error (parse failure, IO error) is real and must surface per the
    // repo's "never silently capture errors" policy (mirrors readPermissionsToml).
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * Check if hooks.toml exists in a hooks directory.
 *
 * @param hooksDir - Path to the hooks directory
 * @returns True if hooks.toml exists
 */
export async function hooksTomlExists(hooksDir: string): Promise<boolean> {
  const hooksTomlPath = join(hooksDir, HOOKS_TOML_FILENAME)
  try {
    const stats = await stat(hooksTomlPath)
    return stats.isFile()
  } catch {
    return false
  }
}

// ============================================================================
// Translation: hooks.toml -> Claude hooks.json
// ============================================================================

/**
 * Filter hooks for a specific harness.
 *
 * Returns hooks that:
 * - Have no harness specified (universal hooks)
 * - Match the specified harness
 *
 * @param hooks - Array of canonical hook definitions
 * @param harnessId - Harness ID to filter for (Claude- or Pi-compatible)
 * @returns Filtered hooks applicable to the harness
 */
function normalizeHarnessForHooks(harnessId: HarnessId): 'claude' | 'pi' {
  return harnessId === 'pi' || harnessId === 'pi-sdk' ? 'pi' : 'claude'
}

function normalizeHookHarness(harness?: string): string | undefined {
  if (!harness) return undefined
  if (harness === 'claude-agent-sdk') return 'claude'
  if (harness === 'pi-sdk') return 'pi'
  return harness
}

export function filterHooksForHarness(
  hooks: CanonicalHookDefinition[],
  harnessId: HarnessId
): CanonicalHookDefinition[] {
  const normalized = normalizeHarnessForHooks(harnessId)
  return hooks.filter((h) => !h.harness || normalizeHookHarness(h.harness) === normalized)
}

/**
 * Translate abstract event name to Claude event name.
 *
 * @param abstractEvent - Abstract event name (e.g., 'pre_tool_use')
 * @returns Claude event name (e.g., 'PreToolUse'), or null if no mapping
 */
export function translateToClaudeEvent(abstractEvent: string): string | null {
  return ABSTRACT_TO_CLAUDE_EVENTS[abstractEvent] ?? null
}

/**
 * Translate abstract event name to Pi event name.
 *
 * @param abstractEvent - Abstract event name (e.g., 'pre_tool_use')
 * @returns Pi event name (e.g., 'tool_call'), or the original if no mapping
 */
export function translateToPiEvent(abstractEvent: string): string {
  return ABSTRACT_TO_PI_EVENTS[abstractEvent] ?? abstractEvent
}

/**
 * Convert canonical hooks to Claude hooks.json format.
 *
 * @param hooks - Array of canonical hook definitions
 * @returns Claude hooks.json configuration
 */
/**
 * Group Claude-applicable hooks by Claude event name, then by matcher.
 *
 * Hooks whose abstract event has no Claude mapping are skipped. Tool events
 * derive their matcher from `hook.tools`; other events use `hook.matcher`.
 */
function groupHooksByEventAndMatcher(
  claudeHooks: CanonicalHookDefinition[]
): Map<string, Map<string | undefined, CanonicalHookDefinition[]>> {
  const hooksByEvent = new Map<string, Map<string | undefined, CanonicalHookDefinition[]>>()

  for (const hook of claudeHooks) {
    const claudeEvent = translateToClaudeEvent(hook.event)
    if (!claudeEvent) {
      // Skip hooks that don't map to Claude events
      continue
    }

    const matcher = CLAUDE_TOOL_EVENTS.has(claudeEvent)
      ? buildClaudeMatcher(hook.tools)
      : (hook.matcher ?? undefined)
    const eventMap =
      hooksByEvent.get(claudeEvent) ?? new Map<string | undefined, CanonicalHookDefinition[]>()
    const existing = eventMap.get(matcher) ?? []
    existing.push(hook)
    eventMap.set(matcher, existing)
    hooksByEvent.set(claudeEvent, eventMap)
  }

  return hooksByEvent
}

/**
 * Build the Claude hook definition entry for a single matcher group.
 */
function buildClaudeEventEntry(
  matcher: string | undefined,
  eventHooks: CanonicalHookDefinition[]
): ClaudeHookDefinition {
  const entry: ClaudeHookDefinition = {
    hooks: eventHooks.map((h) => ({
      type: 'command',
      // Use ${CLAUDE_PLUGIN_ROOT} for portable script paths
      command: `\${CLAUDE_PLUGIN_ROOT}/${h.script}`,
    })),
  }
  if (matcher) {
    entry.matcher = matcher
  }
  return entry
}

export function toClaudeHooksConfig(hooks: CanonicalHookDefinition[]): ClaudeHooksConfig {
  // Filter for Claude-applicable hooks, then group by event and matcher.
  const claudeHooks = filterHooksForHarness(hooks, 'claude')
  const hooksByEvent = groupHooksByEventAndMatcher(claudeHooks)

  // Convert to Claude hooks.json format
  const result: ClaudeHooksConfig = { hooks: {} }

  for (const [eventName, matcherHooks] of hooksByEvent) {
    const eventEntries: ClaudeHookDefinition[] = []
    for (const [matcher, eventHooks] of matcherHooks) {
      eventEntries.push(buildClaudeEventEntry(matcher, eventHooks))
    }
    result.hooks[eventName] = eventEntries
  }

  return result
}

/**
 * Generate Claude hooks.json content from canonical hooks.
 *
 * @param hooks - Array of canonical hook definitions
 * @returns JSON string for hooks.json
 */
export function generateClaudeHooksJson(hooks: CanonicalHookDefinition[]): string {
  const config = toClaudeHooksConfig(hooks)
  return JSON.stringify(config, null, 2)
}

/**
 * Write Claude hooks.json to a hooks directory.
 *
 * @param hooks - Array of canonical hook definitions
 * @param hooksDir - Path to the hooks directory
 */
export async function writeClaudeHooksJson(
  hooks: CanonicalHookDefinition[],
  hooksDir: string
): Promise<void> {
  const content = generateClaudeHooksJson(hooks)
  const hooksJsonPath = join(hooksDir, HOOKS_JSON_FILENAME)
  await writeFile(hooksJsonPath, content, 'utf8')
}

// ============================================================================
// Combined read with precedence
// ============================================================================

/**
 * Result of reading hooks configuration.
 */
export interface ReadHooksResult {
  /** Parsed hooks as canonical definitions */
  hooks: CanonicalHookDefinition[]
  /** Which source was used: 'toml', 'json', or 'none' */
  source: 'toml' | 'json' | 'none'
  /** Path to the source file */
  sourcePath?: string | undefined
}

/**
 * Read hooks configuration from a hooks directory, preferring hooks.toml over hooks.json.
 *
 * Priority:
 * 1. hooks.toml (canonical harness-agnostic format)
 * 2. hooks.json (legacy Claude-specific format)
 *
 * @param hooksDir - Path to the hooks directory
 * @returns Parsed hooks with source information
 */
/**
 * Convert a Claude command path to a relative script path.
 * `${CLAUDE_PLUGIN_ROOT}/hooks/script.sh` -> `hooks/script.sh`
 */
function claudeCommandToScript(command: string): string {
  return command.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '')
}

/** Normalize a Claude PascalCase event name (e.g. `PreToolUse`) to `pre_tool_use`. */
function claudeEventToCanonical(eventName: string): string {
  return eventName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
}

/**
 * Flatten Claude's native nested hooks format into canonical definitions.
 *
 * Native shape: `{ PreToolUse: [{ matcher, hooks: [{ type, command }] }] }`.
 */
function flattenClaudeNativeHooks(hooksValue: Record<string, unknown>): CanonicalHookDefinition[] {
  const hooks: CanonicalHookDefinition[] = []

  for (const [eventName, eventHooks] of Object.entries(hooksValue)) {
    if (!Array.isArray(eventHooks)) continue

    const event = claudeEventToCanonical(eventName)
    for (const hookDef of eventHooks as Array<{
      matcher?: string
      hooks?: Array<{ command?: string; type?: string }>
    }>) {
      for (const cmd of hookDef.hooks ?? []) {
        if (!cmd.command) continue
        hooks.push({
          event,
          script: claudeCommandToScript(cmd.command),
          tools: hookDef.matcher ? [hookDef.matcher] : undefined,
        })
      }
    }
  }

  return hooks
}

export async function readHooksWithPrecedence(hooksDir: string): Promise<ReadHooksResult> {
  // Try hooks.toml first
  const tomlConfig = await readHooksToml(hooksDir)
  if (tomlConfig) {
    return {
      hooks: tomlConfig.hook,
      source: 'toml',
      sourcePath: join(hooksDir, HOOKS_TOML_FILENAME),
    }
  }

  // Fall back to hooks.json
  const hooksJsonPath = join(hooksDir, HOOKS_JSON_FILENAME)
  try {
    const content = await readFile(hooksJsonPath, 'utf8')
    if (content.length > 0) {
      const parsed = JSON.parse(content) as Record<string, unknown>

      const hooksValue = parsed['hooks']

      // Handle legacy hooks.json formats
      if (Array.isArray(hooksValue)) {
        // Simple array format: {hooks: [{event, script}, ...]}
        const hooks: CanonicalHookDefinition[] = hooksValue.map((h) => {
          const entry = h as Record<string, unknown>
          return {
            event: String(entry['event'] ?? entry['matcher'] ?? ''),
            script: String(entry['script'] ?? ''),
            tools: asStringArray(entry['tools']),
            blocking: typeof entry['blocking'] === 'boolean' ? entry['blocking'] : undefined,
          }
        })
        return {
          hooks,
          source: 'json',
          sourcePath: hooksJsonPath,
        }
      }

      // Claude's native format: {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}}
      if (hooksValue && typeof hooksValue === 'object' && !Array.isArray(hooksValue)) {
        const hooks = flattenClaudeNativeHooks(hooksValue as Record<string, unknown>)
        if (hooks.length > 0) {
          return {
            hooks,
            source: 'json',
            sourcePath: hooksJsonPath,
          }
        }
      }
    }
  } catch {
    // Invalid JSON or other error
  }

  return {
    hooks: [],
    source: 'none',
  }
}
