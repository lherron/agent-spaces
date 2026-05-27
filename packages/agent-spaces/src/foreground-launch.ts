/**
 * Canonical translation of a compiled foreground TerminalExecutionProfile into
 * a concrete launch shape (argv + composed env + cwd).
 *
 * Single source of truth so the `asp run` foreground runner and the byte-parity
 * tests compose the launch env identically: lockedEnv is taken verbatim and the
 * typed `pathPrepend` dirs are prepended to PATH (the controlled PATH mutation
 * the compiler keeps OUT of lockedEnv).
 */

import { delimiter } from 'node:path'

import type { RuntimeCompileResponse, TerminalExecutionProfile } from 'spaces-runtime-contracts'

export interface ForegroundLaunch {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** Compose the env a foreground runner passes to spawn from the profile's process spec. */
export function composeForegroundEnv(
  process: TerminalExecutionProfile['process']
): Record<string, string> {
  const env: Record<string, string> = { ...process.lockedEnv }
  const pathPrepend = process.pathPrepend ?? []
  if (pathPrepend.length > 0) {
    const base = env['PATH']
    env['PATH'] = base ? [...pathPrepend, base].join(delimiter) : pathPrepend.join(delimiter)
  }
  return env
}

/**
 * Extract the foreground launch shape from a compile response, or undefined when
 * the plan did not produce a foreground terminal profile (e.g. headless/broker).
 */
export function foregroundLaunchFromResponse(
  response: RuntimeCompileResponse
): ForegroundLaunch | undefined {
  if (!response.ok) return undefined
  const profile = response.plan.executionProfiles.find(
    (candidate): candidate is TerminalExecutionProfile =>
      candidate.kind === 'terminal' && candidate.terminal.host === 'foreground'
  )
  if (!profile) return undefined
  return {
    command: profile.process.command,
    args: profile.process.args,
    cwd: profile.process.cwd,
    env: composeForegroundEnv(profile.process),
  }
}
