/**
 * Tests for ClaudeAdapter
 *
 * WHY: ClaudeAdapter is the primary harness adapter for Claude Code integration.
 * These tests verify detection, validation, materialization, composition, and
 * argument building - all critical for correct Claude Code operation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MaterializeSpaceInput,
  ProjectManifest,
  ResolvedSpaceManifest,
  SpaceKey,
} from 'spaces-config'
import { clearClaudeCache } from '../claude/index.js'
import { ClaudeAdapter } from './claude-adapter.js'

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

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter

  beforeAll(() => {
    adapter = new ClaudeAdapter()
  })

  describe('id and name', () => {
    test('has correct id', () => {
      expect(adapter.id).toBe('claude')
    })

    test('has correct name', () => {
      expect(adapter.name).toBe('Claude Code')
    })
  })

  describe('detect', () => {
    let tmpDir: string
    let mockClaudePath: string
    let originalEnv: string | undefined

    beforeAll(async () => {
      tmpDir = join(tmpdir(), `claude-adapter-detect-${Date.now()}`)
      await mkdir(tmpDir, { recursive: true })
      mockClaudePath = join(tmpDir, 'mock-claude')
      originalEnv = process.env['ASP_CLAUDE_PATH']
    })

    beforeEach(async () => {
      clearClaudeCache()
    })

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env['ASP_CLAUDE_PATH'] = originalEnv
      } else {
        process.env['ASP_CLAUDE_PATH'] = undefined
      }
      clearClaudeCache()
    })

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('returns available: true when claude is found', async () => {
      // Create a mock claude that outputs version info
      await writeFile(
        mockClaudePath,
        `#!/bin/bash
echo "1.0.0"
exit 0
`
      )
      await chmod(mockClaudePath, 0o755)
      process.env['ASP_CLAUDE_PATH'] = mockClaudePath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(mockClaudePath)
    })

    test('returns available: false when claude is not found', async () => {
      // Point to non-existent binary
      process.env['ASP_CLAUDE_PATH'] = '/nonexistent/claude'

      const result = await adapter.detect()

      expect(result.available).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('includes capabilities when available', async () => {
      await writeFile(
        mockClaudePath,
        `#!/bin/bash
echo "1.0.0"
exit 0
`
      )
      await chmod(mockClaudePath, 0o755)
      process.env['ASP_CLAUDE_PATH'] = mockClaudePath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.capabilities).toBeDefined()
      expect(result.capabilities).toContain('multiPlugin')
      expect(result.capabilities).toContain('settingsFlag')
    })
  })

  describe('validateSpace', () => {
    test('validates space with valid id', () => {
      const input = createMaterializeInput('/test/snapshot', { id: 'valid-space' })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('validates space with plugin name', () => {
      const input = createMaterializeInput('/test/snapshot', {
        id: 'test',
        plugin: { name: 'my-plugin' },
      })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('rejects space without id or plugin name', () => {
      const input = createMaterializeInput('/test/snapshot', {
        id: undefined,
        plugin: undefined,
      })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Space must have an id or plugin.name')
    })

    test('warns about non-kebab-case plugin names', () => {
      const input = createMaterializeInput('/test/snapshot', { id: 'InvalidCaseName' })

      const result = adapter.validateSpace(input)

      // Still valid, but with warning
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes('should be kebab-case'))).toBe(true)
    })

    test('accepts kebab-case plugin names without warning', () => {
      const input = createMaterializeInput('/test/snapshot', { id: 'my-valid-plugin' })

      const result = adapter.validateSpace(input)

      expect(result.valid).toBe(true)
      expect(result.warnings).toHaveLength(0)
    })
  })

  describe('materializeSpace', () => {
    let tmpDir: string
    let snapshotDir: string
    let cacheDir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `claude-adapter-materialize-${Date.now()}`)
      snapshotDir = join(tmpDir, 'snapshot')
      cacheDir = join(tmpDir, 'cache')

      await mkdir(snapshotDir, { recursive: true })
      await mkdir(cacheDir, { recursive: true })
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('creates plugin.json file', async () => {
      const input = createMaterializeInput(snapshotDir, { id: 'test-plugin' })

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files).toContain('.claude-plugin/plugin.json')

      // Verify plugin.json exists
      const pluginJsonPath = join(cacheDir, '.claude-plugin/plugin.json')
      const pluginJson = await Bun.file(pluginJsonPath).json()
      expect(pluginJson.name).toBe('test-plugin')
    })

    test('links AGENT.md to CLAUDE.md', async () => {
      // Create AGENT.md in snapshot
      await writeFile(join(snapshotDir, 'AGENT.md'), '# Agent Instructions')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      // Should have linked AGENT.md → CLAUDE.md
      expect(result.files).toContain('CLAUDE.md')

      // Verify content is accessible
      const claudeMdPath = join(cacheDir, 'CLAUDE.md')
      const content = await Bun.file(claudeMdPath).text()
      expect(content).toBe('# Agent Instructions')
    })

    test('preserves CLAUDE.md when present', async () => {
      // Create CLAUDE.md in snapshot (legacy)
      await writeFile(join(snapshotDir, 'CLAUDE.md'), '# Claude Instructions')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files).toContain('CLAUDE.md')

      const claudeMdPath = join(cacheDir, 'CLAUDE.md')
      const content = await Bun.file(claudeMdPath).text()
      expect(content).toBe('# Claude Instructions')
    })

    test('converts hooks.toml to hooks.json', async () => {
      // Create hooks directory with hooks.toml
      const hooksDir = join(snapshotDir, 'hooks')
      await mkdir(hooksDir, { recursive: true })

      await writeFile(
        join(hooksDir, 'hooks.toml'),
        `
[[hook]]
event = "pre_tool_use"
script = "hooks/validate.sh"
`
      )

      // Also create the script file for validation
      await writeFile(join(snapshotDir, 'hooks', 'validate.sh'), '#!/bin/bash\necho "validating"')
      await chmod(join(snapshotDir, 'hooks', 'validate.sh'), 0o755)

      const input = createMaterializeInput(snapshotDir)

      await adapter.materializeSpace(input, cacheDir, {})

      // Verify hooks.json was generated
      const hooksJsonPath = join(cacheDir, 'hooks', 'hooks.json')
      const hooksJson = await Bun.file(hooksJsonPath).json()

      expect(hooksJson.hooks.PreToolUse).toHaveLength(1)
      expect(hooksJson.hooks.PreToolUse[0].matcher).toBe('*')
    })

    test('copies permissions.toml when present', async () => {
      // Create permissions.toml
      await writeFile(
        join(snapshotDir, 'permissions.toml'),
        `
[read]
allow = ["/tmp", "/var"]

[write]
allow = ["/tmp"]
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

    test('links commands directory when present', async () => {
      // Create commands directory
      const commandsDir = join(snapshotDir, 'commands')
      await mkdir(commandsDir, { recursive: true })
      await writeFile(join(commandsDir, 'test.md'), '# Test Command')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      // Commands should be linked
      expect(result.files.some((f) => f.includes('commands'))).toBe(true)
    })

    test('links skills directory when present', async () => {
      // Create skills directory
      const skillsDir = join(snapshotDir, 'skills')
      await mkdir(skillsDir, { recursive: true })
      await writeFile(join(skillsDir, 'skill.md'), '# Test Skill')

      const input = createMaterializeInput(snapshotDir)

      const result = await adapter.materializeSpace(input, cacheDir, {})

      expect(result.files.some((f) => f.includes('skills'))).toBe(true)
    })
  })

  describe('composeTarget', () => {
    let tmpDir: string
    let outputDir: string
    let artifact1Dir: string
    let artifact2Dir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `claude-adapter-compose-${Date.now()}`)
      outputDir = join(tmpDir, 'output')
      artifact1Dir = join(tmpDir, 'artifact1')
      artifact2Dir = join(tmpDir, 'artifact2')

      await mkdir(outputDir, { recursive: true })
      await mkdir(artifact1Dir, { recursive: true })
      await mkdir(artifact2Dir, { recursive: true })

      // Create minimal plugin.json in each artifact
      await mkdir(join(artifact1Dir, '.claude-plugin'), { recursive: true })
      await mkdir(join(artifact2Dir, '.claude-plugin'), { recursive: true })

      await writeFile(
        join(artifact1Dir, '.claude-plugin/plugin.json'),
        JSON.stringify({ name: 'plugin1' })
      )
      await writeFile(
        join(artifact2Dir, '.claude-plugin/plugin.json'),
        JSON.stringify({ name: 'plugin2' })
      )
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('creates plugins directory with ordered artifacts', async () => {
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
      expect(result.bundle.harnessId).toBe('claude')
      expect(result.bundle.targetName).toBe('test-target')
      expect(result.bundle.rootDir).toBe(outputDir)
      expect(result.bundle.pluginDirs).toHaveLength(2)

      // Check plugins have correct prefixes
      expect(result.bundle.pluginDirs?.[0]).toContain('000-space1')
      expect(result.bundle.pluginDirs?.[1]).toContain('001-space2')
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

    test('composes MCP config from plugins', async () => {
      // Add mcp directory to artifact1 with proper mcp.json structure
      // Note: composeMcpFromSpaces reads from mcp/mcp.json, not individual server files
      const mcpDir = join(artifact1Dir, 'mcp')
      await mkdir(mcpDir, { recursive: true })
      await writeFile(
        join(mcpDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            'test-server': {
              type: 'stdio',
              command: 'test-server',
              args: ['--test'],
            },
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

      const result = await adapter.composeTarget(input, outputDir, {})

      // MCP config should be created
      expect(result.bundle.mcpConfigPath).toBeDefined()

      // Verify MCP config content
      if (result.bundle.mcpConfigPath) {
        const mcpConfig = await Bun.file(result.bundle.mcpConfigPath).json()
        expect(mcpConfig.mcpServers['test-server']).toBeDefined()
      }
    })

    test('composes settings from inputs', async () => {
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
        settingsInputs: [
          {
            model: 'opus',
            permissionMode: 'full',
          },
        ],
      }

      const result = await adapter.composeTarget(input, outputDir, {})

      // Settings should be created
      expect(result.bundle.settingsPath).toBeDefined()
    })

    test('merges permissions.toml into settings', async () => {
      // Add permissions.toml to artifact1 with correct format
      // Note: permissions.toml uses paths=[] for read/write, not allow=[]
      await writeFile(
        join(artifact1Dir, 'permissions.toml'),
        `
[read]
paths = ["/tmp"]

[write]
paths = ["/var/log"]
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

      // Settings should include permissions
      expect(result.bundle.settingsPath).toBeDefined()

      if (result.bundle.settingsPath) {
        const settings = await Bun.file(result.bundle.settingsPath).json()
        expect(settings.permissions).toBeDefined()
        // Verify that Read and Write tools are allowed
        expect(settings.permissions.allow).toContain('Read')
        expect(settings.permissions.allow).toContain('Write')
      }
    })
  })

  describe('buildRunArgs', () => {
    test('builds args from bundle with plugin dirs', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: ['/plugin1', '/plugin2'],
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--plugin-dir')
      expect(args).toContain('/plugin1')
      expect(args).toContain('/plugin2')
    })

    test('builds args with MCP config', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
        mcpConfigPath: '/path/to/mcp.json',
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--mcp-config')
      expect(args).toContain('/path/to/mcp.json')
    })

    test('builds args with settings', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
        settingsPath: '/path/to/settings.json',
      }

      const args = adapter.buildRunArgs(bundle, {})

      expect(args).toContain('--settings')
      expect(args).toContain('/path/to/settings.json')
    })

    test('builds args with model override', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
      }

      const args = adapter.buildRunArgs(bundle, { model: 'opus' })

      expect(args).toContain('--model')
      expect(args).toContain('opus')
    })

    test('includes extra args', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
      }

      const args = adapter.buildRunArgs(bundle, { extraArgs: ['--print', 'hello'] })

      expect(args).toContain('--print')
      expect(args).toContain('hello')
    })

    test('includes settingSources when provided', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
      }

      const args = adapter.buildRunArgs(bundle, { settingSources: 'project,user' })

      expect(args).toContain('--setting-sources')
      expect(args).toContain('project,user')
    })

    test('passes prompt as positional argument in interactive mode', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
      }

      const args = adapter.buildRunArgs(bundle, {
        interactive: true,
        prompt: 'Start by checking failing tests',
      })

      expect(args).toContain('Start by checking failing tests')
      expect(args).not.toContain('-p')
    })

    test('uses -p in non-interactive mode', () => {
      const bundle = {
        harnessId: 'claude' as const,
        targetName: 'test',
        rootDir: '/test',
        pluginDirs: [],
      }

      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        prompt: 'Summarize repository health',
      })

      const pIndex = args.indexOf('-p')
      expect(pIndex).toBeGreaterThanOrEqual(0)
      expect(args[pIndex + 1]).toBe('Summarize repository health')
    })
  })

  describe('getDefaultRunOptions', () => {
    test('includes priming_prompt as default prompt', () => {
      const manifest: ProjectManifest = {
        schema: 1,
        targets: {
          claude: {
            compose: ['space:claude-space@stable'],
            priming_prompt: 'Register and send READY',
          },
        },
      }

      const defaults = adapter.getDefaultRunOptions(manifest, 'claude')
      expect(defaults.prompt).toBe('Register and send READY')
    })
  })

  describe('getTargetOutputPath', () => {
    test('returns correct path for target', () => {
      const path = adapter.getTargetOutputPath('/project/asp_modules', 'my-target')

      expect(path).toBe('/project/asp_modules/my-target/claude')
    })

    test('handles different asp_modules paths', () => {
      const path = adapter.getTargetOutputPath('/custom/path', 'target')

      expect(path).toBe('/custom/path/target/claude')
    })
  })
})
