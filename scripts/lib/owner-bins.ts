import { homedir } from 'node:os'
import { join } from 'node:path'

// Owner CLIs by explicit install path (T-12654, D2). A prae seat has none of
// these names on PATH, so a script that needs the installed tool names it here
// rather than resolving a bare name. No environment override: ambient env must
// not decide which binary a recipe runs.
export const OWNER_BINS = {
  asp: join(homedir(), '.bun', 'bin', 'asp'),
  wrkq: join(homedir(), '.local', 'bin', 'wrkq'),
} as const
