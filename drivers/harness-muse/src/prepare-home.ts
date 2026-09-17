/**
 * Per-invocation isolated HOME for `muse serve` (T-08589, spike 2 + spike 10).
 *
 * Serve constructs its sandbox posture and session durability for its
 * lifetime; state, skills, plugins, and session logs live under the HOME it
 * sees. The driver prepares a fingerprinted runtime home per invocation and
 * spawns with HOME (plus XDG_CONFIG_HOME/XDG_DATA_HOME) pointed at it:
 * - `<home>/.config/muse/skills/` receives the composer-merged skills
 *   (spike 8 fallback, proven `source: user` via skill/list).
 * - `<home>/.config/muse/auth.json` is symlinked from the operator HOME when
 *   present, warning-never-error when absent (spike 10; serve handshakes,
 *   sessions, and echo turns all work unauthenticated). The symlink carries
 *   file-based credentials across; keychain-bound oauth (device_code) does
 *   NOT leave the operator HOME — serve answers authRequired under any
 *   other $HOME (T-08592 probes 5–9), which is what homeMode 'operator'
 *   is for.
 *
 * No cross-target leakage exactly because HOME is per-invocation. node:fs
 * only — harness-broker does not depend on spaces-config.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface PrepareMuseHomeOptions {
  /** Workspace skills dir (composer output) to materialize into the HOME. */
  workspaceSkillsDir?: string | undefined
  /**
   * Exact HOME dir to prepare (CLI stable homes). When set, baseDir and the
   * invocationId name pattern are ignored.
   */
  homeDir?: string | undefined
  /** Base dir for invocation homes; defaults to the OS temp dir. */
  baseDir?: string | undefined
  /**
   * 'isolated' (default): full per-invocation HOME under baseDir.
   * 'operator': $HOME stays the operator home while XDG_CONFIG_HOME and
   * XDG_DATA_HOME point at fresh temp dirs, so sessions, skills seeding,
   * and config writes stay disposable. REQUIRED for model calls under
   * keychain-bound oauth credentials (device_code): serve answers
   * authRequired under any other HOME even with auth.json symlinked
   * (T-08592 probes 5–9). File-based api-key credentials travel under
   * either mode via the auth.json symlink.
   */
  homeMode?: 'isolated' | 'operator' | undefined
  /** Operator HOME to seed auth.json from; defaults to process HOME. */
  operatorHome?: string | undefined
  /**
   * Reuse a stable HOME (CLI runs): when the stored metadata fingerprint
   * matches, skip the wipe and re-seed in place so session history survives.
   * Defaults to false (per-invocation broker HOME, always fresh).
   */
  reuse?: boolean | undefined
}

export interface PreparedMuseHome {
  home: string
  configDir: string
  dataDir: string
  fingerprint: string
  warnings: string[]
}

async function exists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory() || stats.isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function fingerprintSkills(skillsDir: string, entries: string[]): string {
  return createHash('sha256').update(JSON.stringify({ skillsDir, entries })).digest('hex')
}

export async function prepareMuseHome(
  invocationId: string,
  options: PrepareMuseHomeOptions = {}
): Promise<PreparedMuseHome> {
  const warnings: string[] = []
  const base = options.baseDir ?? tmpdir()
  const operatorMode = options.homeMode === 'operator'
  // Operator mode: $HOME is always the operator home (never homeDir — an
  // explicit homeDir names the STABLE scratch root holding the XDG dirs, so
  // CLI session history survives while oauth keeps resolving). Nothing is
  // ever written to or wiped inside the operator HOME itself.
  const home = operatorMode
    ? (options.operatorHome ?? homedir())
    : (options.homeDir ?? join(base, `muse-serve-home-${invocationId}`))
  const scratch =
    options.homeDir ?? (operatorMode ? join(base, `muse-serve-xdg-${invocationId}`) : home)
  const configDir = join(scratch, '.config', 'muse')
  const dataDir = join(scratch, '.local', 'share', 'muse')
  const skillsDir = join(configDir, 'skills')
  const metadataPath = join(scratch, 'muse-serve-metadata.json')

  const readMetadataFingerprint = async (): Promise<string | undefined> => {
    try {
      const raw = await readFile(metadataPath, 'utf-8')
      const parsed = JSON.parse(raw) as { fingerprint?: unknown }
      return typeof parsed.fingerprint === 'string' ? parsed.fingerprint : undefined
    } catch {
      return undefined
    }
  }

  const incomingFingerprint = async (): Promise<{ fingerprint: string }> => {
    if (options.workspaceSkillsDir && (await isDirectory(options.workspaceSkillsDir))) {
      const entries = (await readdir(options.workspaceSkillsDir)).sort()
      return { fingerprint: fingerprintSkills(options.workspaceSkillsDir, entries) }
    }
    return { fingerprint: fingerprintSkills(skillsDir, []) }
  }

  if (options.reuse === true) {
    const incoming = await incomingFingerprint()
    if ((await readMetadataFingerprint()) === incoming.fingerprint) {
      return {
        home,
        configDir,
        dataDir,
        fingerprint: incoming.fingerprint,
        warnings: [],
      }
    }
  }

  // Wipe scratch, never the operator HOME itself.
  await rm(scratch, { recursive: true, force: true })
  await mkdir(skillsDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  let fingerprint = fingerprintSkills(skillsDir, [])
  if (options.workspaceSkillsDir && (await isDirectory(options.workspaceSkillsDir))) {
    const entries = (await readdir(options.workspaceSkillsDir)).sort()
    fingerprint = fingerprintSkills(options.workspaceSkillsDir, entries)
    await cp(options.workspaceSkillsDir, skillsDir, { recursive: true, force: true })
    for (const entry of entries) {
      const skillFile = join(skillsDir, entry, 'SKILL.md')
      if (!(await exists(skillFile))) {
        warnings.push(`Skill "${entry}" missing SKILL.md`)
        continue
      }
      const content = await readFile(skillFile, 'utf-8')
      if (
        !/^---[\s\S]*?name\s*:.+/m.test(content) ||
        !/^---[\s\S]*?description\s*:.+/m.test(content)
      ) {
        warnings.push(
          `Skill "${entry}" invalid-skill-package: SKILL.md frontmatter requires name + description`
        )
      }
    }
  }

  const operatorConfigDir = join(options.operatorHome ?? homedir(), '.config', 'muse')
  const operatorAuth = join(operatorConfigDir, 'auth.json')
  const destAuth = join(configDir, 'auth.json')
  if (await exists(operatorAuth)) {
    try {
      await symlink(operatorAuth, destAuth)
    } catch (error) {
      warnings.push(
        `muse-serve auth seeding skipped: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  } else {
    warnings.push(
      'muse-serve auth.json not found on the operator HOME; model calls will fail authRequired until credentials exist'
    )
  }

  await writeFile(
    metadataPath,
    `${JSON.stringify({ invocationId, fingerprint, createdAt: new Date().toISOString() }, null, 2)}\n`
  )

  return { home, configDir, dataDir, fingerprint, warnings }
}

/** Spawn-env overrides that point serve at the prepared HOME. */
export function museHomeEnv(home: PreparedMuseHome): Record<string, string> {
  return {
    HOME: home.home,
    XDG_CONFIG_HOME: dirname(home.configDir),
    XDG_DATA_HOME: dirname(home.dataDir),
  }
}
