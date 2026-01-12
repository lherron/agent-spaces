/**
 * hooks.toml parser and translator
 *
 * WHY: hooks.toml provides a harness-agnostic way to declare hooks.
 * This module parses hooks.toml and translates it to harness-specific formats:
 * - Claude: generates hooks/hooks.json with Claude event names
 * - Pi: generates hook definitions for the hook bridge extension
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import TOML from '@iarna/toml'

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
  session_end: 'Stop',
  // Claude doesn't have session_start equivalent via hooks
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
        tools: Array.isArray(hook['tools']) ? (hook['tools'] as string[]) : undefined,
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
    const file = Bun.file(hooksTomlPath)
    if (!(await file.exists())) {
      return null
    }
    const content = await file.text()
    return parseHooksToml(content)
  } catch {
    return null
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
 * @param harnessId - Harness ID to filter for ('claude' or 'pi')
 * @returns Filtered hooks applicable to the harness
 */
export function filterHooksForHarness(
  hooks: CanonicalHookDefinition[],
  harnessId: 'claude' | 'pi'
): CanonicalHookDefinition[] {
  return hooks.filter((h) => !h.harness || h.harness === harnessId)
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
export function toClaudeHooksConfig(hooks: CanonicalHookDefinition[]): ClaudeHooksConfig {
  // Filter for Claude-applicable hooks
  const claudeHooks = filterHooksForHarness(hooks, 'claude')

  // Group hooks by Claude event and matcher
  const hooksByEvent = new Map<string, Map<string | undefined, CanonicalHookDefinition[]>>()

  for (const hook of claudeHooks) {
    const claudeEvent = translateToClaudeEvent(hook.event)
    if (!claudeEvent) {
      // Skip hooks that don't map to Claude events
      continue
    }

    const matcher = CLAUDE_TOOL_EVENTS.has(claudeEvent) ? buildClaudeMatcher(hook.tools) : undefined
    const eventMap =
      hooksByEvent.get(claudeEvent) ?? new Map<string | undefined, CanonicalHookDefinition[]>()
    const existing = eventMap.get(matcher) ?? []
    existing.push(hook)
    eventMap.set(matcher, existing)
    hooksByEvent.set(claudeEvent, eventMap)
  }

  // Convert to Claude hooks.json format
  const result: ClaudeHooksConfig = { hooks: {} }

  for (const [eventName, matcherHooks] of hooksByEvent) {
    const eventEntries: ClaudeHookDefinition[] = []
    for (const [matcher, eventHooks] of matcherHooks) {
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
      eventEntries.push(entry)
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
  await Bun.write(hooksJsonPath, content)
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles multiple hook formats for backwards compatibility
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
    const file = Bun.file(hooksJsonPath)
    if (await file.exists()) {
      const content = await file.json()

      // Handle legacy hooks.json formats
      if (Array.isArray(content.hooks)) {
        // Simple array format: {hooks: [{event, script}, ...]}
        const hooks: CanonicalHookDefinition[] = content.hooks.map(
          (h: Record<string, unknown>) => ({
            event: String(h['event'] ?? h['matcher'] ?? ''),
            script: String(h['script'] ?? ''),
            tools: Array.isArray(h['tools']) ? (h['tools'] as string[]) : undefined,
            blocking: typeof h['blocking'] === 'boolean' ? h['blocking'] : undefined,
          })
        )
        return {
          hooks,
          source: 'json',
          sourcePath: hooksJsonPath,
        }
      }

      // Claude's native format: {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}}
      if (content.hooks && typeof content.hooks === 'object' && !Array.isArray(content.hooks)) {
        const hooks: CanonicalHookDefinition[] = []
        for (const [eventName, eventHooks] of Object.entries(content.hooks)) {
          if (Array.isArray(eventHooks)) {
            for (const hookDef of eventHooks as Array<{
              matcher?: string
              hooks?: Array<{ command?: string; type?: string }>
            }>) {
              // Extract command from nested hooks array
              const commands = hookDef.hooks ?? []
              for (const cmd of commands) {
                if (cmd.command) {
                  // Convert Claude command path to script path
                  // ${CLAUDE_PLUGIN_ROOT}/hooks/script.sh -> hooks/script.sh
                  const script = cmd.command.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '')
                  hooks.push({
                    event: eventName
                      .toLowerCase()
                      .replace(/([a-z])([A-Z])/g, '$1_$2')
                      .toLowerCase(),
                    script,
                    tools: hookDef.matcher ? [hookDef.matcher] : undefined,
                  })
                }
              }
            }
          }
        }
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
