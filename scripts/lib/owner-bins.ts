import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Owner CLIs by explicit install path (T-12654, D2). A prae seat has none of
// these names on PATH, so a script that needs the installed tool names it here
// rather than resolving a bare name. No environment override: ambient env must
// not decide which binary a recipe runs.
export const OWNER_BINS = {
  asp: join(homedir(), '.bun', 'bin', 'asp'),
  wrkq: join(homedir(), '.local', 'bin', 'wrkq'),
} as const

const OWNER_BIN_DIRS = [...new Set(Object.values(OWNER_BINS).map((bin) => dirname(bin)))]

/**
 * Env for a scratch daemon child (aspd, raspd, Bun hrc, rusthrc): the owner bin
 * dirs ahead of the inherited PATH, because the daemons themselves run owner
 * CLIs by bare name (rusthrc's `wrkq rpc --stdio`). Only daemon launch sites
 * use this; the script's own process and agent-facing commands keep the
 * seat's filtered PATH (T-12653 ruling).
 */
export function daemonEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, PATH: [...OWNER_BIN_DIRS, env['PATH'] ?? ''].filter(Boolean).join(':') }
}
