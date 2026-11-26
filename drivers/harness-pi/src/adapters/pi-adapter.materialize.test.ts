import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type MaterializeSpaceInput,
  type ResolvedSpaceManifest,
  type SpaceId,
  type SpaceKey,
  asSpaceId,
} from 'spaces-config'
import { PiAdapter } from './pi-adapter.js'

/**
 * Create a minimal space manifest for testing
 */
function createTestManifest(overrides: Partial<ResolvedSpaceManifest> = {}): ResolvedSpaceManifest {
  const id = overrides.id ?? asSpaceId('test-space')
  return {
    schema: 1,
    id,
    version: '1.0.0',
    plugin: { name: id },
    ...overrides,
  }
}

/**
 * Create a space key for testing
 */
function createSpaceKey(id = 'test-space', commit = 'abc123'): SpaceKey {
  return `${id}@${commit}` as SpaceKey
}

/**
 * Create MaterializeSpaceInput for testing
 */
function createMaterializeInput(
  snapshotPath: string,
  manifestOverrides: Partial<ResolvedSpaceManifest> = {}
): MaterializeSpaceInput {
  return {
    spaceKey: createSpaceKey(),
    manifest: createTestManifest(manifestOverrides),
    snapshotPath,
    integrity: 'sha256-test',
  }
}

