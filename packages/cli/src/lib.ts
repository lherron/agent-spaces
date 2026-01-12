/**
 * @lherron/agent-spaces - Library exports for Agent Spaces v2 CLI.
 *
 * WHY: Separates library exports from CLI execution to allow
 * testing without running the CLI.
 */

/**
 * Find project root by walking up looking for asp-targets.toml.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  let dir = startDir
  const root = '/'

  while (dir !== root) {
    const targetsPath = `${dir}/asp-targets.toml`
    try {
      const exists = await Bun.file(targetsPath).exists()
      if (exists) {
        return dir
      }
    } catch {
      // Continue searching
    }
    // Move to parent directory
    const parent = dir.split('/').slice(0, -1).join('/')
    if (parent === dir || parent === '') {
      break
    }
    dir = parent || '/'
  }

  return null
}
