/**
 * Muse workspace composition through MuseAdapter.composeTarget (the composer's
 * only caller): bundle layout, AGENTS.md concat, skills merge + SKILL.md lint,
 * settings.json MCP merge, manifest shape, determinism (byte-identical
 * muse.workspace output), and the missing-workspace load error.
 *
 * composeTarget also prepares the stable CLI HOME against the operator HOME,
 * whose W_HOME warnings vary by host; composer warnings are read without them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposeTargetInput, ComposeTargetResult, ComposedTargetBundle } from 'spaces-config'
import { MuseAdapter } from './adapters/muse-adapter.js'
import { MUSE_AGENTS_FILE, MUSE_MANIFEST_FILE, MUSE_SETTINGS_FILE } from './composer.js'
import type { MuseManifest } from './composer.js'

const adapter = new MuseAdapter()

let tmpRoot: string

interface TestSpace {
  spaceId: string
  version: string
  dir: string
}

async function writeSpace(spaceId: string, files: Record<string, string>): Promise<TestSpace> {
  const dir = join(tmpRoot, `space-${spaceId}`)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  return { spaceId, version: '1.0.0', dir }
}

function composeInput(spaces: TestSpace[]): ComposeTargetInput {
  return {
    targetName: 'dev',
    compose: [],
    roots: [],
    loadOrder: [],
    artifacts: spaces.map((space) => ({
      spaceKey: `${space.spaceId}@${space.version}`,
      spaceId: space.spaceId,
      artifactPath: space.dir,
      pluginName: space.spaceId,
      pluginVersion: space.version,
    })),
    settingsInputs: [],
  } as ComposeTargetInput
}

/** Compose through the adapter; returns the muse bundle section and composer warnings. */
async function compose(
  spaces: TestSpace[],
  outDir: string
): Promise<{
  muse: NonNullable<ComposedTargetBundle['muse']>
  warnings: ComposeTargetResult['warnings']
}> {
  const { bundle, warnings } = await adapter.composeTarget(composeInput(spaces), outDir, {
    clean: true,
  })
  if (!bundle.muse) throw new Error('expected composeTarget to produce a muse bundle section')
  return { muse: bundle.muse, warnings: warnings.filter((w) => w.code !== 'W_HOME') }
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
    const outDir = join(tmpRoot, 'bundle')

    const { muse, warnings } = await compose([alpha, beta], outDir)

    expect(warnings).toEqual([])
    expect(muse.workspaceDir).toBe(join(outDir, 'muse.workspace'))

    const agents = await readFile(muse.agentsPath, 'utf-8')
    expect(agents).toContain('<!-- BEGIN space: alpha@1.0.0 -->')
    expect(agents).toContain('# Alpha')
    expect(agents).toContain('<!-- BEGIN space: beta@1.0.0 -->')
    expect(agents).toContain('# Beta')
    expect(agents.indexOf('alpha@1.0.0')).toBeLessThan(agents.indexOf('beta@1.0.0'))

    const settings = JSON.parse(await readFile(muse.settingsPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['alpha', 'beta'])

    const manifest = JSON.parse(await readFile(muse.manifestPath, 'utf-8')) as MuseManifest
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

    const greeter = await readFile(join(muse.skillsDir, 'greeter', 'SKILL.md'), 'utf-8')
    expect(greeter).toContain('# Greeter')
    const farewell = await readFile(join(muse.skillsDir, 'farewell', 'SKILL.md'), 'utf-8')
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
    const { muse, warnings } = await compose([alpha, beta], join(tmpRoot, 'bundle'))

    const shared = await readFile(join(muse.skillsDir, 'shared', 'SKILL.md'), 'utf-8')
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
    const { muse, warnings } = await compose([alpha], join(tmpRoot, 'bundle'))

    const skillWarnings = warnings.filter((w) => w.code === 'W_SKILL')
    expect(skillWarnings).toHaveLength(2)
    expect(skillWarnings.map((w) => w.message).join('\n')).toContain('invalid-skill-package')

    const manifest = JSON.parse(await readFile(muse.manifestPath, 'utf-8')) as MuseManifest
    expect(manifest.skills).toEqual(['broken', 'noname'])
  })

  test('missing SKILL.md warns and empty MCP still writes deterministic settings', async () => {
    const alpha = await writeSpace('alpha', {
      'AGENTS.md': '# Alpha\n',
      'skills/empty/x.txt': 'not a skill package\n',
    })
    const { muse, warnings } = await compose([alpha], join(tmpRoot, 'bundle'))
    expect(
      warnings.some((w) => w.code === 'W_SKILL' && w.message.includes('missing SKILL.md'))
    ).toBe(true)
    const settings = await readFile(muse.settingsPath, 'utf-8')
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

    await compose([alpha], join(tmpRoot, 'first'))
    await compose([alpha], join(tmpRoot, 'second'))

    // muse.workspace only: the sibling muse.home metadata carries createdAt. The
    // fingerprint is the hash of manifest.json, so identical manifests fingerprint equal.
    const firstFiles = await readBundleFiles(join(tmpRoot, 'first'))
    const secondFiles = await readBundleFiles(join(tmpRoot, 'second'))
    expect(secondFiles).toEqual(firstFiles)
  })
})

describe('loadMuseWorkspaceBundle', () => {
  test('throws verbatim on a missing workspace', async () => {
    await expect(adapter.loadTargetBundle(join(tmpRoot, 'absent'), 'dev')).rejects.toThrow(
      'Muse workspace directory not found'
    )
  })
})
