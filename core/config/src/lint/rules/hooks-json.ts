/**
 * hooks.json parsing helpers for lint rules.
 *
 * WHY: Lint rules need to handle multiple hooks.json formats:
 * - Simple array format: { hooks: [{ event, script }, ...] }
 * - Claude array format: { hooks: [{ matcher, hooks: [{ command }] }, ...] }
 * - Claude object format: { hooks: { PreToolUse: [{ matcher, hooks: [{ command }] }], ... } }
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readHooksToml, toClaudeHooksConfig } from '../../materializer/index.js'

export interface HooksJsonScript {
  script: string
  event?: string | undefined
}

export interface HooksJsonCommand {
  command: string
  event?: string | undefined
}

export interface HooksJsonParsed {
  scripts: HooksJsonScript[]
  commands: HooksJsonCommand[]
  sourcePath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function readHooksJson(pluginPath: string): Promise<HooksJsonParsed | null> {
  const hooksJsonPath = join(pluginPath, 'hooks', 'hooks.json')
  let content: unknown | null = null
  try {
    const raw = await readFile(hooksJsonPath, 'utf-8')
    content = JSON.parse(raw) as unknown
  } catch {
    content = null
  }

  if (content === null) {
    const hooksDir = join(pluginPath, 'hooks')
    const hooksToml = await readHooksToml(hooksDir)
    if (hooksToml) {
      const generated = toClaudeHooksConfig(hooksToml.hook)
      content = { hooks: generated.hooks }
      const parsed = parseHooksContent(content, join(hooksDir, 'hooks.toml'))
      return parsed
    }
    return null
  }

  return parseHooksContent(content, hooksJsonPath)
}

/**
 * Collect `command` strings from a Claude-style `hooks: [{ command }]` array,
 * appending each as a {@link HooksJsonCommand} tagged with `event`.
 */
function collectNestedCommands(
  nestedHooks: unknown[],
  event: string | undefined,
  commands: HooksJsonCommand[]
): void {
  for (const nested of nestedHooks) {
    if (!isRecord(nested)) continue
    const command = nested['command']
    if (typeof command === 'string') {
      commands.push({ command, event })
    }
  }
}

/**
 * Parse the array hooks format:
 * - simple entries `{ event, script }`, and
 * - Claude-array entries `{ matcher, hooks: [{ command }] }`.
 */
function parseArrayFormat(
  hooks: unknown[],
  scripts: HooksJsonScript[],
  commands: HooksJsonCommand[]
): void {
  for (const entry of hooks) {
    if (!isRecord(entry)) continue

    const script = entry['script']
    if (typeof script === 'string') {
      const event = typeof entry['event'] === 'string' ? entry['event'] : undefined
      scripts.push({ script, event })
    }

    const nestedHooks = entry['hooks']
    if (Array.isArray(nestedHooks)) {
      const event = typeof entry['matcher'] === 'string' ? entry['matcher'] : undefined
      collectNestedCommands(nestedHooks, event, commands)
    }
  }
}

/**
 * Parse the Claude object hooks format:
 * `{ PreToolUse: [{ matcher, hooks: [{ command }] }], ... }`.
 */
function parseObjectFormat(hooks: Record<string, unknown>, commands: HooksJsonCommand[]): void {
  for (const [eventName, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) continue
    for (const hookDef of eventHooks) {
      if (!isRecord(hookDef)) continue
      const nestedHooks = hookDef['hooks']
      if (!Array.isArray(nestedHooks)) continue
      collectNestedCommands(nestedHooks, eventName, commands)
    }
  }
}

function parseHooksContent(content: unknown, sourcePath: string): HooksJsonParsed | null {
  if (!isRecord(content)) {
    return null
  }

  const hooks = content['hooks']
  if (!hooks) {
    return null
  }

  const scripts: HooksJsonScript[] = []
  const commands: HooksJsonCommand[] = []

  if (Array.isArray(hooks)) {
    parseArrayFormat(hooks, scripts, commands)
  } else if (isRecord(hooks)) {
    parseObjectFormat(hooks, commands)
  } else {
    return null
  }

  return {
    scripts,
    commands,
    sourcePath,
  }
}
