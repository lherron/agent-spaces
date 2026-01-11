/**
 * Tests for lint rules.
 *
 * WHY: Lint rules are the core of the linting system.
 * These tests verify each rule detects issues correctly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpaceId, SpaceKey, SpaceManifest } from '@agent-spaces/core'
import type { LintContext, SpaceLintData } from '../types.js'
import { WARNING_CODES } from '../types.js'
import { checkCommandCollisions } from './W201-command-collision.js'
import { checkAgentCommandNamespace } from './W202-agent-command-namespace.js'
import { checkHookPaths } from './W203-hook-path-no-plugin-root.js'
import { checkHooksConfig } from './W204-invalid-hooks-config.js'
import { checkPluginNameCollisions } from './W205-plugin-name-collision.js'
import { checkHookScriptsExecutable } from './W206-non-executable-hook-script.js'
import { checkPluginStructure } from './W207-invalid-plugin-structure.js'

let tempDir: string

function createManifest(overrides: Partial<SpaceManifest> = {}): SpaceManifest {
  return {
    schema: 1,
    id: 'test-space' as SpaceId,
    ...overrides,
  }
}

function createSpaceLintData(
  key: string,
  manifest: SpaceManifest,
  pluginPath: string
): SpaceLintData {
  return {
    key: key as SpaceKey,
    manifest,
    pluginPath,
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'lint-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('W201: checkCommandCollisions', () => {
  it('should return no warnings when no collisions', async () => {
    const plugin1 = join(tempDir, 'plugin1')
    const plugin2 = join(tempDir, 'plugin2')

    await mkdir(join(plugin1, 'commands'), { recursive: true })
    await mkdir(join(plugin2, 'commands'), { recursive: true })
    await writeFile(join(plugin1, 'commands', 'cmd1.md'), '# Command 1')
    await writeFile(join(plugin2, 'commands', 'cmd2.md'), '# Command 2')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin1),
        createSpaceLintData('space2@def456', createManifest({ id: 'space2' as SpaceId }), plugin2),
      ],
    }

    const warnings = await checkCommandCollisions(context)
    expect(warnings).toHaveLength(0)
  })

  it('should detect command collisions', async () => {
    const plugin1 = join(tempDir, 'plugin1')
    const plugin2 = join(tempDir, 'plugin2')

    await mkdir(join(plugin1, 'commands'), { recursive: true })
    await mkdir(join(plugin2, 'commands'), { recursive: true })
    await writeFile(join(plugin1, 'commands', 'deploy.md'), '# Deploy 1')
    await writeFile(join(plugin2, 'commands', 'deploy.md'), '# Deploy 2')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin1),
        createSpaceLintData('space2@def456', createManifest({ id: 'space2' as SpaceId }), plugin2),
      ],
    }

    const warnings = await checkCommandCollisions(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.COMMAND_COLLISION)
    expect(warnings[0]?.message).toContain('deploy')
  })

  it('should handle missing commands directory', async () => {
    const plugin1 = join(tempDir, 'plugin1')
    await mkdir(plugin1, { recursive: true })

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin1),
      ],
    }

    const warnings = await checkCommandCollisions(context)
    expect(warnings).toHaveLength(0)
  })
})

describe('W202: checkAgentCommandNamespace', () => {
  it('should return no warnings when no agents directory', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'build.md'), '# Build')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(0)
  })

  it('should return no warnings when agents use qualified commands', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await mkdir(join(plugin, 'agents'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'build.md'), '# Build')
    await writeFile(
      join(plugin, 'agents', 'reviewer.md'),
      '# Reviewer\n\nUse /space1:build to build the project.'
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(0)
  })

  it('should warn when agent references unqualified command from plugin space', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await mkdir(join(plugin, 'agents'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'deploy.md'), '# Deploy')
    await writeFile(
      join(plugin, 'agents', 'reviewer.md'),
      '# Reviewer\n\nUse /deploy to deploy the project.'
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.AGENT_COMMAND_NAMESPACE)
    expect(warnings[0]?.message).toContain('/deploy')
    expect(warnings[0]?.message).toContain('/space1:deploy')
  })

  it('should not warn for unqualified commands not provided by any space', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'agents'), { recursive: true })
    await writeFile(
      join(plugin, 'agents', 'reviewer.md'),
      '# Reviewer\n\nUse /some-external-command to do something.'
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(0)
  })

  it('should detect multiple unqualified commands in same file', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await mkdir(join(plugin, 'agents'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'build.md'), '# Build')
    await writeFile(join(plugin, 'commands', 'test.md'), '# Test')
    await writeFile(
      join(plugin, 'agents', 'dev.md'),
      '# Developer\n\nFirst /build and then /test the project.'
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(2)
  })

  it('should recommend plugin name from manifest if specified', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await mkdir(join(plugin, 'agents'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'deploy.md'), '# Deploy')
    await writeFile(join(plugin, 'agents', 'reviewer.md'), '# Reviewer\n\nUse /deploy to deploy.')

    const context: LintContext = {
      spaces: [
        createSpaceLintData(
          'space1@abc123',
          createManifest({ id: 'space1' as SpaceId, plugin: { name: 'my-custom-plugin' } }),
          plugin
        ),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('/my-custom-plugin:deploy')
  })

  it('should suggest multiple spaces when command is in multiple spaces', async () => {
    const plugin1 = join(tempDir, 'plugin1')
    const plugin2 = join(tempDir, 'plugin2')

    await mkdir(join(plugin1, 'commands'), { recursive: true })
    await mkdir(join(plugin2, 'commands'), { recursive: true })
    await mkdir(join(plugin1, 'agents'), { recursive: true })

    await writeFile(join(plugin1, 'commands', 'shared.md'), '# Shared 1')
    await writeFile(join(plugin2, 'commands', 'shared.md'), '# Shared 2')
    await writeFile(
      join(plugin1, 'agents', 'coordinator.md'),
      '# Coordinator\n\nUse /shared to run.'
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin1),
        createSpaceLintData('space2@def456', createManifest({ id: 'space2' as SpaceId }), plugin2),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('/space1:shared')
    expect(warnings[0]?.message).toContain('/space2:shared')
  })

  it('should not match URLs or paths that look like commands', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await mkdir(join(plugin, 'agents'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'build.md'), '# Build')
    await writeFile(
      join(plugin, 'agents', 'reviewer.md'),
      '# Reviewer\n\nVisit https://example.com/build or /path/to/build for docs.'
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkAgentCommandNamespace(context)
    expect(warnings).toHaveLength(0)
  })
})

describe('W203: checkHookPaths', () => {
  it('should return no warnings for simple script paths', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: [{ event: 'pre-commit', script: 'pre-commit.sh' }],
      })
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHookPaths(context)
    expect(warnings).toHaveLength(0)
  })

  it('should warn about relative parent paths', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: [{ event: 'pre-commit', script: '../scripts/hook.sh' }],
      })
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHookPaths(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.HOOK_PATH_NO_PLUGIN_ROOT)
  })
})

describe('W204: checkHooksConfig', () => {
  it('should return no warnings when no hooks directory', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(plugin, { recursive: true })

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHooksConfig(context)
    expect(warnings).toHaveLength(0)
  })

  it('should warn when hooks directory exists but hooks.json missing', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHooksConfig(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.INVALID_HOOKS_CONFIG)
  })

  it('should warn when hooks.json is invalid', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(join(plugin, 'hooks', 'hooks.json'), 'not json')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHooksConfig(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.INVALID_HOOKS_CONFIG)
  })

  it('should warn when hooks.json missing hooks object', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({}))

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHooksConfig(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('hooks')
  })

  it('should return no warnings for valid hooks.json', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo test' }] }],
        },
      })
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHooksConfig(context)
    expect(warnings).toHaveLength(0)
  })
})

describe('W205: checkPluginNameCollisions', () => {
  it('should return no warnings when no collisions', () => {
    const context: LintContext = {
      spaces: [
        createSpaceLintData(
          'space1@abc123',
          createManifest({ id: 'space1' as SpaceId }),
          join(tempDir, 'plugin1')
        ),
        createSpaceLintData(
          'space2@def456',
          createManifest({ id: 'space2' as SpaceId }),
          join(tempDir, 'plugin2')
        ),
      ],
    }

    const warnings = checkPluginNameCollisions(context)
    expect(warnings).toHaveLength(0)
  })

  it('should detect plugin name collisions', () => {
    const context: LintContext = {
      spaces: [
        createSpaceLintData(
          'space1@abc123',
          createManifest({
            id: 'space1' as SpaceId,
            plugin: { name: 'shared-plugin' },
          }),
          join(tempDir, 'plugin1')
        ),
        createSpaceLintData(
          'space2@def456',
          createManifest({
            id: 'space2' as SpaceId,
            plugin: { name: 'shared-plugin' },
          }),
          join(tempDir, 'plugin2')
        ),
      ],
    }

    const warnings = checkPluginNameCollisions(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.PLUGIN_NAME_COLLISION)
    expect(warnings[0]?.message).toContain('shared-plugin')
  })
})

describe('W206: checkHookScriptsExecutable', () => {
  it('should return no warnings when script is executable', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: [{ event: 'pre-commit', script: 'hook.sh' }],
      })
    )
    await writeFile(join(plugin, 'hooks', 'hook.sh'), '#!/bin/bash\necho test')
    await chmod(join(plugin, 'hooks', 'hook.sh'), 0o755)

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHookScriptsExecutable(context)
    expect(warnings).toHaveLength(0)
  })

  it('should warn when script is not executable', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: [{ event: 'pre-commit', script: 'hook.sh' }],
      })
    )
    await writeFile(join(plugin, 'hooks', 'hook.sh'), '#!/bin/bash\necho test')
    await chmod(join(plugin, 'hooks', 'hook.sh'), 0o644)

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHookScriptsExecutable(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.NON_EXECUTABLE_HOOK_SCRIPT)
  })

  it('should skip missing scripts', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'hooks'), { recursive: true })
    await writeFile(
      join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: [{ event: 'pre-commit', script: 'nonexistent.sh' }],
      })
    )

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkHookScriptsExecutable(context)
    expect(warnings).toHaveLength(0)
  })
})

describe('W207: checkPluginStructure', () => {
  it('should return no warnings when no .claude-plugin directory', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await writeFile(join(plugin, 'commands', 'cmd.md'), '# Command')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkPluginStructure(context)
    expect(warnings).toHaveLength(0)
  })

  it('should return no warnings when .claude-plugin has only plugin.json', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
    await mkdir(join(plugin, 'commands'), { recursive: true })
    await writeFile(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'test-plugin' })
    )
    await writeFile(join(plugin, 'commands', 'cmd.md'), '# Command')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkPluginStructure(context)
    expect(warnings).toHaveLength(0)
  })

  it('should warn when commands/ is inside .claude-plugin/', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, '.claude-plugin', 'commands'), { recursive: true })
    await writeFile(join(plugin, '.claude-plugin', 'commands', 'cmd.md'), '# Command')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkPluginStructure(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.INVALID_PLUGIN_STRUCTURE)
    expect(warnings[0]?.message).toContain('commands/')
    expect(warnings[0]?.message).toContain('plugin root')
  })

  it('should warn when agents/ is inside .claude-plugin/', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, '.claude-plugin', 'agents'), { recursive: true })
    await writeFile(join(plugin, '.claude-plugin', 'agents', 'agent.md'), '# Agent')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkPluginStructure(context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe(WARNING_CODES.INVALID_PLUGIN_STRUCTURE)
    expect(warnings[0]?.message).toContain('agents/')
  })

  it('should detect multiple nested component directories', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, '.claude-plugin', 'commands'), { recursive: true })
    await mkdir(join(plugin, '.claude-plugin', 'skills'), { recursive: true })
    await mkdir(join(plugin, '.claude-plugin', 'hooks'), { recursive: true })

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkPluginStructure(context)
    expect(warnings).toHaveLength(3)
    expect(warnings.every((w) => w.code === WARNING_CODES.INVALID_PLUGIN_STRUCTURE)).toBe(true)
  })

  it('should not warn about non-component directories in .claude-plugin', async () => {
    const plugin = join(tempDir, 'plugin')
    await mkdir(join(plugin, '.claude-plugin', 'other'), { recursive: true })
    await writeFile(join(plugin, '.claude-plugin', 'other', 'file.txt'), 'content')

    const context: LintContext = {
      spaces: [
        createSpaceLintData('space1@abc123', createManifest({ id: 'space1' as SpaceId }), plugin),
      ],
    }

    const warnings = await checkPluginStructure(context)
    expect(warnings).toHaveLength(0)
  })
})
