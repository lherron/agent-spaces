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

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parsed = parseSemver(version)
  const min = parseSemver(minVersion)
  if (!parsed || !min) return false
  for (let i = 0; i < 3; i++) {
    const p = parsed[i]
    const m = min[i]
    if (p === undefined || m === undefined) return false
    if (p > m) return true
    if (p < m) return false
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
}

interface BunProcess {
  exited: Promise<number>
  stdout: ReadableStream
  stderr: ReadableStream
}

export async function runCommand(args: string[]): Promise<CommandResult> {
  const bun = (
    globalThis as { Bun?: { spawn: (args: string[], opts: BunSpawnOptions) => BunProcess } }
  ).Bun
  if (bun) {
    const proc = bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(args[0] ?? '', args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr })
    })
  })
}
