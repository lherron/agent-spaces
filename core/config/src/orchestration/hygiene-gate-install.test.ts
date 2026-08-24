/**
 * Compose-time hygiene gate at the install.ts cache-admission seam (T-05574).
 *
 * This is the seam the ASPC compile path reaches: `materializeTarget` →
 * `materializeSpaceEntry` → immutable-registry `ensurePublishedCache` →
 * `writeCacheMetadataAt`. The amendment retargets the aspc surfacing test to an
 * immutable registry fresh write so it exercises THIS branch.
 *
 * Covers:
 *  - immutable registry fresh write with an unsuppressed W421 → blocks (throws the
 *    typed error) and writes NO cache entry;
 *  - cache-hit bypass + integrity-change re-evaluation (orig test 7);
 *  - scope characterization: mutable dev/agent/project staging is NOT gated;
 *  - force-compose admits the immutable write and threads findings up.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  type CommitSha,
  type ComposeTargetInput,
  type ComposeTargetOptions,
  type ComposeTargetResult,
  type ComposedTargetBundle,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessId,
  type HarnessModelInfo,
  type HarnessRunOptions,
  type HarnessValidationResult,
  type LockFile,
  MaterializationHygieneError,
  type MaterializeSpaceInput,
  type MaterializeSpaceOptions,
  type MaterializeSpaceResult,
  type Sha256Integrity,
  type SpaceId,
  type SpaceKey,
  type SpaceRefString,
} from '../core/index.js'
import { cacheExists, computeHarnessPluginCacheKey } from '../store/cache.js'
import { PathResolver } from '../store/paths.js'
import { materializeTarget } from './install.js'

const BROKEN_SKILL = `---
name: probe-skill
description: A probe skill.
---

# Probe

See [the missing doc](./does-not-exist.md).
`

const CLEAN_SKILL = `---
name: probe-skill
description: A probe skill.
---

# Probe

Clean body.
`

/** Adapter that writes one skill (configurable body) into the staging dir. */
class SkillAdapter implements HarnessAdapter {
  readonly id = 'codex' as HarnessId
  readonly name = 'Skill Test Adapter'
  readonly models: HarnessModelInfo[] = []
  constructor(private readonly skillBody: string) {}

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
    await writeFile(join(skillDir, 'SKILL.md'), this.skillBody)
    return { artifactPath: cacheDir, files: ['skills/probe-skill'], warnings: [] }
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
  buildRunArgs(): string[] {
    return []
  }
  getTargetOutputPath(dir: string, targetName: string): string {
    return join(dir, targetName, this.id)
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
  getRunEnv(): Record<string, string> {
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
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

interface Fixture {
  aspHome: string
  projectPath: string
  registryPath: string
  lock: LockFile
  cacheKey: string
  paths: PathResolver
}

async function makeFixture(opts: {
  commit: string
  integrity: string
  dev?: boolean
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'asp-hygiene-install-'))
  tempRoots.push(root)
  const aspHome = join(root, 'asp-home')
  const projectPath = join(root, 'project')
  const registryPath = join(root, 'registry')
  await mkdir(projectPath, { recursive: true })
  await mkdir(join(registryPath, 'spaces', 'probe'), { recursive: true })
  // dev spaces read source from registry/spaces/<id>; seed a space.toml there.
  await writeFile(
    join(registryPath, 'spaces', 'probe', 'space.toml'),
    '[plugin]\nname = "probe"\nversion = "1.0.0"\n'
  )

  const integrity = opts.integrity as Sha256Integrity
  const commit = opts.commit as CommitSha
  const spaceKey = (opts.dev ? 'probe@dev' : `probe@${commit.slice(0, 7)}`) as SpaceKey
  const paths = new PathResolver({ aspHome })

  // Immutable registry entries read from the content-addressed snapshot.
  if (!opts.dev) {
    const snapshotPath = paths.snapshot(integrity)
    await mkdir(snapshotPath, { recursive: true })
    await writeFile(
      join(snapshotPath, 'space.toml'),
      '[plugin]\nname = "probe"\nversion = "1.0.0"\n'
    )
  }

  const lock: LockFile = {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: '2026-07-04T00:00:00.000Z',
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
  return { aspHome, projectPath, registryPath, lock, cacheKey, paths }
}

function runOpts(fx: Fixture, adapter: SkillAdapter) {
  return {
    aspHome: fx.aspHome,
    projectPath: fx.projectPath,
    registryPath: fx.registryPath,
    harness: adapter.id,
    adapter,
  }
}

const IMMUTABLE_COMMIT = 'b'.repeat(40)
const INTEGRITY_A = `sha256:${'a'.repeat(64)}`
const INTEGRITY_B = `sha256:${'c'.repeat(64)}`

describe('install.ts immutable-registry cache-admission seam', () => {
  test('blocks an unsuppressed W421 and writes NO cache entry', async () => {
    const fx = await makeFixture({ commit: IMMUTABLE_COMMIT, integrity: INTEGRITY_A })
    const adapter = new SkillAdapter(BROKEN_SKILL)

    let thrown: unknown
    try {
      await materializeTarget('default', fx.lock, runOpts(fx, adapter))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MaterializationHygieneError)
    expect((thrown as MaterializationHygieneError).findings.some((f) => f.code === 'W421')).toBe(
      true
    )
    // No blessed cache entry — the staging dir was removed on the throw.
    expect(await cacheExists(fx.cacheKey, { paths: fx.paths })).toBe(false)
  })

  test('force-compose admits the write and threads findings up', async () => {
    const fx = await makeFixture({ commit: IMMUTABLE_COMMIT, integrity: INTEGRITY_A })
    const adapter = new SkillAdapter(BROKEN_SKILL)
    const prev = process.env['ASP_FORCE_COMPOSE_HYGIENE']
    process.env['ASP_FORCE_COMPOSE_HYGIENE'] = '1'
    try {
      const result = await materializeTarget('default', fx.lock, runOpts(fx, adapter))
      expect(result.hygieneWarnings?.some((f) => f.code === 'W421')).toBe(true)
      expect(await cacheExists(fx.cacheKey, { paths: fx.paths })).toBe(true)
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'ASP_FORCE_COMPOSE_HYGIENE')
      else process.env['ASP_FORCE_COMPOSE_HYGIENE'] = prev
    }
  })

  test('cache-key/source-integrity: clean write is a cache hit; changed integrity re-evaluates', async () => {
    // Clean write at integrity A → admitted + cached.
    const clean = await makeFixture({ commit: IMMUTABLE_COMMIT, integrity: INTEGRITY_A })
    const cleanAdapter = new SkillAdapter(CLEAN_SKILL)
    const first = await materializeTarget('default', clean.lock, runOpts(clean, cleanAdapter))
    expect(await cacheExists(clean.cacheKey, { paths: clean.paths })).toBe(true)

    // Re-run same lock → cache hit, not re-blocked, same output.
    const second = await materializeTarget('default', clean.lock, runOpts(clean, cleanAdapter))
    expect(second.outputPath).toBe(first.outputPath)

    // A DIFFERENT integrity (changed source) → different cache key → the fresh
    // write is gate-evaluated. Broken content now blocks.
    const changed = await makeFixture({ commit: IMMUTABLE_COMMIT, integrity: INTEGRITY_B })
    const brokenAdapter = new SkillAdapter(BROKEN_SKILL)
    let thrown: unknown
    try {
      await materializeTarget('default', changed.lock, runOpts(changed, brokenAdapter))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MaterializationHygieneError)
    expect(await cacheExists(changed.cacheKey, { paths: changed.paths })).toBe(false)
  })
})

describe('scope characterization: mutable staging is NOT cache-gated', () => {
  test('a mutable dev space with a broken pointer materializes without blocking', async () => {
    const fx = await makeFixture({ commit: 'dev', integrity: INTEGRITY_A, dev: true })
    const adapter = new SkillAdapter(BROKEN_SKILL)
    // Must NOT throw — mutable staging is never admitted to reusable cache, so the
    // cache-admission gate does not apply (widening it would be boot-time policy).
    const result = await materializeTarget('default', fx.lock, runOpts(fx, adapter))
    expect(result.hygieneWarnings).toBeUndefined()
  })
})
