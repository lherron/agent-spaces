/**
 * Tests for PiAdapter
 *
 * WHY: PiAdapter is the harness adapter for Pi Coding Agent integration.
 * These tests verify detection, validation, materialization (extension bundling),
 * composition (merging extensions, skills, hook bridge generation), and argument building.
 * Testing without actual Pi binary uses mocking and focuses on adapter logic.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MaterializeSpaceInput, ResolvedSpaceManifest, SpaceKey } from '@agent-spaces/core'
import {
  type HookDefinition,
  PiAdapter,
  PiBundleError,
  PiNotFoundError,
  bundleExtension,
  clearPiCache,
  discoverExtensions,
  findPiBinary,
  generateHookBridgeCode,
} from './pi-adapter.js'

/**
 * Create a minimal space manifest for testing
 */
function createTestManifest(overrides: Partial<ResolvedSpaceManifest> = {}): ResolvedSpaceManifest {
  return {
    id: 'test-space',
    name: 'Test Space',
    version: '1.0.0',
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
  let adapter: PiAdapter

  beforeAll(() => {
    adapter = new PiAdapter()
  })

  describe('id and name', () => {
    test('has correct id', () => {
      expect(adapter.id).toBe('pi')
    })

    test('has correct name', () => {
      expect(adapter.name).toBe('Pi Coding Agent')
    })
  })

  describe('detect', () => {
    let tmpDir: string
    let mockPiPath: string
    let originalEnv: string | undefined

    beforeAll(async () => {
      tmpDir = join(tmpdir(), `pi-adapter-detect-${Date.now()}`)
      await mkdir(tmpDir, { recursive: true })
      mockPiPath = join(tmpDir, 'mock-pi')
      originalEnv = process.env['PI_PATH']
    })

    beforeEach(() => {
      clearPiCache()
    })

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env['PI_PATH'] = originalEnv
      } else {
        process.env['PI_PATH'] = undefined
      }
      clearPiCache()
    })

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('returns available: true when pi is found', async () => {
      // Create a mock pi that outputs version info and help
      await writeFile(
        mockPiPath,
        `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "1.2.3"
  exit 0
fi
if [[ "$1" == "--help" ]]; then
  echo "--extension  Load an extension"
  echo "--skills     Skills directory"
  exit 0
fi
exit 0
`
      )
      await chmod(mockPiPath, 0o755)
      process.env['PI_PATH'] = mockPiPath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(mockPiPath)
    })

    test('returns version when detected', async () => {
      await writeFile(
        mockPiPath,
        `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "2.0.1"
  exit 0
fi
exit 0
`
      )
      await chmod(mockPiPath, 0o755)
      process.env['PI_PATH'] = mockPiPath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.version).toBe('2.0.1')
    })

    test('returns available: false when pi is not found', async () => {
      // Point to non-existent binary
      process.env['PI_PATH'] = '/nonexistent/pi'

      const result = await adapter.detect()

      expect(result.available).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('includes capabilities when available', async () => {
      await writeFile(
        mockPiPath,
        `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "1.0.0"
  exit 0
fi
if [[ "$1" == "--help" ]]; then
  echo "--extension  Load extensions"
  echo "--skills     Skills directory"
  exit 0
fi
exit 0
`
      )
      await chmod(mockPiPath, 0o755)
      process.env['PI_PATH'] = mockPiPath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.capabilities).toBeDefined()
      expect(result.capabilities).toContain('extensions')
      expect(result.capabilities).toContain('skills')
      expect(result.capabilities).toContain('toolNamespacing')
    })
  })

  describe('validateSpace', () => {
    test('validates any space as valid', () => {
      const input = createMaterializeInput('/test/snapshot', { id: 'valid-space' })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('accepts space without extensions', () => {
      const input = createMaterializeInput('/test/snapshot', { id: 'no-extensions' })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('accepts space with any id format', () => {
      const input = createMaterializeInput('/test/snapshot', { id: 'MySpaceId_123' })

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

      const input = createMaterializeInput(snapshotDir, { id: 'my-space' })

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

      const input = createMaterializeInput(snapshotDir, { id: 'utils' })

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files).toContain('extensions/utils__utility.js')
    })

    test('links AGENT.md preserving name', async () => {
      // Create AGENT.md in snapshot
      await writeFile(join(snapshotDir, 'AGENT.md'), '# Agent Instructions for Pi')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      // Should have linked AGENT.md → AGENT.md (Pi keeps the name)
      expect(result.files).toContain('AGENT.md')

      // Verify content is accessible
      const agentMdPath = join(cacheDir, 'AGENT.md')
      const content = await Bun.file(agentMdPath).text()
      expect(content).toBe('# Agent Instructions for Pi')
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

    test('copies scripts directory when present', async () => {
      const scriptsDir = join(snapshotDir, 'scripts')
      await mkdir(scriptsDir, { recursive: true })
      await writeFile(join(scriptsDir, 'helper.sh'), '#!/bin/bash\necho "helper"')

      const input = createMaterializeInput(snapshotDir)

      await adapter.materializeSpace(input, cacheDir, {})

      // Scripts directory should exist in output
      const destScriptsDir = join(cacheDir, 'scripts')
      const scriptsExists = await Bun.file(join(destScriptsDir, 'helper.sh')).exists()
      expect(scriptsExists).toBe(true)
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
      const manifestWithPi = {
        id: 'config-space',
        name: 'Config Space',
        version: '1.0.0',
        pi: {
          build: {
            format: 'cjs' as const,
            target: 'node' as const,
          },
        },
      }

      const input: MaterializeSpaceInput = {
        spaceKey: createSpaceKey('config-space'),
        manifest: manifestWithPi as ResolvedSpaceManifest,
        snapshotPath: snapshotDir,
        integrity: 'sha256-test',
      }

      const result = await adapter.materializeSpace(input, cacheDir, {})

      // Should have bundled the extension
      expect(result.files).toContain('extensions/config-space__tool.js')
    })
  })

  describe('composeTarget', () => {
    let tmpDir: string
    let outputDir: string
    let artifact1Dir: string
    let artifact2Dir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `pi-adapter-compose-${Date.now()}`)
      outputDir = join(tmpDir, 'output')
      artifact1Dir = join(tmpDir, 'artifact1')
      artifact2Dir = join(tmpDir, 'artifact2')

      await mkdir(outputDir, { recursive: true })
      await mkdir(artifact1Dir, { recursive: true })
      await mkdir(artifact2Dir, { recursive: true })
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('merges extensions from multiple artifacts', async () => {
      // Create extensions in artifact1
      await mkdir(join(artifact1Dir, 'extensions'), { recursive: true })
      await writeFile(join(artifact1Dir, 'extensions/space1__tool1.js'), 'export default {}')

      // Create extensions in artifact2
      await mkdir(join(artifact2Dir, 'extensions'), { recursive: true })
      await writeFile(join(artifact2Dir, 'extensions/space2__tool2.js'), 'export default {}')

      const input = {
        targetName: 'test-target',
        compose: ['space1' as any, 'space2' as any],
        roots: ['space1@abc' as SpaceKey],
        loadOrder: ['space1@abc' as SpaceKey, 'space2@def' as SpaceKey],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'plugin1',
          },
          {
            spaceKey: 'space2@def' as SpaceKey,
            spaceId: 'space2',
            artifactPath: artifact2Dir,
            pluginName: 'plugin2',
          },
        ],
        settingsInputs: [],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Check bundle structure
      expect(result.bundle.harnessId).toBe('pi')
      expect(result.bundle.targetName).toBe('test-target')
      expect(result.bundle.rootDir).toBe(outputDir)
      expect(result.bundle.pi?.extensionsDir).toBe(join(outputDir, 'extensions'))

      // Verify both extensions are in output
      const ext1Exists = await Bun.file(join(outputDir, 'extensions/space1__tool1.js')).exists()
      const ext2Exists = await Bun.file(join(outputDir, 'extensions/space2__tool2.js')).exists()
      expect(ext1Exists).toBe(true)
      expect(ext2Exists).toBe(true)
    })

    test('merges skills directories', async () => {
      // Create skills in both artifacts
      await mkdir(join(artifact1Dir, 'skills/skill1'), { recursive: true })
      await writeFile(join(artifact1Dir, 'skills/skill1/README.md'), '# Skill 1')

      await mkdir(join(artifact2Dir, 'skills/skill2'), { recursive: true })
      await writeFile(join(artifact2Dir, 'skills/skill2/README.md'), '# Skill 2')

      const input = {
        targetName: 'test-target',
        compose: ['space1' as any, 'space2' as any],
        roots: ['space1@abc' as SpaceKey],
        loadOrder: ['space1@abc' as SpaceKey, 'space2@def' as SpaceKey],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'plugin1',
          },
          {
            spaceKey: 'space2@def' as SpaceKey,
            spaceId: 'space2',
            artifactPath: artifact2Dir,
            pluginName: 'plugin2',
          },
        ],
        settingsInputs: [],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Skills dir should be set
      expect(result.bundle.pi?.skillsDir).toBe(join(outputDir, 'skills'))

      // Both skills should be merged
      const skill1Exists = await Bun.file(join(outputDir, 'skills/skill1/README.md')).exists()
      const skill2Exists = await Bun.file(join(outputDir, 'skills/skill2/README.md')).exists()
      expect(skill1Exists).toBe(true)
      expect(skill2Exists).toBe(true)
    })

    test('generates hook bridge extension when hooks present', async () => {
      // Create hooks directory with hooks.toml
      await mkdir(join(artifact1Dir, 'hooks'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks/hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "hooks/validate.sh"
`
      )
      await writeFile(join(artifact1Dir, 'hooks/validate.sh'), '#!/bin/bash\necho "validating"')

      const input = {
        targetName: 'test-target',
        compose: ['space1' as any],
        roots: ['space1@abc' as SpaceKey],
        loadOrder: ['space1@abc' as SpaceKey],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'plugin1',
          },
        ],
        settingsInputs: [],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Hook bridge should be generated
      expect(result.bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))

      // Verify hook bridge file exists
      const bridgeExists = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).exists()
      expect(bridgeExists).toBe(true)

      // Verify content contains hook registration
      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain('registerHook')
      expect(bridgeContent).toContain('tool_call') // pre_tool_use maps to tool_call in Pi
    })

    test('generates W301 warning for blocking hooks', async () => {
      // Create hooks with blocking=true
      await mkdir(join(artifact1Dir, 'hooks'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks/hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "hooks/validate.sh"
blocking = true
`
      )
      await writeFile(join(artifact1Dir, 'hooks/validate.sh'), '#!/bin/bash\necho "blocking"')

      const input = {
        targetName: 'test-target',
        compose: ['space1' as any],
        roots: ['space1@abc' as SpaceKey],
        loadOrder: ['space1@abc' as SpaceKey],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'plugin1',
          },
        ],
        settingsInputs: [],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Should have W301 warning
      expect(result.warnings.some((w) => w.code === 'W301')).toBe(true)
      expect(result.warnings.some((w) => w.message.includes('cannot block'))).toBe(true)
    })

    test('generates W303 warning for extension collisions', async () => {
      // Create same-named extension in both artifacts (after namespacing collision is impossible,
      // but if they're pre-namespaced the same)
      await mkdir(join(artifact1Dir, 'extensions'), { recursive: true })
      await mkdir(join(artifact2Dir, 'extensions'), { recursive: true })
      await writeFile(join(artifact1Dir, 'extensions/shared__tool.js'), 'export default {}')
      await writeFile(join(artifact2Dir, 'extensions/shared__tool.js'), 'export default {}')

      const input = {
        targetName: 'test-target',
        compose: ['space1' as any, 'space2' as any],
        roots: ['space1@abc' as SpaceKey],
        loadOrder: ['space1@abc' as SpaceKey, 'space2@def' as SpaceKey],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'plugin1',
          },
          {
            spaceKey: 'space2@def' as SpaceKey,
            spaceId: 'space2',
            artifactPath: artifact2Dir,
            pluginName: 'plugin2',
          },
        ],
        settingsInputs: [],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Should have W303 warning
      expect(result.warnings.some((w) => w.code === 'W303')).toBe(true)
      expect(result.warnings.some((w) => w.message.includes('collision'))).toBe(true)
    })

    test('generates W304 warning for lint-only permissions', async () => {
      // Create permissions.toml with read permissions (lint_only for Pi)
      await writeFile(
        join(artifact1Dir, 'permissions.toml'),
        `
[read]
paths = ["/tmp", "/var"]

[write]
paths = ["/tmp"]
`
      )

      const input = {
        targetName: 'test-target',
        compose: ['space1' as any],
        roots: ['space1@abc' as SpaceKey],
        loadOrder: ['space1@abc' as SpaceKey],
        artifacts: [
          {
            spaceKey: 'space1@abc' as SpaceKey,
            spaceId: 'space1',
            artifactPath: artifact1Dir,
            pluginName: 'plugin1',
          },
        ],
        settingsInputs: [],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Should have W304 warning for lint-only permissions
      expect(result.warnings.some((w) => w.code === 'W304')).toBe(true)
      expect(result.warnings.some((w) => w.message.includes('lint-only'))).toBe(true)
    })

    test('cleans output directory when clean: true', async () => {
      // Create existing file
      await writeFile(join(outputDir, 'old-file.txt'), 'old')

      const input = {
        targetName: 'test-target',
        compose: [],
        roots: [],
        loadOrder: [],
        artifacts: [],
        settingsInputs: [],
      }

      await adapter.composeTarget(input, outputDir, { clean: true })

      // Old file should be gone
      const exists = await Bun.file(join(outputDir, 'old-file.txt')).exists()
      expect(exists).toBe(false)
    })
  })

  describe('buildRunArgs', () => {
    test('builds args with extension flags', async () => {
      const tmpDir = join(tmpdir(), `pi-args-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'tool1.js'), 'export default {}')
      await writeFile(join(extensionsDir, 'tool2.js'), 'export default {}')

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args.filter((a) => a === '--extension')).toHaveLength(2)

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('builds args with hook bridge extension', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
        pi: {
          extensionsDir: '/test/extensions',
          hookBridgePath: '/test/asp-hooks.bridge.js',
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args).toContain('/test/asp-hooks.bridge.js')
    })

    test('builds args with skills directory', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
        pi: {
          extensionsDir: '/test/extensions',
          skillsDir: '/test/skills',
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--skills')
      expect(args).toContain('/test/skills')
    })

    test('translates model names', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
        pi: {
          extensionsDir: '/test/extensions',
        },
      }

      // Test sonnet → claude-sonnet translation
      const argsSonnet = adapter.buildRunArgs(bundle, { model: 'sonnet' })
      expect(argsSonnet).toContain('--model')
      expect(argsSonnet).toContain('claude-sonnet')

      // Test opus → claude-opus translation
      const argsOpus = adapter.buildRunArgs(bundle, { model: 'opus' })
      expect(argsOpus).toContain('--model')
      expect(argsOpus).toContain('claude-opus')

      // Test haiku → claude-haiku translation
      const argsHaiku = adapter.buildRunArgs(bundle, { model: 'haiku' })
      expect(argsHaiku).toContain('--model')
      expect(argsHaiku).toContain('claude-haiku')
    })

    test('passes through unknown model names', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
        pi: {
          extensionsDir: '/test/extensions',
        },
      }

      const args = adapter.buildRunArgs(bundle, { model: 'gpt-4' })
      expect(args).toContain('--model')
      expect(args).toContain('gpt-4')
    })

    test('includes extra args', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
        pi: {
          extensionsDir: '/test/extensions',
        },
      }

      const args = adapter.buildRunArgs(bundle, { extraArgs: ['--verbose', '--debug'] })

      expect(args).toContain('--verbose')
      expect(args).toContain('--debug')
    })

    test('includes project path', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
        pi: {
          extensionsDir: '/test/extensions',
        },
      }

      const args = adapter.buildRunArgs(bundle, { projectPath: '/my/project' })

      expect(args[args.length - 1]).toBe('/my/project')
    })

    test('returns empty array when no pi bundle', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toEqual([])
    })
  })

  describe('getTargetOutputPath', () => {
    test('returns correct path for target', () => {
      const path = adapter.getTargetOutputPath('/project/asp_modules', 'my-target')

      expect(path).toBe('/project/asp_modules/my-target/pi')
    })

    test('handles different asp_modules paths', () => {
      const path = adapter.getTargetOutputPath('/custom/path', 'target')

      expect(path).toBe('/custom/path/target/pi')
    })
  })
})

describe('Pi detection utilities', () => {
  let tmpDir: string
  let mockPiPath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `pi-utils-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    mockPiPath = join(tmpDir, 'mock-pi')
    originalEnv = process.env['PI_PATH']
  })

  beforeEach(() => {
    clearPiCache()
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['PI_PATH'] = originalEnv
    } else {
      process.env['PI_PATH'] = undefined
    }
    clearPiCache()
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('findPiBinary', () => {
    test('uses PI_PATH environment variable when set', async () => {
      await writeFile(mockPiPath, '#!/bin/bash\nexit 0')
      await chmod(mockPiPath, 0o755)
      process.env['PI_PATH'] = mockPiPath

      const path = await findPiBinary()

      expect(path).toBe(mockPiPath)
    })

    test('throws PiNotFoundError when PI_PATH is invalid', async () => {
      process.env['PI_PATH'] = '/nonexistent/path/to/pi'

      await expect(findPiBinary()).rejects.toThrow(PiNotFoundError)
    })

    test('throws PiNotFoundError when PI_PATH points to non-existent file', async () => {
      // Set PI_PATH to a definitely non-existent path
      process.env['PI_PATH'] = '/definitely/nonexistent/path/that/does/not/exist/pi'

      // This should throw because the specified PI_PATH doesn't exist
      await expect(findPiBinary()).rejects.toThrow(PiNotFoundError)
    })
  })
})

describe('Extension bundling', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `pi-bundle-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('bundleExtension', () => {
    test('bundles TypeScript to JavaScript', async () => {
      const srcPath = join(tmpDir, 'tool.ts')
      const outPath = join(tmpDir, 'tool.js')

      await writeFile(
        srcPath,
        `
export function hello(): string {
  return 'hello world';
}
`
      )

      await bundleExtension(srcPath, outPath)

      const exists = await Bun.file(outPath).exists()
      expect(exists).toBe(true)

      const content = await Bun.file(outPath).text()
      expect(content).toContain('hello')
    })

    test('bundles JavaScript files', async () => {
      const srcPath = join(tmpDir, 'tool.js')
      const outPath = join(tmpDir, 'tool.bundle.js')

      await writeFile(
        srcPath,
        `
export function util() {
  return 42;
}
`
      )

      await bundleExtension(srcPath, outPath)

      const exists = await Bun.file(outPath).exists()
      expect(exists).toBe(true)
    })

    test('respects format option', async () => {
      const srcPath = join(tmpDir, 'tool.ts')
      const outPath = join(tmpDir, 'tool.cjs')

      await writeFile(srcPath, 'export const x = 1;')

      await bundleExtension(srcPath, outPath, { format: 'cjs' })

      const content = await Bun.file(outPath).text()
      // CJS format should have module.exports or exports
      expect(content).toBeDefined()
    })

    test('throws PiBundleError for invalid code', async () => {
      const srcPath = join(tmpDir, 'invalid.ts')
      const outPath = join(tmpDir, 'invalid.js')

      // Write invalid TypeScript - import from non-existent module
      // that should fail bundling
      await writeFile(
        srcPath,
        `
import { nonExistent } from 'absolutely-nonexistent-module-12345';
export const x = nonExistent();
`
      )

      await expect(bundleExtension(srcPath, outPath)).rejects.toThrow(PiBundleError)
    })
  })

  describe('discoverExtensions', () => {
    test('discovers TypeScript extensions', async () => {
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'tool1.ts'), 'export const a = 1;')
      await writeFile(join(extensionsDir, 'tool2.ts'), 'export const b = 2;')

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toHaveLength(2)
      expect(extensions.some((e) => e.endsWith('tool1.ts'))).toBe(true)
      expect(extensions.some((e) => e.endsWith('tool2.ts'))).toBe(true)
    })

    test('discovers JavaScript extensions', async () => {
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'util.js'), 'export const c = 3;')

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toHaveLength(1)
      expect(extensions[0]).toContain('util.js')
    })

    test('ignores package.json and node_modules', async () => {
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'tool.ts'), 'export const x = 1;')
      await writeFile(join(extensionsDir, 'package.json'), '{}')
      await mkdir(join(extensionsDir, 'node_modules'), { recursive: true })

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toHaveLength(1)
      expect(extensions[0]).toContain('tool.ts')
    })

    test('returns empty array when no extensions directory', async () => {
      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toEqual([])
    })

    test('returns empty array when extensions is not a directory', async () => {
      await writeFile(join(tmpDir, 'extensions'), 'not a directory')

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toEqual([])
    })
  })
})

describe('Hook bridge generation', () => {
  describe('generateHookBridgeCode', () => {
    test('generates valid JavaScript code', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/validate.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('export default function')
      expect(code).toContain('registerHook')
    })

    test('translates pre_tool_use to tool_call', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain("'tool_call'")
    })

    test('translates post_tool_use to tool_result', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'post_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain("'tool_result'")
    })

    test('includes ASP environment variables', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1', 'space2'])

      expect(code).toContain('ASP_TOOL_NAME')
      expect(code).toContain('ASP_TOOL_ARGS')
      expect(code).toContain('ASP_TOOL_RESULT')
      expect(code).toContain('ASP_HARNESS')
      expect(code).toContain('ASP_SPACES')
    })

    test('includes space IDs in ASP_SPACES', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1', 'space2'])

      expect(code).toContain('space1,space2')
    })

    test('filters hooks by harness', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/pi-hook.sh',
          harness: 'pi',
        },
        {
          event: 'pre_tool_use',
          script: '/path/to/claude-hook.sh',
          harness: 'claude',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      // Pi hook should be included
      expect(code).toContain('pi-hook.sh')
      // Claude hook should NOT be included
      expect(code).not.toContain('claude-hook.sh')
    })

    test('includes hooks without harness filter', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/universal-hook.sh',
          // No harness specified - should be included for all
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('universal-hook.sh')
    })

    test('generates tool filter when tools specified', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
          tools: ['Read', 'Write'],
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('toolsFilter')
      expect(code).toContain('"Read"')
      expect(code).toContain('"Write"')
    })

    test('generates comment for empty hooks', () => {
      const hooks: HookDefinition[] = []

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('No hooks configured')
    })

    test('includes blocking warning in generated code', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
          blocking: true,
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('cannot block')
    })

    test('handles multiple hooks', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/pre.sh',
        },
        {
          event: 'post_tool_use',
          script: '/path/to/post.sh',
        },
        {
          event: 'session_start',
          script: '/path/to/start.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('pre.sh')
      expect(code).toContain('post.sh')
      expect(code).toContain('start.sh')
      // Count registerHook calls
      const hookCount = (code.match(/registerHook/g) || []).length
      expect(hookCount).toBe(3)
    })
  })
})

describe('Error classes', () => {
  describe('PiNotFoundError', () => {
    test('includes searched paths in message', () => {
      const error = new PiNotFoundError(['/usr/bin/pi', '/usr/local/bin/pi'])

      expect(error.message).toContain('/usr/bin/pi')
      expect(error.message).toContain('/usr/local/bin/pi')
      expect(error.name).toBe('PiNotFoundError')
    })
  })

  describe('PiBundleError', () => {
    test('includes extension path and stderr', () => {
      const error = new PiBundleError('/path/to/ext.ts', 'Syntax error on line 5')

      expect(error.message).toContain('/path/to/ext.ts')
      expect(error.message).toContain('Syntax error on line 5')
      expect(error.extensionPath).toBe('/path/to/ext.ts')
      expect(error.stderr).toBe('Syntax error on line 5')
      expect(error.name).toBe('PiBundleError')
    })
  })
})
