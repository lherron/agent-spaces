import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type {
  CommitSha,
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessId,
  HarnessModelInfo,
  HarnessRunOptions,
  HarnessValidationResult,
  LockFile,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  Sha256Integrity,
  SpaceId,
  SpaceKey,
  SpaceRefString,
} from '../core/index.js'
import { cacheExists, computeHarnessPluginCacheKey, getCacheMetadata } from '../store/cache.js'
import { PathResolver } from '../store/paths.js'

import { materializeTarget } from './install.js'

class DirectoryArtifactAdapter implements HarnessAdapter {
  readonly id = 'codex' as HarnessId
  readonly name = 'Directory Artifact Test Adapter'
  readonly models: HarnessModelInfo[] = []

  async detect(): Promise<HarnessDetection> {
    return { available: true, command: 'fake-codex' }
  }

  validateSpace(_input: MaterializeSpaceInput): HarnessValidationResult {
    return { valid: true, errors: [], warnings: [] }
  }

  async materializeSpace(
    _input: MaterializeSpaceInput,
    cacheDir: string,
    _options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const skillDir = join(cacheDir, 'skills', 'probe-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: probe-skill\n---\n# Probe\n')
    return {
      artifactPath: cacheDir,
      files: ['skills/probe-skill'],
      warnings: [],
    }
  }

  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    _options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const pluginDir = join(outputDir, 'plugins', '000-probe')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'artifact-count.txt'), String(input.artifacts.length))
    const settingsPath = join(outputDir, 'settings.json')
    await writeFile(settingsPath, '{}\n')
    return {
      bundle: {
        harnessId: this.id,
        targetName: input.targetName,
        rootDir: outputDir,
        pluginDirs: [pluginDir],
        settingsPath,
      },
      warnings: [],
    }
  }

  buildRunArgs(_bundle: ComposedTargetBundle, _options: HarnessRunOptions): string[] {
    return []
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, this.id)
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    return {
      harnessId: this.id,
      targetName,
      rootDir: outputDir,
      pluginDirs: [join(outputDir, 'plugins', '000-probe')],
      settingsPath: join(outputDir, 'settings.json'),
    }
  }

  getRunEnv(_bundle: ComposedTargetBundle, _options: HarnessRunOptions): Record<string, string> {
    return {}
  }

  getDefaultRunOptions(): Partial<HarnessRunOptions> {
    return {}
  }
}

let tempRoots: string[] = []

afterEach(async () => {
  const roots = tempRoots
  tempRoots = []
  await Promise.all(roots.map((root) => Bun.$`rm -rf ${root}`.quiet()))
})

async function createTargetFixture(): Promise<{
  aspHome: string
  projectPath: string
  registryPath: string
  lock: LockFile
  cacheKey: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'asp-materialization-cache-'))
  tempRoots.push(root)
  const aspHome = join(root, 'asp-home')
  const projectPath = join(root, 'project')
  const registryPath = join(root, 'registry')
  await mkdir(projectPath, { recursive: true })
  await mkdir(registryPath, { recursive: true })

  const integrity = `sha256:${'a'.repeat(64)}` as Sha256Integrity
  const commit = 'b'.repeat(40) as CommitSha
  const spaceKey = `probe@${commit.slice(0, 7)}` as SpaceKey
  const paths = new PathResolver({ aspHome })
  const snapshotPath = paths.snapshot(integrity)
  await mkdir(snapshotPath, { recursive: true })
  await writeFile(join(snapshotPath, 'space.toml'), '[plugin]\nname = "probe"\nversion = "1.0.0"\n')

  const lock: LockFile = {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: '2026-06-09T00:00:00.000Z',
    registry: { type: 'git', url: registryPath },
    spaces: {
      [spaceKey]: {
        id: 'probe' as SpaceId,
        commit,
        path: 'spaces/probe',
        integrity,
        plugin: { name: 'probe', version: '1.0.0' },
        deps: { spaces: [] },
      },
    },
    targets: {
      default: {
        compose: ['probe' as SpaceRefString],
        roots: [spaceKey],
        loadOrder: [spaceKey],
        envHash: integrity,
      },
    },
  }

  const cacheKey = computeHarnessPluginCacheKey(
    'codex',
    'plugin-materializer-v3-complete',
    integrity,
    'probe',
    '1.0.0'
  )

  return { aspHome, projectPath, registryPath, lock, cacheKey }
}

describe('materialization cache publication', () => {
  test('validates directory cache entries and reuses the published cache under parallel materialization', async () => {
    const fixture = await createTargetFixture()
    const adapter = new DirectoryArtifactAdapter()
    const paths = new PathResolver({ aspHome: fixture.aspHome })

    const [first, second] = await Promise.all([
      materializeTarget('default', fixture.lock, {
        aspHome: fixture.aspHome,
        projectPath: fixture.projectPath,
        registryPath: fixture.registryPath,
        harness: adapter.id,
        adapter,
      }),
      materializeTarget('default', fixture.lock, {
        aspHome: fixture.aspHome,
        projectPath: fixture.projectPath,
        registryPath: fixture.registryPath,
        harness: adapter.id,
        adapter,
      }),
    ])

    expect(first.outputPath).toBe(second.outputPath)
    expect(await cacheExists(fixture.cacheKey, { paths })).toBe(true)
    const metadata = await getCacheMetadata(fixture.cacheKey, { paths })
    expect(metadata?.requiredEntries).toContainEqual({
      path: 'skills/probe-skill',
      kind: 'directory',
    })

    const metaPath = join(paths.pluginCache(fixture.cacheKey), '.asp-cache.json')
    const legacyMetadata = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    legacyMetadata['requiredEntries'] = undefined
    await writeFile(metaPath, `${JSON.stringify(legacyMetadata, null, 2)}\n`)
    expect(await cacheExists(fixture.cacheKey, { paths })).toBe(true)
  })

  test('does not include generated cache metadata in target fingerprints', async () => {
    const fixture = await createTargetFixture()
    const adapter = new DirectoryArtifactAdapter()
    const paths = new PathResolver({ aspHome: fixture.aspHome })

    const first = await materializeTarget('default', fixture.lock, {
      aspHome: fixture.aspHome,
      projectPath: fixture.projectPath,
      registryPath: fixture.registryPath,
      harness: adapter.id,
      adapter,
    })

    const metaPath = join(paths.pluginCache(fixture.cacheKey), '.asp-cache.json')
    const metadata = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    metadata['createdAt'] = '2099-01-01T00:00:00.000Z'
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`)

    const second = await materializeTarget('default', fixture.lock, {
      aspHome: fixture.aspHome,
      projectPath: fixture.projectPath,
      registryPath: fixture.registryPath,
      harness: adapter.id,
      adapter,
    })

    expect(second.outputPath).toBe(first.outputPath)
  })
})
