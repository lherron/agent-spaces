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
import type { MaterializeSpaceInput, ResolvedSpaceManifest, SpaceKey } from 'spaces-config'
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

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
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

    test('ASP_PI_PATH takes precedence over PI_PATH', async () => {
      await writeFile(
        mockPiPath,
        `#!/bin/bash
if [[ "$1" == "--version" ]]; then echo "3.1.4"; exit 0; fi
exit 0
`
      )
      await chmod(mockPiPath, 0o755)
      const originalAspPiPath = process.env['ASP_PI_PATH']
      try {
        // ASP_PI_PATH points at the real shim; PI_PATH at a bogus path. The
        // canonical ASP_PI_PATH override must win (mirrors ASP_CLAUDE_PATH/ASP_CODEX_PATH).
        process.env['ASP_PI_PATH'] = mockPiPath
        process.env['PI_PATH'] = '/nonexistent/pi'
        const result = await adapter.detect()
        expect(result.available).toBe(true)
        expect(result.path).toBe(mockPiPath)
      } finally {
        if (originalAspPiPath !== undefined) process.env['ASP_PI_PATH'] = originalAspPiPath
        else Reflect.deleteProperty(process.env, 'ASP_PI_PATH')
        clearPiCache()
      }
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
      // Create hooks-scripts directory with hooks.toml (Pi uses hooks-scripts/ to avoid conflict)
      await mkdir(join(artifact1Dir, 'hooks-scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "scripts/validate.sh"
`
      )
      // Create script in scripts subdirectory
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/validate.sh'),
        '#!/bin/bash\necho "validating"'
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

      // Hook bridge should be generated
      expect(result.bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))

      // Verify hook bridge file exists
      const bridgeExists = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).exists()
      expect(bridgeExists).toBe(true)

      // Verify content contains hook registration
      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain('pi.on(')
      expect(bridgeContent).toContain('tool_call') // pre_tool_use maps to tool_call in Pi
    })

    test('generates correct script path for Claude native hooks.json with nested scripts', async () => {
      // Create hooks-scripts directory with Claude's native hooks.json format
      // This simulates the structure after materialization from a hooks.json like:
      // ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/agent_motd.sh
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/agent_motd.sh',
                  },
                ],
              },
            ],
          },
        })
      )
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/agent_motd.sh'),
        '#!/bin/bash\necho "motd"'
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

      // Hook bridge should be generated
      expect(result.bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))

      // Verify hook bridge file exists and contains correct path
      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()

      // The generated script path should include the 'scripts' subdirectory
      // Expected: /path/to/hooks-scripts/scripts/agent_motd.sh
      // NOT: /path/to/hooks-scripts/agent_motd.sh
      expect(bridgeContent).toContain('hooks-scripts/scripts/agent_motd.sh')
      expect(bridgeContent).not.toMatch(/hooks-scripts\/agent_motd\.sh[^/]/)
    })

    test('resolves missing scripts/ prefix for nested hook scripts', async () => {
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: '${CLAUDE_PLUGIN_ROOT}/hooks/agent_motd.sh',
                  },
                ],
              },
            ],
          },
        })
      )
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/agent_motd.sh'),
        '#!/bin/bash\necho "motd"'
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

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain('hooks-scripts/scripts/agent_motd.sh')
    })

    test('passes through raw command hooks without rewriting paths', async () => {
      await mkdir(join(artifact1Dir, 'hooks-scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: 'asp --help',
                  },
                ],
              },
            ],
          },
        })
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

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).text()
      expect(bridgeContent).toContain("spawn('asp --help'")
    })

    test('generates W301 warning for blocking hooks', async () => {
      // Create hooks-scripts with blocking=true (Pi uses hooks-scripts/ to avoid conflict)
      await mkdir(join(artifact1Dir, 'hooks-scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "scripts/validate.sh"
blocking = true
`
      )
      await mkdir(join(artifact1Dir, 'hooks-scripts/scripts'), { recursive: true })
      await writeFile(
        join(artifact1Dir, 'hooks-scripts/scripts/validate.sh'),
        '#!/bin/bash\necho "blocking"'
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

    test('always generates the HRC events bridge extension even when no ASP hooks exist', async () => {
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

      await adapter.composeTarget(input, outputDir, {})

      const hrcBridgePath = join(outputDir, 'asp-hrc-events.bridge.js')
      const hrcBridgeFile = Bun.file(hrcBridgePath)
      expect(await hrcBridgeFile.exists()).toBe(true)

      const bridgeContent = await hrcBridgeFile.text()
      expect(bridgeContent.length).toBeGreaterThan(0)
      expect(await Bun.file(join(outputDir, 'asp-hooks.bridge.js')).exists()).toBe(false)
    })

    test('HRC events bridge subscribes to Pi lifecycle and stream events', async () => {
      const input = {
        targetName: 'test-target',
        compose: [],
        roots: [],
        loadOrder: [],
        artifacts: [],
        settingsInputs: [],
      }

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hrc-events.bridge.js')).text()
      for (const eventName of [
        'before_agent_start',
        'agent_start',
        'agent_end',
        'turn_start',
        'turn_end',
        'message_start',
        'message_update',
        'message_end',
        'tool_execution_start',
        'tool_execution_update',
        'tool_execution_end',
        'session_shutdown',
      ]) {
        expect(bridgeContent).toContain(eventName)
      }
    })

    test('HRC events bridge forwards structured payloads through HRC_LAUNCH_HOOK_CLI', async () => {
      const input = {
        targetName: 'test-target',
        compose: [],
        roots: [],
        loadOrder: [],
        artifacts: [],
        settingsInputs: [],
      }

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hrc-events.bridge.js')).text()
      expect(bridgeContent).toContain('process.env.HRC_LAUNCH_HOOK_CLI')
      expect(bridgeContent).toContain('JSON.stringify')
      expect(bridgeContent).toContain('eventName')
      expect(bridgeContent).toContain('payload')
    })

    test('HRC events bridge registers session_start exactly once (via the enriched handler)', async () => {
      const input = {
        targetName: 'test-target',
        compose: [],
        roots: [],
        loadOrder: [],
        artifacts: [],
        settingsInputs: [],
      }

      await adapter.composeTarget(input, outputDir, {})

      const bridgeContent = await Bun.file(join(outputDir, 'asp-hrc-events.bridge.js')).text()

      // session_start must be subscribed to exactly once — the generic-forward
      // list must NOT also register it alongside the special-cased enriched
      // handler (which captures sessionId/sessionFile from ctx.sessionManager).
      const sessionStartHandlers = bridgeContent.match(/pi\.on\('session_start'/g) ?? []
      expect(sessionStartHandlers).toHaveLength(1)

      // The single registration must be the enriched one (captures sessionId),
      // not a bare generic forward.
      expect(bridgeContent).toContain('getSessionId')
      expect(bridgeContent).toContain('sessionId')
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

    test('builds args with hook bridge extension', async () => {
      const tmpDir = join(tmpdir(), `pi-args-hook-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
          hookBridgePath: join(tmpDir, 'asp-hooks.bridge.js'),
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args).toContain(join(tmpDir, 'asp-hooks.bridge.js'))

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('adds --no-skills to disable default skill loading', async () => {
      const tmpDir = join(tmpdir(), `pi-args-skills-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
          skillsDir: join(tmpDir, 'skills'),
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-skills')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('passes replacement system prompt file path with --system-prompt', async () => {
      const tmpDir = join(tmpdir(), `pi-args-system-prompt-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      const systemPromptPath = join(tmpDir, 'system-prompt.md')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(systemPromptPath, 'system prompt')

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, { systemPrompt: systemPromptPath })

      expect(argValue(args, '--system-prompt')).toBe(systemPromptPath)

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('passes session reminder file path after replacement system prompt', async () => {
      const tmpDir = join(tmpdir(), `pi-args-reminder-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      const systemPromptPath = join(tmpDir, 'system-prompt.md')
      const reminderPath = join(tmpDir, 'session-reminder.md')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(systemPromptPath, 'system prompt')
      await writeFile(reminderPath, 'remember this')

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, {
        systemPrompt: systemPromptPath,
        reminderContent: reminderPath,
      })

      expect(argValue(args, '--append-system-prompt')).toBe(reminderPath)
      expect(args.indexOf('--append-system-prompt')).toBeGreaterThan(
        args.indexOf('--system-prompt')
      )

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('passes explicit bundle skills directory while keeping --no-skills', async () => {
      const tmpDir = join(tmpdir(), `pi-args-explicit-skills-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      const skillsDir = join(tmpDir, 'skills')
      await mkdir(extensionsDir, { recursive: true })
      await mkdir(join(skillsDir, 'skill-one'), { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
          skillsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-skills')
      expect(argValue(args, '--skill')).toBe(skillsDir)

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('always disables native Pi context files', async () => {
      const tmpDir = join(tmpdir(), `pi-args-context-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-context-files')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('uses named Pi session and HRC runtime session dir for continuation keys', async () => {
      const tmpDir = join(tmpdir(), `pi-args-hrc-session-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      const aspHome = join(tmpDir, 'asp-home')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, {
        aspHome,
        continuationKey: 'session-a',
        runtimeId: 'rt-123',
      } as any)

      expect(argValue(args, '--session')).toBe('session-a')
      expect(argValue(args, '--session-dir')).toBe(
        join(aspHome, 'state/hrc/runtimes/rt-123/pi-sessions')
      )
      expect(args).not.toContain('--resume')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('uses bundle-local session dir for continuation keys outside HRC runtime launches', async () => {
      const tmpDir = join(tmpdir(), `pi-args-standalone-session-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, { continuationKey: 'session-b' })

      expect(argValue(args, '--session')).toBe('session-b')
      expect(argValue(args, '--session-dir')).toBe(join(tmpDir, 'sessions'))
      expect(args).not.toContain('--resume')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('keeps --resume only for explicit continuation picker requests', async () => {
      const tmpDir = join(tmpdir(), `pi-args-picker-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, { continuationKey: true })

      expect(args).toContain('--resume')
      expect(args).not.toContain('--session')
      expect(args).not.toContain('--session-dir')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('always adds the HRC events bridge extension', async () => {
      const tmpDir = join(tmpdir(), `pi-args-hrc-bridge-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      const hrcBridgePath = join(tmpDir, 'asp-hrc-events.bridge.js')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(hrcBridgePath, 'export default {}')

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
          hrcEventsBridgePath: hrcBridgePath,
        },
      } as any

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--extension')
      expect(args).toContain(hrcBridgePath)

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('keeps priming prompt as positional argv tail and exposes it in run env', async () => {
      const tmpDir = join(tmpdir(), `pi-args-priming-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }
      const prompt = 'Prime the interactive session.'

      const args = adapter.buildRunArgs(bundle, { prompt })
      const env = adapter.getRunEnv(bundle, { prompt })

      expect(args.at(-1)).toBe(prompt)
      expect(env['ASP_PRIMING_PROMPT']).toBe(prompt)

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('translates model names', async () => {
      const tmpDir = join(tmpdir(), `pi-args-model-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
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

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('passes through unknown model names', async () => {
      const tmpDir = join(tmpdir(), `pi-args-unknown-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, { model: 'gpt-4' })
      expect(args).toContain('--model')
      expect(args).toContain('gpt-4')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('includes extra args', async () => {
      const tmpDir = join(tmpdir(), `pi-args-extra-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, { extraArgs: ['--verbose', '--debug'] })

      expect(args).toContain('--verbose')
      expect(args).toContain('--debug')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('does not include project path (Pi uses cwd)', async () => {
      const tmpDir = join(tmpdir(), `pi-args-path-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, { projectPath: '/my/project' })

      // Pi uses cwd, not a positional path argument
      expect(args).not.toContain('/my/project')

      await rm(tmpDir, { recursive: true, force: true })
    })

    test('throws when no pi bundle', () => {
      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: '/test',
      }

      expect(() => adapter.buildRunArgs(bundle, {})).toThrow('Pi bundle is missing')
    })

    test('adds --no-extensions when no extensions found', async () => {
      const tmpDir = join(tmpdir(), `pi-args-no-ext-${Date.now()}`)
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      // Empty extensions directory - no .js files

      const bundle = {
        harnessId: 'pi' as const,
        targetName: 'test',
        rootDir: tmpDir,
        pi: {
          extensionsDir,
        },
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--no-extensions')

      await rm(tmpDir, { recursive: true, force: true })
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

    test('finds a non-executable `pi.js`-style entrypoint on PATH (run via bun)', async () => {
      // A `pi` entrypoint on PATH that is a .js file (run via bun) and is NOT
      // marked executable must still be detected — the PATH search uses the
      // same isUsablePiEntrypoint predicate as the common-paths loop.
      const originalPath = process.env['PATH']
      const pathDir = join(tmpDir, 'path-js-bin')
      await mkdir(pathDir, { recursive: true })
      // A `pi.js` entrypoint, written WITHOUT the executable bit (run via bun).
      // The old isExecutable-only PATH search missed this; the shared
      // isUsablePiEntrypoint predicate accepts it because the .js file exists.
      const piJsPath = join(pathDir, 'pi.js')
      await writeFile(piJsPath, 'console.log("0.0.0")')
      await chmod(piJsPath, 0o644)

      // Ensure no explicit override is in play so PATH search is exercised.
      process.env['PI_PATH'] = undefined
      const originalAspPiPath = process.env['ASP_PI_PATH']
      Reflect.deleteProperty(process.env, 'ASP_PI_PATH')
      // Isolate PATH to just our dir so the real `pi` (if installed) can't win.
      process.env['PATH'] = pathDir

      try {
        const path = await findPiBinary()
        expect(path).toBe(piJsPath)
      } finally {
        if (originalPath !== undefined) process.env['PATH'] = originalPath
        else Reflect.deleteProperty(process.env, 'PATH')
        if (originalAspPiPath !== undefined) process.env['ASP_PI_PATH'] = originalAspPiPath
        else Reflect.deleteProperty(process.env, 'ASP_PI_PATH')
      }
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

      expect(code).toContain('module.exports = function')
      expect(code).toContain('pi.on(')
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

      // Blocking hooks still generate code, logging handles exit codes
      expect(code).toContain('/path/to/script.sh')
      expect(code).toContain('log(')
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
      // Count pi.on() calls
      const hookCount = (code.match(/pi\.on\(/g) || []).length
      expect(hookCount).toBe(3)
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

describe('loadTargetBundle', () => {
  let tmpDir: string
  let outputDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `pi-adapter-load-bundle-${Date.now()}`)
    outputDir = join(tmpDir, 'output')
    await mkdir(outputDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('reports the expected pi paths and omits absent skills/bridges', async () => {
    const adapter = new PiAdapter()

    const bundle = await adapter.loadTargetBundle(outputDir, 'my-target')

    expect(bundle.harnessId).toBe('pi')
    expect(bundle.targetName).toBe('my-target')
    expect(bundle.rootDir).toBe(outputDir)
    expect(bundle.pi?.extensionsDir).toBe(join(outputDir, 'extensions'))
    // No skills dir / bridges on disk -> undefined.
    expect(bundle.pi?.skillsDir).toBeUndefined()
    expect(bundle.pi?.hookBridgePath).toBeUndefined()
    const piWithHrc = bundle.pi as
      | (NonNullable<typeof bundle.pi> & { hrcEventsBridgePath?: string | undefined })
      | undefined
    expect(piWithHrc?.hrcEventsBridgePath).toBeUndefined()
  })

  test('detects skills dir and both bridges when present on disk', async () => {
    const adapter = new PiAdapter()

    // Skills dir with at least one entry.
    await mkdir(join(outputDir, 'skills', 'skill-a'), { recursive: true })
    await writeFile(join(outputDir, 'skills/skill-a/README.md'), '# Skill A')
    // Hook bridge + HRC events bridge files.
    await writeFile(join(outputDir, 'asp-hooks.bridge.js'), 'module.exports = () => {}')
    await writeFile(join(outputDir, 'asp-hrc-events.bridge.js'), 'module.exports = () => {}')

    const bundle = await adapter.loadTargetBundle(outputDir, 'my-target')

    expect(bundle.pi?.skillsDir).toBe(join(outputDir, 'skills'))
    expect(bundle.pi?.hookBridgePath).toBe(join(outputDir, 'asp-hooks.bridge.js'))
    const piWithHrc = bundle.pi as NonNullable<typeof bundle.pi> & {
      hrcEventsBridgePath?: string | undefined
    }
    expect(piWithHrc.hrcEventsBridgePath).toBe(join(outputDir, 'asp-hrc-events.bridge.js'))
  })

  test('treats an empty skills directory as no skills dir', async () => {
    const adapter = new PiAdapter()
    await mkdir(join(outputDir, 'skills'), { recursive: true })

    const bundle = await adapter.loadTargetBundle(outputDir, 'my-target')

    expect(bundle.pi?.skillsDir).toBeUndefined()
  })
})

describe('getRunEnv', () => {
  test('always sets PI_CODING_AGENT_DIR to the bundle root', () => {
    const adapter = new PiAdapter()
    const bundle = {
      harnessId: 'pi' as const,
      targetName: 'test',
      rootDir: '/bundle/root',
      pi: { extensionsDir: '/bundle/root/extensions' },
    }

    const env = adapter.getRunEnv(bundle, {})

    expect(env['PI_CODING_AGENT_DIR']).toBe('/bundle/root')
    expect(env['ASP_PRIMING_PROMPT']).toBeUndefined()
  })

  test('exposes the priming prompt via ASP_PRIMING_PROMPT when provided', () => {
    const adapter = new PiAdapter()
    const bundle = {
      harnessId: 'pi' as const,
      targetName: 'test',
      rootDir: '/bundle/root',
      pi: { extensionsDir: '/bundle/root/extensions' },
    }

    const env = adapter.getRunEnv(bundle, { prompt: 'go' })

    expect(env['PI_CODING_AGENT_DIR']).toBe('/bundle/root')
    expect(env['ASP_PRIMING_PROMPT']).toBe('go')
  })
})

describe('getDefaultRunOptions', () => {
  test('returns an empty options object (Pi opts out of defaults)', () => {
    const adapter = new PiAdapter()
    const manifest = createTestManifest({ id: 'any-space' }) as unknown as Parameters<
      PiAdapter['getDefaultRunOptions']
    >[0]

    const options = adapter.getDefaultRunOptions(manifest, 'some-target')

    expect(options).toEqual({})
  })
})

describe('detect capability inference', () => {
  let tmpDir: string
  let mockPiPath: string
  let originalEnv: string | undefined

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `pi-adapter-detect-caps-${Date.now()}`)
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

  test('omits extension/skill capabilities when --help advertises neither flag', async () => {
    const adapter = new PiAdapter()
    // --help succeeds but never mentions --extension or --skills, so the
    // capability probes should resolve to false.
    await writeFile(
      mockPiPath,
      `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "1.0.0"
  exit 0
fi
if [[ "$1" == "--help" ]]; then
  echo "usage: pi [--model MODEL]"
  exit 0
fi
exit 0
`
    )
    await chmod(mockPiPath, 0o755)
    process.env['PI_PATH'] = mockPiPath

    const result = await adapter.detect()

    expect(result.available).toBe(true)
    expect(result.capabilities).not.toContain('extensions')
    expect(result.capabilities).not.toContain('skills')
    // toolNamespacing is always advertised.
    expect(result.capabilities).toContain('toolNamespacing')
  })
})

describe('Hook bridge generation — codegen injection hazard', () => {
  // NOTE: `generateHookBridgeCode` interpolates `hook.script` and `hook.event`
  // directly into single-quoted JavaScript string literals in the emitted
  // bridge (see codegen/hook-bridge.ts). A script value containing a quote or
  // newline therefore breaks or injects code in the generated extension. This
  // is the highest-correctness-risk item flagged in harness-pi-report.md
  // (Technical Debt Notes / second-pass A8). It is an UNFIXED behavioral
  // hazard, so this assertion is marked `.todo` to document the gap without
  // turning the suite red. Enable it once the codegen serializes hook values
  // safely (e.g. JSON-encoded table) rather than interpolating raw literals.
  test.todo(
    'escapes hook.script values containing quotes/newlines so generated code stays valid',
    () => {
      const code = generateHookBridgeCode(
        [
          {
            event: 'pre_tool_use',
            script: "/path/to/it's a script\n.sh; rm -rf /",
          },
        ],
        ['space1']
      )

      // Once fixed, the raw unescaped script must NOT appear verbatim as a bare
      // single-quoted literal that could terminate the string and inject code.
      expect(code).not.toContain("'/path/to/it's a script")
    }
  )
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
