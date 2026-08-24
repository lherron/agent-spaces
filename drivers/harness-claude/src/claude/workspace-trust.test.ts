/**
 * Tests for Claude workspace-trust seeding.
 *
 * WHY: Claude Code 2.1.232 stopped nested git repos inheriting trust from a
 * parent directory; a managed interactive launch into an untrusted repo hangs
 * on the trust prompt before the priming prompt runs. Seeding must set the
 * exact-cwd flag while preserving every unrelated field in ~/.claude.json.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureClaudeWorkspaceTrust, resolveClaudeUserConfigPath } from './workspace-trust.js'

let workDir: string
let configPath: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'asp-trust-test-'))
  configPath = join(workDir, '.claude.json')
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8'))
}

describe('ensureClaudeWorkspaceTrust', () => {
  it('adds a trusted entry for a cwd absent from the projects map', async () => {
    await writeFile(configPath, JSON.stringify({ projects: {} }))
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)

    const result = await ensureClaudeWorkspaceTrust(cwd, { configPath })

    expect(result.ok).toBe(true)
    expect(result.updatedKeys).toContain(cwd)
    const config = await readConfig()
    const projects = config['projects'] as Record<string, { hasTrustDialogAccepted: boolean }>
    expect(projects[cwd]?.hasTrustDialogAccepted).toBe(true)
  })

  it('flips an existing false entry while preserving its other fields', async () => {
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)
    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          [cwd]: {
            hasTrustDialogAccepted: false,
            allowedTools: ['Bash'],
            history: [{ display: 'earlier prompt' }],
          },
        },
      })
    )

    const result = await ensureClaudeWorkspaceTrust(cwd, { configPath })

    expect(result.ok).toBe(true)
    const config = await readConfig()
    const entry = (config['projects'] as Record<string, Record<string, unknown>>)[cwd]!
    expect(entry['hasTrustDialogAccepted']).toBe(true)
    expect(entry['allowedTools']).toEqual(['Bash'])
    expect(entry['history']).toEqual([{ display: 'earlier prompt' }])
  })

  it('preserves unknown top-level fields and other project entries', async () => {
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)
    await writeFile(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'user@example.com' },
        numStartups: 42,
        projects: {
          '/some/other/path': { hasTrustDialogAccepted: false },
        },
      })
    )

    await ensureClaudeWorkspaceTrust(cwd, { configPath })

    const config = await readConfig()
    expect(config['oauthAccount']).toEqual({ emailAddress: 'user@example.com' })
    expect(config['numStartups']).toBe(42)
    const projects = config['projects'] as Record<string, { hasTrustDialogAccepted: boolean }>
    expect(projects['/some/other/path']?.hasTrustDialogAccepted).toBe(false)
    expect(projects[cwd]?.hasTrustDialogAccepted).toBe(true)
  })

  it('is idempotent: an already-trusted cwd causes no write', async () => {
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)
    // Trust both the literal and canonical keys (macOS tmpdir realpaths
    // /var/... to /private/var/...), matching a prior seeding pass.
    const canonical = await realpath(cwd)
    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          [cwd]: { hasTrustDialogAccepted: true },
          [canonical]: { hasTrustDialogAccepted: true },
        },
      })
    )
    const before = await stat(configPath)

    const result = await ensureClaudeWorkspaceTrust(cwd, { configPath })

    expect(result.ok).toBe(true)
    expect(result.updatedKeys).toEqual([])
    const after = await stat(configPath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('also seeds the realpath key when cwd contains a symlink', async () => {
    const realDir = join(workDir, 'real-repo')
    await mkdir(realDir)
    const linkPath = join(workDir, 'link-repo')
    await symlink(realDir, linkPath)
    await writeFile(configPath, JSON.stringify({ projects: {} }))

    const result = await ensureClaudeWorkspaceTrust(linkPath, { configPath })

    expect(result.ok).toBe(true)
    const config = await readConfig()
    const projects = config['projects'] as Record<string, { hasTrustDialogAccepted: boolean }>
    expect(projects[linkPath]?.hasTrustDialogAccepted).toBe(true)
    // realpath may canonicalize tmpdir prefixes too; every written key is trusted
    for (const key of result.updatedKeys) {
      expect(projects[key]?.hasTrustDialogAccepted).toBe(true)
    }
    expect(result.updatedKeys.length).toBeGreaterThanOrEqual(1)
  })

  it('creates the config file when missing', async () => {
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)

    const result = await ensureClaudeWorkspaceTrust(cwd, { configPath })

    expect(result.ok).toBe(true)
    const config = await readConfig()
    const projects = config['projects'] as Record<string, { hasTrustDialogAccepted: boolean }>
    expect(projects[cwd]?.hasTrustDialogAccepted).toBe(true)
  })

  it('preserves the existing file mode', async () => {
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)
    await writeFile(configPath, JSON.stringify({ projects: {} }), { mode: 0o600 })

    await ensureClaudeWorkspaceTrust(cwd, { configPath })

    const after = await stat(configPath)
    expect(after.mode & 0o777).toBe(0o600)
  })

  it('reports warnings instead of throwing on malformed JSON', async () => {
    const cwd = join(workDir, 'repo')
    await mkdir(cwd)
    await writeFile(configPath, 'not-json{{{')

    const result = await ensureClaudeWorkspaceTrust(cwd, { configPath })

    expect(result.ok).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
    // the malformed file is left untouched
    expect(await readFile(configPath, 'utf8')).toBe('not-json{{{')
  })
})

describe('resolveClaudeUserConfigPath', () => {
  it('honors CLAUDE_CONFIG_DIR', () => {
    expect(resolveClaudeUserConfigPath({ CLAUDE_CONFIG_DIR: '/custom/dir' })).toBe(
      '/custom/dir/.claude.json'
    )
  })

  it('defaults to the home directory', () => {
    expect(resolveClaudeUserConfigPath({})).toEndWith('/.claude.json')
  })
})
