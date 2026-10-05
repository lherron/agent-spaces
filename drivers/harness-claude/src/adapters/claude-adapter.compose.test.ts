/**
 * ClaudeAdapter.composeTarget: assembles materialized space artifacts into one
 * target bundle (ordered plugin dirs, MCP config, settings, statusline).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ComposeTargetInput,
  ComposeTargetResult,
  ResolvedSpaceArtifact,
  SpaceKey,
  SpaceRefString,
  SpaceSettings,
} from 'spaces-config'
import { ClaudeAdapter } from './claude-adapter.js'

const adapter = new ClaudeAdapter()

function artifact(
  spaceId: string,
  commit: string,
  artifactPath: string,
  pluginName: string
): ResolvedSpaceArtifact {
  return { spaceKey: `${spaceId}@${commit}` as SpaceKey, spaceId, artifactPath, pluginName }
}

/** A test-target compose input whose roots/loadOrder follow the given artifacts. */
function composeInput(
  artifacts: ResolvedSpaceArtifact[],
  settingsInputs: SpaceSettings[] = []
): ComposeTargetInput {
  return {
    targetName: 'test-target',
    compose: artifacts.map((a) => a.spaceId as SpaceRefString),
    roots: artifacts.slice(0, 1).map((a) => a.spaceKey),
    loadOrder: artifacts.map((a) => a.spaceKey),
    artifacts,
    settingsInputs,
  }
}

/** Read the composed settings.json, which every compose writes. */
async function readSettings(result: ComposeTargetResult) {
  expect(result.bundle.settingsPath).toBeDefined()
  return Bun.file(result.bundle.settingsPath as string).json()
}

