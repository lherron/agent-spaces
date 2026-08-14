/**
 * Workspace-trust seeding for managed Claude Code launches.
 *
 * Claude Code 2.1.232 stopped nested git repositories inheriting workspace
 * trust from a parent directory: each repository root now needs its own
 * `projects[<path>].hasTrustDialogAccepted` entry in `~/.claude.json`, or an
 * interactive launch blocks on the trust prompt before executing anything —
 * including the argv priming prompt, so a managed runtime hangs silently.
 *
 * Agent Spaces launches are programmatic intent into registry-resolved
 * project roots (typically with --dangerously-skip-permissions already
 * granted), so the trust dialog is strictly weaker than what the launch
 * already carries. This module pre-approves trust for the exact launch cwd
 * (and its realpath, in case Claude keys the projects map by canonical path)
 * before spawn. It never approves ancestors or paths other than the cwd it
 * is given.
 *
 * `~/.claude.json` is rewritten wholesale by live Claude sessions with no
 * external locking, so a concurrent flush can clobber this write. Seeding is
 * therefore best-effort: it writes atomically (temp file + rename), verifies
 * by re-reading, retries a few times, and reports failures as warnings
 * rather than failing the launch.
 */

import { randomBytes } from 'node:crypto'
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const TRUST_WRITE_ATTEMPTS = 3
const TRUST_RETRY_DELAY_MS = 50

/**
 * Resolve the path of Claude Code's user-level state file. Honors
 * CLAUDE_CONFIG_DIR (which relocates `.claude.json` into that directory);
 * defaults to `$HOME/.claude.json`.
 */
export function resolveClaudeUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR']?.trim()
  if (configDir) return join(configDir, '.claude.json')
  return join(homedir(), '.claude.json')
}

export interface EnsureWorkspaceTrustResult {
  /** True when every required key already had trust or was written and verified */
  ok: boolean
  /** Project-map keys that were newly written (empty when already trusted) */
  updatedKeys: string[]
  /** Non-fatal problems; launch should proceed and surface these */
  warnings: string[]
}

/**
 * Ensure `~/.claude.json` records accepted workspace trust for `cwd` (and its
 * realpath when different). Best-effort: never throws; all failures are
 * reported as warnings so a launch is not blocked by seeding problems.
 */
export async function ensureClaudeWorkspaceTrust(
  cwd: string,
  options: { configPath?: string | undefined } = {}
): Promise<EnsureWorkspaceTrustResult> {
  const configPath = options.configPath ?? resolveClaudeUserConfigPath()
  const warnings: string[] = []

  const keys = [cwd]
  try {
    const canonical = await realpath(cwd)
    if (canonical !== cwd) keys.push(canonical)
  } catch {
    // cwd may not exist yet in dry runs; seed the literal path only
  }

  const updatedKeys: string[] = []
  for (let attempt = 1; attempt <= TRUST_WRITE_ATTEMPTS; attempt++) {
    try {
      const state = await readClaudeUserConfig(configPath)
      const missing = keys.filter((key) => !hasAcceptedTrust(state, key))
      if (missing.length === 0) {
        return { ok: true, updatedKeys, warnings }
      }

      const projects = isRecord(state['projects']) ? state['projects'] : {}
      for (const key of missing) {
        const entry = isRecord(projects[key]) ? projects[key] : {}
        projects[key] = { ...entry, hasTrustDialogAccepted: true }
      }
      state['projects'] = projects

      await writeClaudeUserConfigAtomic(configPath, state)

      // Verify: a concurrent Claude session can flush its stale in-memory
      // copy over this write. Re-read and retry when the flag is lost.
      const verify = await readClaudeUserConfig(configPath)
      const lost = keys.filter((key) => !hasAcceptedTrust(verify, key))
      if (lost.length === 0) {
        updatedKeys.push(...missing)
        return { ok: true, updatedKeys, warnings }
      }
      warnings.push(
        `Workspace-trust write for ${lost.join(', ')} was clobbered by a concurrent writer (attempt ${attempt}/${TRUST_WRITE_ATTEMPTS})`
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warnings.push(
        `Workspace-trust seeding failed for ${cwd} (attempt ${attempt}/${TRUST_WRITE_ATTEMPTS}): ${reason}`
      )
    }
    if (attempt < TRUST_WRITE_ATTEMPTS) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, TRUST_RETRY_DELAY_MS * attempt))
    }
  }

  warnings.push(
    `Workspace trust for ${cwd} could not be recorded in ${configPath}; an interactive Claude launch may block on the trust prompt`
  )
  return { ok: false, updatedKeys, warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasAcceptedTrust(state: Record<string, unknown>, key: string): boolean {
  const projects = state['projects']
  if (!isRecord(projects)) return false
  const entry = projects[key]
  return isRecord(entry) && entry['hasTrustDialogAccepted'] === true
}

async function readClaudeUserConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} does not contain a JSON object`)
  }
  return parsed
}

async function writeClaudeUserConfigAtomic(
  configPath: string,
  state: Record<string, unknown>
): Promise<void> {
  let mode = 0o600
  try {
    mode = (await stat(configPath)).mode & 0o777
  } catch {
    // keep the restrictive default for a fresh file
  }
  const tmpPath = join(
    dirname(configPath),
    `.claude.json.asp-trust-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  )
  try {
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode })
    await rename(tmpPath, configPath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}
