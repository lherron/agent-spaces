/**
 * Compose-time hygiene gate — cache-admission behaviour (T-05574).
 *
 * Covers the shared helper predicate/baseline/force semantics, plus the
 * `materialize.ts` free-fn seam (the `asp build` path): a blocking finding throws
 * a typed `MaterializationHygieneError` and leaves NO cache entry; a baselined
 * finding is suppressed; a warning is advisory; force-compose admits the write and
 * carries findings out as `hygieneWarnings`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  type LockFile,
  MaterializationHygieneError,
  PROJECT_COMMIT_MARKER,
  type SpaceKey,
  type SpaceManifest,
  asSha256Integrity,
  asSpaceId,
} from '../core/index.js'
import { hygiene } from '../index.js'
import { build } from '../orchestration/build.js'
import { PathResolver, computePluginCacheKey, getCacheMetadata } from '../store/index.js'
import { evaluateHygieneGate } from './hygiene-gate.js'
import { materializeSpace } from './materialize.js'

const CACHE_KEY = (integrity: string) =>
  computePluginCacheKey(asSha256Integrity(integrity), 'probe', '1.0.0')

/** True iff a `.asp-cache.json` entry was written for this key (the admitted write). */
async function cacheWritten(integrity: string, paths: PathResolver): Promise<boolean> {
  return (await getCacheMetadata(CACHE_KEY(integrity), { paths })) !== null
}

const BROKEN_POINTER_SKILL = `---
name: probe-skill
description: A probe skill for the hygiene gate.
---

# Probe

See [the missing doc](./does-not-exist.md) for details.
`

const CLEAN_SKILL = `---
name: probe-skill
description: A probe skill for the hygiene gate.
---

# Probe

A clean skill body with no broken pointers.
`

// A skill that only trips an advisory (warning/info) finding: an orphaned bundled
// file (W420, warning) — a reference file no pointer reaches. No error-severity.
const ADVISORY_SKILL = `---
name: probe-skill
description: A probe skill for the hygiene gate.
---

# Probe

A clean body — the orphaned reference file trips only an advisory finding.
`

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'asp-hygiene-gate-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write a snapshot source tree with one skill; return its absolute path. */
async function writeSnapshot(skillBody: string, extraFiles: Record<string, string> = {}) {
  const snapshotPath = join(root, 'snapshot')
  const skillDir = join(snapshotPath, 'skills', 'probe-skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), skillBody)
  await writeFile(join(snapshotPath, 'space.toml'), '[plugin]\nname = "probe"\nversion = "1.0.0"\n')
  for (const [rel, body] of Object.entries(extraFiles)) {
    const p = join(skillDir, rel)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, body)
  }
  return snapshotPath
}

function materializeInput(snapshotPath: string) {
  const manifest: SpaceManifest = {
    schema: 1,
    id: asSpaceId('probe'),
    version: '1.0.0',
    plugin: { name: 'probe', version: '1.0.0' },
  }
  return {
    spaceKey: 'probe@abc1234' as SpaceKey,
    manifest,
    integrity: asSha256Integrity(`sha256:${'a'.repeat(64)}`),
    snapshotPath,
  }
}

describe('evaluateHygieneGate predicate', () => {
  test('flags an error-severity broken pointer (W421) as blocking', async () => {
    const snapshotPath = await writeSnapshot(BROKEN_POINTER_SKILL)
    const gate = await evaluateHygieneGate({
      pluginPath: snapshotPath, // lint the source tree directly for the unit assertion
      sourceRoot: snapshotPath,
      spaceKey: 'probe@abc1234',
    })
    expect(gate.blocking.length).toBeGreaterThanOrEqual(1)
    expect(gate.blocking.every((f) => f.severity === 'error')).toBe(true)
    expect(gate.blocking.some((f) => f.code === 'W421')).toBe(true)
    expect(gate.blocking[0]?.spaceKey).toBe('probe@abc1234')
  })

  test('a clean tree produces no blocking findings', async () => {
    const snapshotPath = await writeSnapshot(CLEAN_SKILL)
    const gate = await evaluateHygieneGate({
      pluginPath: snapshotPath,
      sourceRoot: snapshotPath,
      spaceKey: 'probe@abc1234',
    })
    expect(gate.blocking).toHaveLength(0)
  })

  test('a tree with no skills/ dir passes (nothing to lint)', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty, { recursive: true })
    const gate = await evaluateHygieneGate({
      pluginPath: empty,
      sourceRoot: empty,
      spaceKey: 'probe@abc1234',
    })
    expect(gate.blocking).toHaveLength(0)
    expect(gate.findings).toHaveLength(0)
  })
})