describe('ClaudeAdapter.composeTarget', () => {
  let tmpDir: string
  let outputDir: string
  let artifact1Dir: string
  let artifact2Dir: string

  /** The single space1@abc artifact most compositions use. */
  const oneArtifactInput = () => composeInput([artifact('space1', 'abc', artifact1Dir, 'plugin1')])

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `claude-adapter-compose-${Date.now()}`)
    outputDir = join(tmpDir, 'output')
    artifact1Dir = join(tmpDir, 'artifact1')
    artifact2Dir = join(tmpDir, 'artifact2')

    await mkdir(outputDir, { recursive: true })
    for (const [dir, name] of [
      [artifact1Dir, 'plugin1'],
      [artifact2Dir, 'plugin2'],
    ] as const) {
      await mkdir(join(dir, '.claude-plugin'), { recursive: true })
      await writeFile(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name }))
    }
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('creates plugins directory with ordered artifacts', async () => {
    const input = composeInput([
      artifact('space1', 'abc', artifact1Dir, 'plugin1'),
      artifact('space2', 'def', artifact2Dir, 'plugin2'),
    ])

    const result = await adapter.composeTarget(input, outputDir, {})

    expect(result.bundle.harnessId).toBe('claude')
    expect(result.bundle.targetName).toBe('test-target')
    expect(result.bundle.rootDir).toBe(outputDir)
    expect(result.bundle.pluginDirs).toHaveLength(2)
    // Plugins carry load-order prefixes
    expect(result.bundle.pluginDirs?.[0]).toContain('000-space1')
    expect(result.bundle.pluginDirs?.[1]).toContain('001-space2')
  })

  test('cleans output directory when clean: true', async () => {
    await writeFile(join(outputDir, 'old-file.txt'), 'old')

    await adapter.composeTarget(composeInput([]), outputDir, { clean: true })

    expect(await Bun.file(join(outputDir, 'old-file.txt')).exists()).toBe(false)
  })

  test('composes MCP config from plugins', async () => {
    // composeMcpFromSpaces reads mcp/mcp.json, not individual server files
    const mcpDir = join(artifact1Dir, 'mcp')
    await mkdir(mcpDir, { recursive: true })
    await writeFile(
      join(mcpDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'test-server': { type: 'stdio', command: 'test-server', args: ['--test'] },
        },
      })
    )

    const result = await adapter.composeTarget(oneArtifactInput(), outputDir, {})

    expect(result.bundle.mcpConfigPath).toBeDefined()
    if (result.bundle.mcpConfigPath) {
      const mcpConfig = await Bun.file(result.bundle.mcpConfigPath).json()
      expect(mcpConfig.mcpServers['test-server']).toBeDefined()
    }
  })

  test('composes settings from inputs', async () => {
    const input = composeInput(
      [artifact('space1', 'abc', artifact1Dir, 'plugin1')],
      [{ model: 'opus', permissionMode: 'full' } as SpaceSettings]
    )

    const result = await adapter.composeTarget(input, outputDir, {})

    expect(result.bundle.settingsPath).toBeDefined()
  })

  test('installs statusline script and adds to settings', async () => {
    const result = await adapter.composeTarget(oneArtifactInput(), outputDir, {})

    expect(await Bun.file(join(outputDir, 'statusline.sh')).exists()).toBe(true)

    const settings = await readSettings(result)
    expect(settings.statusLine).toBeDefined()
    expect(settings.statusLine.type).toBe('command')
    expect(settings.statusLine.command).toContain('statusline.sh')
    expect(settings.statusLine.command).toContain(outputDir)
    // Agents opt into a bounded AskUserQuestion idle timeout
    expect(settings.askUserQuestionTimeout).toBe('60s')
    // Every agent run renders in the fullscreen (alt-screen) TUI
    expect(settings.tui).toBe('fullscreen')
  })

  test('writes statusline script to staging but points settings at published output', async () => {
    const publishedOutputPath = join(tmpDir, 'published', 'test-target', 'claude')

    const result = await adapter.composeTarget(oneArtifactInput(), outputDir, {
      publishedOutputPath,
    })

    expect(await Bun.file(join(outputDir, 'statusline.sh')).exists()).toBe(true)
    const settings = await readSettings(result)
    expect(settings.statusLine.command).toBe(`bash ${join(publishedOutputPath, 'statusline.sh')}`)
    expect(settings.statusLine.command).not.toContain(outputDir)
  })

  test('requires and verifies an injected release statusline asset', async () => {
    const sourcePath = join(tmpDir, 'release-statusline.sh')
    const sourceBytes = '#!/bin/sh\necho release-statusline\n'
    await writeFile(sourcePath, sourceBytes)
    const input = oneArtifactInput()

    const releaseAdapter = new ClaudeAdapter({
      statuslineSource: {
        path: sourcePath,
        sha256: createHash('sha256').update(sourceBytes).digest('hex'),
        required: true,
      },
    })
    await releaseAdapter.composeTarget(input, outputDir, {})
    expect(await Bun.file(join(outputDir, 'statusline.sh')).text()).toBe(sourceBytes)

    const mismatch = new ClaudeAdapter({
      statuslineSource: { path: sourcePath, sha256: '0'.repeat(64), required: true },
    })
    await expect(mismatch.composeTarget(input, outputDir, { clean: true })).rejects.toThrow(
      'statusline asset digest mismatch'
    )

    const missing = new ClaudeAdapter({
      statuslineSource: {
        path: join(tmpDir, 'missing-statusline.sh'),
        sha256: '0'.repeat(64),
        required: true,
      },
    })
    await expect(missing.composeTarget(input, outputDir, { clean: true })).rejects.toThrow()
  })

  test('merges permissions.toml into settings', async () => {
    // permissions.toml uses paths=[] for read/write, not allow=[]
    await writeFile(
      join(artifact1Dir, 'permissions.toml'),
      `
[read]
paths = ["/tmp"]

[write]
paths = ["/var/log"]
`
    )

    const result = await adapter.composeTarget(oneArtifactInput(), outputDir, {})

    const settings = await readSettings(result)
    expect(settings.permissions).toBeDefined()
    // Read and Write tools are allowed
    expect(settings.permissions.allow).toContain('Read')
    expect(settings.permissions.allow).toContain('Write')
  })
})
