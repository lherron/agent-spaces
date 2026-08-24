/**
 * Filesystem content readers for the explain pipeline.
 *
 * These helpers read materialized/snapshot directories (hooks.json, mcp.json,
 * space.toml settings, and component directories) and translate them into the
 * display-oriented {@link SpaceInfo} sub-shapes.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { readSpaceToml } from '../../core/index.js'
import {
  COMPONENT_DIRS,
  type ComponentDir,
  type McpConfig,
  type McpServerConfig,
} from '../../materializer/index.js'

import type { HookInfo, SpaceSettingsInfo } from './types.js'

/**
 * Check if a path exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Simple hook definition format (old format with event/script).
 */
interface SimpleHookDef {
  event: string
  script: string
}

/**
 * Claude hook definition format (matcher/hooks).
 */
interface ClaudeNativeHookDef {
  matcher?: string | undefined
  hooks: Array<{ command?: string | undefined }>
}

type ClaudeHooksByEvent = Record<string, ClaudeNativeHookDef[]>

/**
 * Read hooks.json from a directory and extract event names.
 * Handles simple format, Claude array format, and Claude object format.
 */
export async function readHooksFromDir(dir: string): Promise<HookInfo[] | undefined> {
  const hooksJsonPath = join(dir, 'hooks', 'hooks.json')
  try {
    const content = await readFile(hooksJsonPath, 'utf-8')
    const config = JSON.parse(content)

    if (!config.hooks) {
      return undefined
    }

    if (Array.isArray(config.hooks)) {
      // Check first element to determine format
      const first = config.hooks[0]
      if (!first) {
        return []
      }

      // Claude array format: [{matcher, hooks: [{command}]}]
      if ('hooks' in first) {
        return (config.hooks as ClaudeNativeHookDef[]).map((h) => ({
          event: h.matcher ?? 'Unknown',
          count: h.hooks?.length ?? 0,
        }))
      }

      // Simple format: [{event, script}]
      if ('event' in first) {
        return (config.hooks as SimpleHookDef[]).map((h) => ({
          event: h.event,
          count: 1,
        }))
      }

      return undefined
    }

    if (typeof config.hooks === 'object') {
      const results: HookInfo[] = []
      for (const [eventName, eventHooks] of Object.entries(config.hooks as ClaudeHooksByEvent)) {
        if (!Array.isArray(eventHooks)) continue
        const count = eventHooks.reduce((sum, hookDef) => {
          return sum + (hookDef.hooks?.length ?? 0)
        }, 0)
        results.push({ event: eventName, count })
      }
      return results
    }

    return undefined
  } catch {
    return undefined
  }
}

/**
 * Read mcp.json from a directory.
 */
export async function readMcpFromDir(
  dir: string
): Promise<Record<string, McpServerConfig> | undefined> {
  const mcpJsonPath = join(dir, 'mcp', 'mcp.json')
  try {
    const content = await readFile(mcpJsonPath, 'utf-8')
    const config = JSON.parse(content) as McpConfig
    return config.mcpServers
  } catch {
    return undefined
  }
}

/**
 * Get available component directories in a snapshot.
 */
export async function getAvailableComponents(snapshotDir: string): Promise<ComponentDir[]> {
  const available: ComponentDir[] = []
  for (const component of COMPONENT_DIRS) {
    const dir = join(snapshotDir, component)
    if (await isDirectory(dir)) {
      available.push(component)
    }
  }
  return available
}

/**
 * List files in a component directory (returns basenames without extension).
 */
export async function listComponentFiles(dir: string, component: string): Promise<string[]> {
  const componentDir = join(dir, component)
  try {
    const entries = await readdir(componentDir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name.replace(/\.[^.]+$/, '')) // Remove extension
  } catch {
    return []
  }
}

/**
 * List skill directories (directories containing SKILL.md).
 */
export async function listSkills(dir: string): Promise<string[]> {
  const skillsDir = join(dir, 'skills')
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const skills: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check if SKILL.md exists in this directory
        const skillFile = join(skillsDir, entry.name, 'SKILL.md')
        try {
          await stat(skillFile)
          skills.push(entry.name)
        } catch {
          // No SKILL.md, skip
        }
      }
    }
    return skills
  } catch {
    return []
  }
}

/**
 * Read settings from space.toml in a directory.
 */
export async function readSettingsFromDir(dir: string): Promise<SpaceSettingsInfo | undefined> {
  try {
    const spaceTomlPath = join(dir, 'space.toml')
    const manifest = await readSpaceToml(spaceTomlPath)
    if (!manifest.settings) return undefined

    const result: SpaceSettingsInfo = {}
    if (manifest.settings.permissions?.allow?.length) {
      result.allow = manifest.settings.permissions.allow
    }
    if (manifest.settings.permissions?.deny?.length) {
      result.deny = manifest.settings.permissions.deny
    }
    if (manifest.settings.env && Object.keys(manifest.settings.env).length > 0) {
      result.env = manifest.settings.env
    }
    if (manifest.settings.model) {
      result.model = manifest.settings.model
    }
    return Object.keys(result).length > 0 ? result : undefined
  } catch {
    return undefined
  }
}
