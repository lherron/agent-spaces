/**
 * Composer tests: bundle layout, AGENTS.md concat, skills merge + SKILL.md
 * lint, settings.json MCP merge, manifest shape, and determinism
 * (canonical-hash fingerprint + byte-identical output).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MUSE_AGENTS_FILE,
  MUSE_MANIFEST_FILE,
  MUSE_SETTINGS_FILE,
  composeMuseWorkspace,
  loadMuseWorkspaceBundle,
} from './composer.js'
import type { ComposeMuseWorkspaceInput, MuseManifest } from './composer.js'

let tmpRoot: string

async function writeSpace(
  spaceId: string,
  files: Record<string, string>
): Promise<{ spaceId: string; version: string; dir: string }> {
  const dir = join(tmpRoot, `space-${spaceId}`)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  return { spaceId, version: '1.0.0', dir }
}

async function readBundleFiles(rootDir: string): Promise<Record<string, string>> {
  const base = join(rootDir, 'muse.workspace')
  const out: Record<string, string> = {}
  for (const rel of [MUSE_AGENTS_FILE, MUSE_SETTINGS_FILE, MUSE_MANIFEST_FILE]) {
    out[rel] = await readFile(join(base, rel), 'utf-8')
  }
  return out
}

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `muse-composer-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await mkdir(tmpRoot, { recursive: true })
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('composeMuseWorkspace bundle layout', () => {
  test('concatenates AGENTS.md with space markers and merges skills/settings/manifest', async () => {
    const alpha = await writeSpace('alpha', {
      'AGENTS.md': '# Alpha\n\nDo alpha things.\n',
      'skills/greeter/SKILL.md':
        '---\nname: greeter\ndescription: Greets warmly.\n---\n\n# Greeter\n',
      'mcp/mcp.json': JSON.stringify({
        mcpServers: { alpha: { type: 'stdio', command: 'alpha-bin' } },
      }),
    })
    const beta = await writeSpace('beta', {
      'AGENTS.md': '# Beta\n\nDo beta things.\n',
      'skills/farewell/SKILL.md':
        '---\nname: farewell\ndescription: Says goodbye.\n---\n\n# Farewell\n',
      'mcp/mcp.json': JSON.stringify({
        mcpServers: { beta: { type: 'stdio', command: 'beta-bin' } },
      }),
    })
    const input: ComposeMuseWorkspaceInput = { targetName: 'dev', spaces: [alpha, beta] }
    const outDir = join(tmpRoot, 'bundle')

    const { bundle, warnings } = await composeMuseWorkspace(input, outDir)

    expect(warnings).toEqual([])
    expect(bundle.workspaceDir).toBe(join(outDir, 'muse.workspace'))

    const agents = await readFile(bundle.agentsPath, 'utf-8')
    expect(agents).toContain('<!-- BEGIN space: alpha@1.0.0 -->')
    expect(agents).toContain('# Alpha')
    expect(agents).toContain('<!-- BEGIN space: beta@1.0.0 -->')
    expect(agents).toContain('# Beta')
    expect(agents.indexOf('alpha@1.0.0')).toBeLessThan(agents.indexOf('beta@1.0.0'))

    const settings = JSON.parse(await readFile(bundle.settingsPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['alpha', 'beta'])

    const manifest = JSON.parse(await readFile(bundle.manifestPath, 'utf-8')) as MuseManifest
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.producer).toBe('muse-serve')
    expect(manifest.targetName).toBe('dev')
    expect(manifest.spaces).toEqual([
      { spaceId: 'alpha', version: '1.0.0' },
      { spaceId: 'beta', version: '1.0.0' },
    ])
    expect(manifest.skills).toEqual(['farewell', 'greeter'])
    expect(manifest.mcpServers).toEqual(['alpha', 'beta'])
    expect(manifest.instructions).toHaveLength(2)

    const greeter = await readFile(join(bundle.skillsDir, 'greeter', 'SKILL.md'), 'utf-8')
    expect(greeter).toContain('# Greeter')
    const farewell = await readFile(join(bundle.skillsDir, 'farewell', 'SKILL.md'), 'utf-8')
    expect(farewell).toContain('# Farewell')
  })

  test('later spaces win skill collisions and MCP collisions warn W_MCP', async () => {
    const alpha = await writeSpace('alpha', {
      'skills/shared/SKILL.md': '---\nname: shared\ndescription: Alpha copy.\n---\n\n# Alpha\n',
      'mcp/mcp.json': JSON.stringify({
        mcpServers: { dup: { type: 'stdio', command: 'alpha-bin' } },
      }),
    })
    const beta = await writeSpace('beta', {
      'skills/shared/SKILL.md': '---\nname: shared\ndescription: Beta copy.\n---\n\n# Beta\n',
      'mcp/mcp.json': JSON.stringify({
        mcpServers: { dup: { type: 'stdio', command: 'beta-bin' } },
      }),
    })
    const { bundle, warnings } = await composeMuseWorkspace(
      { targetName: 'dev', spaces: [alpha, beta] },
      join(tmpRoot, 'bundle')
    )

    const shared = await readFile(join(bundle.skillsDir, 'shared', 'SKILL.md'), 'utf-8')
    expect(shared).toContain('# Beta')

    const mcpWarnings = warnings.filter((w) => w.code === 'W_MCP')
    expect(mcpWarnings.length).toBeGreaterThan(0)
    expect(mcpWarnings[0]?.message).toContain("'dup'")
  })

  test('SKILL.md frontmatter lint warns W_SKILL without failing the compose', async () => {
    const alpha = await writeSpace('alpha', {
      'skills/broken/SKILL.md': '# No frontmatter at all\n',
      'skills/noname/SKILL.md': '---\ndescription: Missing name.\n---\n\n# Noname\n',
    })
    const { bundle, warnings } = await composeMuseWorkspace(
      { targetName: 'dev', spaces: [alpha] },
      join(tmpRoot, 'bundle')
    )

    const skillWarnings = warnings.filter((w) => w.code === 'W_SKILL')
    expect(skillWarnings).toHaveLength(2)
    expect(skillWarnings.map((w) => w.message).join('\n')).toContain('invalid-skill-package')

    const manifest = JSON.parse(await readFile(bundle.manifestPath, 'utf-8')) as MuseManifest
    expect(manifest.skills).toEqual(['broken', 'noname'])
  })

  test('missing SKILL.md warns and empty MCP still writes deterministic settings', async () => {
    const alpha = await writeSpace('alpha', {
      'AGENTS.md': '# Alpha\n',
      'skills/empty/x.txt': 'not a skill package\n',
    })
    const { bundle, warnings } = await composeMuseWorkspace(
      { targetName: 'dev', spaces: [alpha] },
      join(tmpRoot, 'bundle')
    )
    expect(
      warnings.some((w) => w.code === 'W_SKILL' && w.message.includes('missing SKILL.md'))
    ).toBe(true)
    const settings = await readFile(bundle.settingsPath, 'utf-8')
    expect(settings).toBe('{\n  "mcpServers": {}\n}\n')
  })
})

describe('composeMuseWorkspace determinism', () => {
  test('two composes of the same input are byte-identical with equal fingerprints', async () => {
    const alpha = await writeSpace('alpha', {
      'AGENTS.md': '# Alpha\n\nStable content.\n',
      'skills/greeter/SKILL.md': '---\nname: greeter\ndescription: Greets.\n---\n\n# Greeter\n',
      'mcp/mcp.json': JSON.stringify({ mcpServers: { alpha: { type: 'stdio', command: 'x' } } }),
    })
    const input: ComposeMuseWorkspaceInput = { targetName: 'dev', spaces: [alpha] }

    const first = await composeMuseWorkspace(input, join(tmpRoot, 'first'))
    const second = await composeMuseWorkspace(input, join(tmpRoot, 'second'))

    expect(second.bundle.fingerprint).toEqual(first.bundle.fingerprint)
    expect(first.bundle.fingerprint.algorithm).toBe('sha256-canonical-json/v1')

    const firstFiles = await readBundleFiles(join(tmpRoot, 'first'))
    const secondFiles = await readBundleFiles(join(tmpRoot, 'second'))
    expect(secondFiles).toEqual(firstFiles)
  })
})

describe('loadMuseWorkspaceBundle', () => {
  test('reads back a composed bundle with a matching fingerprint', async () => {
    const alpha = await writeSpace('alpha', { 'AGENTS.md': '# Alpha\n' })
    const { bundle } = await composeMuseWorkspace(
      { targetName: 'dev', spaces: [alpha] },
      join(tmpRoot, 'bundle')
    )
    const loaded = await loadMuseWorkspaceBundle(join(tmpRoot, 'bundle'), 'dev')
    expect(loaded.fingerprint).toEqual(bundle.fingerprint)
    expect(loaded.agentsPath).toBe(bundle.agentsPath)
  })

  test('throws verbatim on a missing workspace', async () => {
    await expect(loadMuseWorkspaceBundle(join(tmpRoot, 'absent'), 'dev')).rejects.toThrow(
      'Muse workspace directory not found'
    )
  })
})
