import { spawnSync } from 'node:child_process'

import { REPO_ROOT } from './package-set'

export function run(cmd: string, args: string[], cwd = REPO_ROOT): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

/** Trimmed output of a command that must succeed; empty output also fails. */
export function requiredCommandOutput(cmd: string, args: string[], cwd = REPO_ROOT): string {
  const result = run(cmd, args, cwd)
  if (result.status !== 0 || !result.out.trim()) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.out}`)
  }
  return result.out.trim()
}

/** Trimmed output of a command that must succeed; empty output is allowed. */
export function requiredCommandOutputOrEmpty(cmd: string, args: string[], cwd = REPO_ROOT): string {
  const result = run(cmd, args, cwd)
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.out}`)
  }
  return result.out.trim()
}