describe('materialize.ts cache-admission seam', () => {
  test('test 1: unsuppressed W421 throws typed error and writes NO cache entry', async () => {
    const snapshotPath = await writeSnapshot(BROKEN_POINTER_SKILL)
    const aspHome = join(root, 'asp-home')
    const paths = new PathResolver({ aspHome })
    const input = materializeInput(snapshotPath)

    let thrown: unknown
    try {
      await materializeSpace(input, { paths })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MaterializationHygieneError)
    const hygieneErr = thrown as MaterializationHygieneError
    expect(hygieneErr.code).toBe('MATERIALIZATION_HYGIENE_ERROR')
    expect(hygieneErr.spaceKey).toBe(input.spaceKey)
    expect(hygieneErr.findings.some((f) => f.code === 'W421')).toBe(true)

    // No blessed cache entry was written.
    expect(await cacheWritten(input.integrity, paths)).toBe(false)
  })

  test('test 2: same W421 recorded in .hygiene-baseline.json is suppressed', async () => {
    const snapshotPath = await writeSnapshot(BROKEN_POINTER_SKILL)
    const aspHome = join(root, 'asp-home')
    const paths = new PathResolver({ aspHome })
    const input = materializeInput(snapshotPath)

    // Author the baseline against the SOURCE tree's skills, anchored at the source
    // root (the gate anchors materialized findings at the plugin root, so the
    // space-root-relative paths match).
    const { warnings } = await hygiene.runHygieneTarget(join(snapshotPath, 'skills'))
    await hygiene.writeBaseline(
      join(snapshotPath, '.hygiene-baseline.json'),
      warnings,
      snapshotPath
    )

    const result = await materializeSpace(input, { paths })
    expect(result.cached).toBe(false)
    expect(result.hygieneWarnings).toBeUndefined()
    expect(await cacheWritten(input.integrity, paths)).toBe(true)
  })

  test('test 3: an advisory-only finding succeeds and writes the cache', async () => {
    // Orphaned bundled file (W420, warning) — advisory, must not block.
    const snapshotPath = await writeSnapshot(ADVISORY_SKILL, {
      'orphan-notes.md': '# Orphan\nNothing points here.\n',
    })
    const aspHome = join(root, 'asp-home')
    const paths = new PathResolver({ aspHome })
    const input = materializeInput(snapshotPath)

    // Sanity: the tree has a non-error advisory finding but no blocking one.
    const gate = await evaluateHygieneGate({
      pluginPath: snapshotPath,
      sourceRoot: snapshotPath,
      spaceKey: input.spaceKey,
    })
    expect(gate.blocking).toHaveLength(0)

    const result = await materializeSpace(input, { paths })
    expect(result.cached).toBe(false)
    expect(await cacheWritten(input.integrity, paths)).toBe(true)
  })

  test('test 4: force-compose admits the write and carries findings as warnings', async () => {
    const snapshotPath = await writeSnapshot(BROKEN_POINTER_SKILL)
    const aspHome = join(root, 'asp-home')
    const paths = new PathResolver({ aspHome })
    const input = materializeInput(snapshotPath)

    const prev = process.env['ASP_FORCE_COMPOSE_HYGIENE']
    process.env['ASP_FORCE_COMPOSE_HYGIENE'] = '1'
    try {
      const result = await materializeSpace(input, { paths })
      expect(result.cached).toBe(false)
      expect(result.hygieneWarnings?.some((f) => f.code === 'W421')).toBe(true)
      expect(await cacheWritten(input.integrity, paths)).toBe(true)
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'ASP_FORCE_COMPOSE_HYGIENE')
      else process.env['ASP_FORCE_COMPOSE_HYGIENE'] = prev
    }
  })
})

describe('build-path project-space characterization (T-05575)', () => {
  test('project-space skills do not enter the build-path plugin tree, so W421 does not gate', async () => {
    const projectPath = join(root, 'project')
    const registryPath = join(root, 'registry')
    const aspHome = join(root, 'asp-home')
    const outputDir = join(root, 'build-out')
    const projectSpacePath = join(projectPath, 'spaces', 'probe')
    const skillDir = join(projectSpacePath, 'skills', 'probe-skill')
    await mkdir(skillDir, { recursive: true })
    await mkdir(registryPath, { recursive: true })
    await writeFile(
      join(projectSpacePath, 'space.toml'),
      'schema = 1\nid = "probe"\nversion = "1.0.0"\n\n[plugin]\nname = "probe"\nversion = "1.0.0"\n'
    )
    await writeFile(join(skillDir, 'SKILL.md'), BROKEN_POINTER_SKILL)

    const sourceHygiene = await hygiene.runHygieneTarget(join(projectSpacePath, 'skills'))
    expect(sourceHygiene.warnings.some((f) => f.code === 'W421' && f.severity === 'error')).toBe(
      true
    )

    const integrity = asSha256Integrity(`sha256:${'b'.repeat(64)}`)
    const spaceKey = 'probe@project' as SpaceKey
    const lock: LockFile = {
      lockfileVersion: 1,
      resolverVersion: 1,
      generatedAt: '2026-07-04T00:00:00.000Z',
      registry: { type: 'git', url: registryPath },
      spaces: {
        [spaceKey]: {
          id: asSpaceId('probe'),
          commit: PROJECT_COMMIT_MARKER,
          path: 'spaces/probe',
          integrity,
          plugin: { name: 'probe', version: '1.0.0' },
          deps: { spaces: [] },
          resolvedFrom: { selector: 'dev' },
          projectSpace: true,
        },
      },
      targets: {
        default: {
          compose: ['space:project:probe@dev'],
          roots: [spaceKey],
          loadOrder: [spaceKey],
          envHash: integrity,
        },
      },
    }
    await writeFile(join(projectPath, 'asp-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)

    const result = await build('default', {
      aspHome,
      projectPath,
      registryPath,
      outputDir,
      autoInstall: false,
      runLint: false,
    })

    expect(result.pluginDirs).toHaveLength(1)
    const pluginDir = result.pluginDirs[0]
    expect(pluginDir).toBeDefined()
    expect(await readFile(join(pluginDir!, '.claude-plugin', 'plugin.json'), 'utf8')).toContain(
      '"name": "probe"'
    )
    await expect(
      readFile(join(pluginDir!, 'skills', 'probe-skill', 'SKILL.md'), 'utf8')
    ).rejects.toThrow()
    expect(result.warnings).toHaveLength(0)
  })
})
