/**
 * Muse binary discovery: candidate path enumeration and version probing.
 *
 * Spike-1 scope: pure discovery helpers with no CLI contract. Detection needs
 * a local binary but the composer tests never touch it; an absent binary is a
 * normal `available: false` result, never an exception.
 */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const MUSE_PATH_ENV = 'ASP_MUSE_PATH'
export const MUSE_SKIP_COMMON_PATHS_ENV = 'ASP_MUSE_SKIP_COMMON_PATHS'

export interface MuseCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type MuseDetection =
  | { available: true; version: string; path: string; capabilities: ['serve'] }
  | { available: false; error: string }

export interface MuseDiscoveryOptions {
  home?: string | undefined
  pathValue?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  run?: ((args: string[]) => Promise<MuseCommandResult>) | undefined
  exists?: ((path: string) => boolean) | undefined
}

const DISCOVERY_COMMAND_TIMEOUT_MS = 3000

/**
 * Successful probes keyed by candidate path. The fingerprint changes when the
 * binary is replaced, so the long-lived ASPD compiler avoids two process
 * launches per compile without retaining stale harness capability data.
 * Failed probes deliberately stay uncached: a transiently busy Muse binary
 * must be retried by the next compile.
 */
const detectionCache = new Map<string, { fingerprint: string; detection: MuseDetection }>()

function binaryFingerprint(candidate: string): string | undefined {
  try {
    const target = realpathSync(candidate)
    const info = statSync(target)
    return `${target}:${info.mtimeMs}:${info.size}`
  } catch {
    return undefined
  }
}

function readEnv(options: MuseDiscoveryOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env
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

function pathCandidatesForCommand(command: string, pathValue: string): string[] {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, command))
}

/**
 * Ordered `muse` binary candidates: explicit `ASP_MUSE_PATH` first, then
 * common user install paths (unless skipped), then PATH entries.
 */
export function museCommandCandidates(options: MuseDiscoveryOptions = {}): string[] {
  const env = readEnv(options)
  const home = options.home ?? homedir()
  const commonCandidates =
    env[MUSE_SKIP_COMMON_PATHS_ENV] === '1'
      ? []
      : [join(home, '.local', 'bin', 'muse'), join(home, '.bun', 'bin', 'muse')]
  const pathValue = options.pathValue ?? env['PATH'] ?? ''
  return dedupeStrings([
    env[MUSE_PATH_ENV] ?? '',
    ...commonCandidates,
    ...pathCandidatesForCommand('muse', pathValue),
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

function discoveryEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('HARNESS_BROKER_')) continue
    env[key] = value
  }
  return env
}

export async function runMuseCommand(args: string[]): Promise<MuseCommandResult> {
  const env = discoveryEnv()
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

function parseSemver(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/)
  return match?.[1] ?? null
}

async function probeMuseCandidate(
  candidate: string,
  run: (args: string[]) => Promise<MuseCommandResult>
): Promise<{ detection: MuseDetection } | { error: string }> {
  let versionResult: MuseCommandResult
  try {
    versionResult = await run([candidate, '--version'])
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (versionResult.exitCode !== 0) {
    return {
      error: versionResult.stderr.trim() || versionResult.stdout.trim() || 'muse --version failed',
    }
  }
  const output = versionResult.stdout.trim() || versionResult.stderr.trim()
  const version = parseSemver(output) ?? (output || 'unknown')

  let serveResult: MuseCommandResult
  try {
    serveResult = await run([candidate, 'serve', '--help'])
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (serveResult.exitCode !== 0) {
    return {
      error: serveResult.stderr.trim() || serveResult.stdout.trim() || 'muse serve --help failed',
    }
  }

  return {
    detection: { available: true, version, path: candidate, capabilities: ['serve'] },
  }
}

/**
 * Probe candidates in order. Returns the first working binary or an
 * `available: false` result attributing the cause. Never throws for a missing
 * binary; only filesystem errors from the candidate check itself propagate.
 */
export async function detectMuse(options: MuseDiscoveryOptions = {}): Promise<MuseDetection> {
  const exists = options.exists ?? existsSync
  const run = options.run ?? runMuseCommand
  // Injected filesystem or process seams make a caller-specific detector, so
  // they must not share state with the production process cache.
  const cacheable = options.exists === undefined && options.run === undefined
  const errors: string[] = []
  for (const candidate of museCommandCandidates(options)) {
    if (!exists(candidate)) continue
    const fingerprint = cacheable ? binaryFingerprint(candidate) : undefined
    const cached = fingerprint === undefined ? undefined : detectionCache.get(candidate)
    if (cached !== undefined && cached.fingerprint === fingerprint) {
      return cached.detection
    }
    const probe = await probeMuseCandidate(candidate, run)
    if ('detection' in probe) {
      if (fingerprint !== undefined) {
        detectionCache.set(candidate, { fingerprint, detection: probe.detection })
      }
      return probe.detection
    }
    errors.push(`${candidate}: ${probe.error}`)
  }
  return {
    available: false,
    error:
      errors.length > 0
        ? errors.join('; ')
        : `muse not found on PATH, ${MUSE_PATH_ENV}, or common user install paths`,
  }
}
