/**
 * Shared utilities for agent CLI commands.
 */

/**
 * Parse repeated --env KEY=VALUE flags into a Record.
 */
export function parseEnvFlags(envFlags?: string[]): Record<string, string> | undefined {
  if (!envFlags || envFlags.length === 0) return undefined
  const env: Record<string, string> = {}
  for (const flag of envFlags) {
    const eqIdx = flag.indexOf('=')
    if (eqIdx === -1) {
      throw new Error(`Invalid --env format: "${flag}" (expected KEY=VALUE)`)
    }
    env[flag.slice(0, eqIdx)] = flag.slice(eqIdx + 1)
  }
  return env
}
