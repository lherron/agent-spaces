/**
 * Codex binary discovery: candidate path enumeration, version probing, and the
 * cross-runtime `runCommand` helper used to interrogate a codex install.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const CODEX_PATH_ENV = 'ASP_CODEX_PATH'
export const CODEX_SKIP_COMMON_PATHS_ENV = 'ASP_CODEX_SKIP_COMMON_PATHS'

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

const DISCOVERY_COMMAND_TIMEOUT_MS = 3000

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parsed = parseSemver(version)
  const minimum = parseSemver(minVersion)
  if (!parsed || !minimum) return false
  for (let index = 0; index < 3; index++) {
    const current = parsed[index]
    const min = minimum[index]
    if (current === undefined || min === undefined) return false
    if (current > min) return true
    if (current < min) return false
  }
  return true
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function pathCandidatesForCommand(command: string): string[] {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, command))
}

function nvmCodexCandidates(): string[] {
  const versionsDir = join(homedir(), '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(versionsDir, entry.name, 'bin', 'codex'))
  } catch {
    return []
  }
}

export function codexCommandCandidates(): string[] {
  const commonCandidates =
    process.env[CODEX_SKIP_COMMON_PATHS_ENV] === '1'
      ? []
      : [
          ...nvmCodexCandidates(),
          join(homedir(), '.bun', 'bin', 'codex'),
          join(homedir(), '.local', 'bin', 'codex'),
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
        ]

  return dedupeStrings([
    process.env[CODEX_PATH_ENV] ?? '',
    ...pathCandidatesForCommand('codex'),
    ...commonCandidates,
  ])
}

interface BunSpawnOptions {
  stdout: 'pipe' | 'inherit' | 'ignore'
  stderr: 'pipe' | 'inherit' | 'ignore'
  env?: Record<string, string> | undefined
}

interface BunProcess {
  exited: Promise<number>
  stdout: ReadableStream
  stderr: ReadableStream
  kill: () => void
}

export async function runCommand(args: string[]): Promise<CommandResult> {
  const env = codexDiscoveryEnv()
  const bun = (
    globalThis as { Bun?: { spawn: (args: string[], opts: BunSpawnOptions) => BunProcess } }
  ).Bun
  if (bun) {
    const proc = bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', env })
    const stdout = new Response(proc.stdout).text().catch(() => '')
    const stderr = new Response(proc.stderr).text().catch(() => '')
    const exitCode = await exitWithTimeout(proc, DISCOVERY_COMMAND_TIMEOUT_MS)
    if (exitCode === undefined) {
      proc.kill()
      return { exitCode: 124, stdout: '', stderr: 'command timed out' }
    }
    return { exitCode, stdout: await stdout, stderr: await stderr }
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(args[0] ?? '', args.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      proc.kill()
      resolve({ exitCode: 124, stdout, stderr: stderr || 'command timed out' })
    }, DISCOVERY_COMMAND_TIMEOUT_MS)
    timer.unref?.()
    proc.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 0, stdout, stderr })
    })
  })
}

async function exitWithTimeout(
  proc: { exited: Promise<number> },
  timeoutMs: number
): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      proc.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, undefined)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function codexDiscoveryEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('HARNESS_BROKER_')) continue
    env[key] = value
  }
  return env
}
