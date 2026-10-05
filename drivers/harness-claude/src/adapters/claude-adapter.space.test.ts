/**
 * ClaudeAdapter per-space surface: validateSpace and materializeSpace turn one
 * resolved space snapshot into a Claude plugin directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type MaterializeSpaceInput,
  type ResolvedSpaceManifest,
  type SpaceId,
  type SpaceKey,
  type SpaceManifest,
  asSpaceId,
  resolveSpaceManifest,
} from 'spaces-config'
import { ClaudeAdapter } from './claude-adapter.js'

const adapter = new ClaudeAdapter()

function createMaterializeInput(
  snapshotPath: string,
  manifestOverrides: Partial<SpaceManifest> = {}
): MaterializeSpaceInput {
  return {
    spaceKey: 'test-space@abc123' as SpaceKey,
    manifest: resolveSpaceManifest({
      schema: 1,
      id: asSpaceId('test-space'),
      version: '1.0.0',
      ...manifestOverrides,
    }),
    snapshotPath,
    integrity: 'sha256-test',
  }
}

describe('ClaudeAdapter.validateSpace', () => {
  test('validates space with valid id', () => {
    const result = adapter.validateSpace(
      createMaterializeInput('/test/snapshot', { id: asSpaceId('valid-space') })
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('validates space with plugin name', () => {
    const result = adapter.validateSpace(
      createMaterializeInput('/test/snapshot', {
        id: asSpaceId('test'),
        plugin: { name: 'my-plugin' },
      })
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('rejects space without id or plugin name', () => {
    // deliberately invalid: a manifest with neither id nor plugin.name exercises the rejection path
    const manifestWithoutIdentity = {
      schema: 1,
      version: '1.0.0',
    } as unknown as ResolvedSpaceManifest
    const result = adapter.validateSpace({
      ...createMaterializeInput('/test/snapshot'),
      manifest: manifestWithoutIdentity,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Space must have an id or plugin.name')
  })

  test('warns about non-kebab-case plugin names', () => {
    // deliberately not kebab-case: exercises the non-kebab-case warning path
    const nonKebabId = 'InvalidCaseName' as SpaceId
    const result = adapter.validateSpace(
      createMaterializeInput('/test/snapshot', { id: nonKebabId })
    )

    // Still valid, but with warning
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.includes('should be kebab-case'))).toBe(true)
  })

  test('accepts kebab-case plugin names without warning', () => {
    const result = adapter.validateSpace(
      createMaterializeInput('/test/snapshot', { id: asSpaceId('my-valid-plugin') })
    )

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })
})

describe('ClaudeAdapter.materializeSpace', () => {
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

  function materialize(
    manifestOverrides: Partial<SpaceManifest> = {},
    options: { force?: boolean } = {}
  ) {
    return adapter.materializeSpace(
      createMaterializeInput(snapshotDir, manifestOverrides),
      cacheDir,
      options
    )
  }

  test('creates plugin.json file', async () => {
    const result = await materialize({ id: asSpaceId('test-plugin') })

    expect(result.files).toContain('.claude-plugin/plugin.json')
    const pluginJson = await Bun.file(join(cacheDir, '.claude-plugin/plugin.json')).json()
    expect(pluginJson.name).toBe('test-plugin')
  })

  test('links AGENT.md to CLAUDE.md', async () => {
    await writeFile(join(snapshotDir, 'AGENT.md'), '# Agent Instructions')

    const result = await materialize()

    expect(result.files).toContain('CLAUDE.md')
    expect(await Bun.file(join(cacheDir, 'CLAUDE.md')).text()).toBe('# Agent Instructions')
  })

  test('preserves CLAUDE.md when present', async () => {
    // Legacy spaces ship CLAUDE.md directly
    await writeFile(join(snapshotDir, 'CLAUDE.md'), '# Claude Instructions')

    const result = await materialize()

    expect(result.files).toContain('CLAUDE.md')
    expect(await Bun.file(join(cacheDir, 'CLAUDE.md')).text()).toBe('# Claude Instructions')
  })

  test('converts hooks.toml to hooks.json', async () => {
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
    // The referenced script must exist for validation
    await writeFile(join(hooksDir, 'validate.sh'), '#!/bin/bash\necho "validating"')
    await chmod(join(hooksDir, 'validate.sh'), 0o755)

    await materialize()

    const hooksJson = await Bun.file(join(cacheDir, 'hooks', 'hooks.json')).json()
    expect(hooksJson.hooks.PreToolUse).toHaveLength(1)
    expect(hooksJson.hooks.PreToolUse[0].matcher).toBe('*')
  })

  test('copies permissions.toml when present', async () => {
    await writeFile(
      join(snapshotDir, 'permissions.toml'),
      `
[read]
allow = ["/tmp", "/var"]

[write]
allow = ["/tmp"]
`
    )

    const result = await materialize()

    expect(result.files).toContain('permissions.toml')
  })

  test('returns artifact path', async () => {
    const result = await materialize()

    expect(result.artifactPath).toBe(cacheDir)
  })

  test('cleans cache directory when force: true', async () => {
    await writeFile(join(cacheDir, 'old-file.txt'), 'old content')

    await materialize({}, { force: true })

    expect(await Bun.file(join(cacheDir, 'old-file.txt')).exists()).toBe(false)
  })

  for (const [component, file] of [
    ['commands', 'test.md'],
    ['skills', 'skill.md'],
  ] as const) {
    test(`links ${component} directory when present`, async () => {
      await mkdir(join(snapshotDir, component), { recursive: true })
      await writeFile(join(snapshotDir, component, file), `# Test ${component}`)

      const result = await materialize()

      expect(result.files.some((f) => f.includes(component))).toBe(true)
    })
  }
})