describe('PiAdapter', () => {
  const adapter = new PiAdapter()

  describe('validateSpace', () => {
    test('validates any space as valid', () => {
      const input = createMaterializeInput('/test/snapshot', { id: asSpaceId('valid-space') })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('accepts space without extensions', () => {
      const input = createMaterializeInput('/test/snapshot', { id: asSpaceId('no-extensions') })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('accepts space with any id format', () => {
      // deliberately not kebab-case: asserts the Pi adapter does not validate id format
      const nonKebabId = 'MySpaceId_123' as SpaceId
      const input = createMaterializeInput('/test/snapshot', { id: nonKebabId })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
    })
  })

  describe('materializeSpace', () => {
    let tmpDir: string
    let snapshotDir: string
    let cacheDir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `pi-adapter-materialize-${Date.now()}`)
      snapshotDir = join(tmpDir, 'snapshot')
      cacheDir = join(tmpDir, 'cache')

      await mkdir(snapshotDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('creates extensions directory', async () => {
      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.artifactPath).toBe(cacheDir)
    })

    test('bundles TypeScript extensions with namespacing', async () => {
      // Create extensions directory with a simple TS file
      const extensionsDir = join(snapshotDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(
        join(extensionsDir, 'my-tool.ts'),
        `
export function hello() {
  return 'hello from extension';
}
`
      )

      const input = createMaterializeInput(snapshotDir, { id: asSpaceId('my-space') })

      const result = await adapter.materializeSpace(input, cacheDir, {})

      // Extension should be namespaced: my-space__my-tool.js
      expect(result.files).toContain('extensions/my-space__my-tool.js')
    })

    test('bundles JavaScript extensions with namespacing', async () => {
      const extensionsDir = join(snapshotDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(
        join(extensionsDir, 'utility.js'),
        `
export function util() { return 42; }
`
      )

      const input = createMaterializeInput(snapshotDir, { id: asSpaceId('utils') })

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files).toContain('extensions/utils__utility.js')
    })

    test('omits inert artifact contents while composing live Pi resources', async () => {
      await writeFile(join(snapshotDir, 'AGENT.md'), '# Agent Instructions for Pi')
      await mkdir(join(snapshotDir, 'shared'), { recursive: true })
      await writeFile(join(snapshotDir, 'shared/shared-note.txt'), 'shared')
      await mkdir(join(snapshotDir, 'scripts'), { recursive: true })
      await writeFile(join(snapshotDir, 'scripts/helper.sh'), 'echo inert')
      await mkdir(join(snapshotDir, 'extensions'), { recursive: true })
      await writeFile(join(snapshotDir, 'extensions/tool.js'), 'export default {}')
      await mkdir(join(snapshotDir, 'skills/my-skill'), { recursive: true })
      await writeFile(join(snapshotDir, 'skills/my-skill/SKILL.md'), '# Skill')
      await mkdir(join(snapshotDir, 'hooks/scripts'), { recursive: true })
      await writeFile(join(snapshotDir, 'hooks/scripts/validate.sh'), 'echo hook')
      await writeFile(
        join(snapshotDir, 'hooks/hooks.toml'),
        '[[hook]]\nevent = "pre_tool_use"\nscript = "scripts/validate.sh"\n'
      )

      const input = createMaterializeInput(snapshotDir)
      const result = await adapter.materializeSpace(input, cacheDir, {})
      expect(result.files).not.toContain('AGENT.md')
      expect(await Bun.file(join(cacheDir, 'AGENT.md')).exists()).toBe(false)
      expect(await Bun.file(join(cacheDir, 'shared-note.txt')).exists()).toBe(false)
      expect(await Bun.file(join(cacheDir, 'scripts/helper.sh')).exists()).toBe(false)
      expect(result.files).toContain('extensions/test-space__tool.js')
      expect(result.files).toContain('skills/my-skill')
      expect(result.files).toContain('hooks-scripts/hooks.toml')

      const outputDir = join(tmpDir, 'bundle')
      const composed = await adapter.composeTarget(
        {
          targetName: 'test-target',
          compose: ['test-space' as any],
          roots: [input.spaceKey],
          loadOrder: [input.spaceKey],
          artifacts: [
            {
              spaceKey: input.spaceKey,
              spaceId: 'test-space',
              artifactPath: result.artifactPath,
              pluginName: 'test-plugin',
            },
          ],
          settingsInputs: [],
        },
        outputDir,
        {}
      )
      const bundle = composed.bundle
      expect(await Bun.file(join(outputDir, 'extensions/test-space__tool.js')).exists()).toBe(true)
      expect(await Bun.file(join(outputDir, 'skills/my-skill/SKILL.md')).exists()).toBe(true)
      expect(await Bun.file(join(outputDir, 'hooks-scripts/scripts/validate.sh')).exists()).toBe(
        true
      )
      expect(await Bun.file(join(outputDir, 'settings.json')).exists()).toBe(true)
      expect(await Bun.file(bundle.pi!.hookBridgePath!).text()).toContain('validate.sh')
      expect(await Bun.file(bundle.pi!.hrcEventsBridgePath!).exists()).toBe(true)
      const args = adapter.buildRunArgs(bundle, {})
      expect(args).toContain(join(outputDir, 'extensions/test-space__tool.js'))
      expect(args).toContain(bundle.pi!.hookBridgePath!)
      expect(args).toContain(bundle.pi!.hrcEventsBridgePath!)
      expect(args).toContain('--no-skills')
      const skillFlagIndex = args.indexOf('--skill')
      expect(skillFlagIndex === -1 ? undefined : args[skillFlagIndex + 1]).toBe(
        join(outputDir, 'skills')
      )
      expect(adapter.getRunEnv(bundle, {})['PI_CODING_AGENT_DIR']).toBe(outputDir)
    })

    test('copies skills directory', async () => {
      // Create skills directory
      const skillsDir = join(snapshotDir, 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'my-skill.md'), '# Skill Instructions')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files.some((f) => f.includes('skills'))).toBe(true)
    })

    test('copies hooks directory', async () => {
      // Create hooks directory with a script
      const hooksDir = join(snapshotDir, 'hooks')
      await mkdir(hooksDir, { recursive: true })
      await writeFile(join(hooksDir, 'pre-tool.sh'), '#!/bin/bash\necho "hook"')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files.some((f) => f.includes('hooks'))).toBe(true)
    })

    test('copies permissions.toml when present', async () => {
      await writeFile(
        join(snapshotDir, 'permissions.toml'),
        `
[read]
paths = ["/tmp"]

[exec]
allow = ["ls", "cat"]
`
      )

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files).toContain('permissions.toml')
    })

    test('returns artifact path', async () => {
      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.artifactPath).toBe(cacheDir)
    })

    test('cleans cache directory when force: true', async () => {
      // Create existing file in cache
      await writeFile(join(cacheDir, 'old-file.txt'), 'old content')

      const input = createMaterializeInput(snapshotDir)

      await adapter.materializeSpace(input, cacheDir, { force: true })

      // Old file should be gone
      const oldFileExists = await Bun.file(join(cacheDir, 'old-file.txt')).exists()
      expect(oldFileExists).toBe(false)
    })

    test('respects pi.build options from manifest', async () => {
      // Create extension
      const extensionsDir = join(snapshotDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(
        join(extensionsDir, 'tool.ts'),
        `
export function tool() { return 'built with options'; }
`
      )

      // Manifest with pi build options
      const manifestWithPi = createTestManifest({
        id: asSpaceId('config-space'),
        pi: {
          build: {
            format: 'cjs',
            target: 'node',
          },
        },
      })

      const input: MaterializeSpaceInput = {
        spaceKey: createSpaceKey('config-space'),
        manifest: manifestWithPi,
        snapshotPath: snapshotDir,
        integrity: 'sha256-test',
      }

      const result = await adapter.materializeSpace(input, cacheDir, {})

      // Should have bundled the extension
      expect(result.files).toContain('extensions/config-space__tool.js')
    })
  })
})

describe('materializeSpace cleanup on failure', () => {
  let tmpDir: string
  let snapshotDir: string
  let cacheDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `pi-adapter-cleanup-${Date.now()}`)
    snapshotDir = join(tmpDir, 'snapshot')
    cacheDir = join(tmpDir, 'cache')
    await mkdir(snapshotDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('removes the cache directory when a non-bundle error is thrown mid-materialize', async () => {
    const adapter = new PiAdapter()

    // Force a non-PiBundleError failure inside bundleSpaceExtensions:
    // `mkdir(cacheDir/extensions, { recursive: true })` throws EEXIST/ENOTDIR
    // when `extensions` already exists as a file. A non-force call leaves the
    // pre-existing cacheDir untouched at entry, so the catch-block cleanup is
    // the only thing that can remove it.
    await writeFile(join(cacheDir, 'extensions'), 'not a directory')

    const input = createMaterializeInput(snapshotDir)

    await expect(adapter.materializeSpace(input, cacheDir, {})).rejects.toThrow()

    // The catch block recursively removes cacheDir on failure.
    const cacheExists = await Bun.file(join(cacheDir, 'extensions')).exists()
    expect(cacheExists).toBe(false)
  })
})
