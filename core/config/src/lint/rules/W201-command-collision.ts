/**
 * W201: Command name collision detection.
 *
 * WHY: When multiple spaces define the same command name, Claude may
 * behave unexpectedly. We warn about this to help users avoid confusion.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LintContext, LintWarning, SpaceLintData } from '../types.js'
import { WARNING_CODES } from '../types.js'

/**
 * Get the plugin name for a space (used for namespace recommendation).
 * Uses plugin.name if defined, otherwise falls back to space ID.
 */
function getPluginName(space: SpaceLintData): string {
  return space.manifest.plugin?.name ?? String(space.manifest.id)
}

/**
 * Get all command names from a space's commands directory.
 */
async function getCommandNames(pluginPath: string): Promise<string[]> {
  const commandsDir = join(pluginPath, 'commands')

  try {
    const stats = await stat(commandsDir)
    if (!stats.isDirectory()) {
      return []
    }

    const entries = await readdir(commandsDir, { withFileTypes: true })
    const commands: string[] = []

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        // Remove .md extension to get command name
        commands.push(entry.name.slice(0, -3))
      }
    }

    return commands
  } catch {
    return []
  }
}

/**
 * W201: Detect command name collisions across spaces.
 */
export async function checkCommandCollisions(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  // Map command name -> list of spaces that define it
  const commandOwners = new Map<string, SpaceLintData[]>()

  for (const space of context.spaces) {
    const commands = await getCommandNames(space.pluginPath)

    for (const command of commands) {
      const owners = commandOwners.get(command) ?? []
      owners.push(space)
      commandOwners.set(command, owners)
    }
  }

  // Report collisions
  for (const [command, owners] of commandOwners) {
    if (owners.length > 1) {
      const spaceIds = owners.map((s) => String(s.manifest.id)).join(', ')
      // Provide disambiguation suggestions per spec: /<plugin-name>:<command>
      // Uses plugin.name if defined, otherwise falls back to space ID
      const suggestions = owners.map((s) => `/${getPluginName(s)}:${command}`).join(', ')
      warnings.push({
        code: WARNING_CODES.COMMAND_COLLISION,
        message: `Command '${command}' is defined in multiple spaces: ${spaceIds}. Use qualified names: ${suggestions}`,
        severity: 'warning',
        details: {
          command,
          spaces: owners.map((s) => s.key),
          suggestions: owners.map((s) => `/${getPluginName(s)}:${command}`),
        },
      })
    }
  }

  return warnings
}
