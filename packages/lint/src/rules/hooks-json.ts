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
import { readHooksToml, toClaudeHooksConfig } from 'spaces-materializer'

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
        for (const nested of nestedHooks) {
          if (!isRecord(nested)) continue
          const command = nested['command']
          if (typeof command === 'string') {
            commands.push({ command, event })
          }
        }
      }
    }
  } else if (isRecord(hooks)) {
    for (const [eventName, eventHooks] of Object.entries(hooks)) {
      if (!Array.isArray(eventHooks)) continue
      for (const hookDef of eventHooks) {
        if (!isRecord(hookDef)) continue
        const nestedHooks = hookDef['hooks']
        if (!Array.isArray(nestedHooks)) continue
        for (const nested of nestedHooks) {
          if (!isRecord(nested)) continue
          const command = nested['command']
          if (typeof command === 'string') {
            commands.push({ command, event: eventName })
          }
        }
      }
    }
  } else {
    return null
  }

  return {
    scripts,
    commands,
    sourcePath,
  }
}
