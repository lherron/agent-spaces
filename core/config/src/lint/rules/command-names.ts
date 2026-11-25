import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Get all command names from a space's commands directory.
 */
export async function getCommandNames(pluginPath: string): Promise<string[]> {
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
