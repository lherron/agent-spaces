/**
 * RED tests: model_reasoning_effort in CodexAdapter (T-00947)
 *
 * WHY: Codex CLI supports `-c model_reasoning_effort="<value>"` to control
 * reasoning effort at runtime. This must be:
 * 1. Written into codex.home/config.toml during target composition
 *    (persisted default from asp-targets.toml)
 * 2. Emitted as a CLI `-c` override in buildRunArgs when provided at runtime
 * 3. CLI override (modelReasoningEffort) must take precedence over any composed default
 *
 * PASS CONDITIONS (all tests green when):
 * 1. composeTarget: when `codexOptions.model_reasoning_effort` is set, the generated
 *    config.toml contains `model_reasoning_effort = "<value>"`
 * 2. buildRunArgs: when `options.modelReasoningEffort` is set, args include
 *    `-c` and `model_reasoning_effort="<value>"` (in both interactive and exec modes)
 * 3. Precedence: `modelReasoningEffort` from buildRunArgs options always wins over
 *    any value that may have been written to config.toml during compose
 *
 * wrkq task: T-00947
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'
import type { ComposedTargetBundle, SpaceKey } from 'spaces-config'
import { CodexAdapter } from './codex-adapter.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBundle(outputDir: string): ComposedTargetBundle {
  return {
    harnessId: 'codex' as const,
    targetName: 'test-target',
    rootDir: outputDir,
    pluginDirs: [join(outputDir, 'codex.home')],
    codex: {
      homeTemplatePath: join(outputDir, 'codex.home'),
      configPath: join(outputDir, 'codex.home', 'config.toml'),
      agentsPath: join(outputDir, 'codex.home', 'AGENTS.md'),
      skillsDir: join(outputDir, 'codex.home', 'skills'),
      promptsDir: join(outputDir, 'codex.home', 'prompts'),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. buildRunArgs: -c model_reasoning_effort="<value>"
// ─────────────────────────────────────────────────────────────────────────────

describe('CodexAdapter.buildRunArgs: model_reasoning_effort', () => {
  let adapter: CodexAdapter
  let tmpDir: string

  beforeEach(async () => {
    adapter = new CodexAdapter()
    tmpDir = join(tmpdir(), `codex-mre-run-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('exec mode: emits -c model_reasoning_effort="high"', () => {
    const bundle = makeBundle(tmpDir)
    const args = adapter.buildRunArgs(bundle, {
      interactive: false,
      prompt: 'do the thing',
      modelReasoningEffort: 'high',
    })

    // Find the -c flag for model_reasoning_effort
    const cIdx = args.lastIndexOf('-c')
    expect(cIdx).toBeGreaterThan(-1)
    const found = args.some(
      (a, i) => i > 0 && args[i - 1] === '-c' && a.includes('model_reasoning_effort=')
    )
    expect(found).toBe(true)

    const mreArg = args[args.indexOf('-c', args.lastIndexOf('exec') + 1) + 1]
    expect(mreArg).toBe('model_reasoning_effort="high"')
  })

  test('interactive mode: emits -c model_reasoning_effort="medium"', () => {
    const bundle = makeBundle(tmpDir)
    const args = adapter.buildRunArgs(bundle, {
      interactive: true,
      prompt: 'think carefully',
      modelReasoningEffort: 'medium',
    })

    const found = args.some(
      (a, i) => i > 0 && args[i - 1] === '-c' && a === 'model_reasoning_effort="medium"'
    )
    expect(found).toBe(true)
  })

  test('omits -c model_reasoning_effort when not set', () => {
    const bundle = makeBundle(tmpDir)
    const args = adapter.buildRunArgs(bundle, {
      interactive: false,
      prompt: 'work normally',
    })

    const hasMre = args.some((a) => a.includes('model_reasoning_effort'))
    expect(hasMre).toBe(false)
  })

  test('all valid effort values are emitted verbatim', () => {
    const bundle = makeBundle(tmpDir)
    for (const effort of ['high', 'medium', 'low']) {
      const args = adapter.buildRunArgs(bundle, {
        interactive: false,
        prompt: 'test',
        modelReasoningEffort: effort,
      })
      const found = args.some(
        (a, i) => i > 0 && args[i - 1] === '-c' && a === `model_reasoning_effort="${effort}"`
      )
      expect(found).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. composeTarget: config.toml contains model_reasoning_effort
// ─────────────────────────────────────────────────────────────────────────────

describe('CodexAdapter.composeTarget: model_reasoning_effort in config.toml', () => {
  let adapter: CodexAdapter
  let tmpDir: string
  let outputDir: string
  let artifact1Dir: string

  beforeEach(async () => {
    adapter = new CodexAdapter()
    tmpDir = join(tmpdir(), `codex-mre-compose-${Date.now()}`)
    outputDir = join(tmpDir, 'output')
    artifact1Dir = join(tmpDir, 'artifact1')

    await mkdir(outputDir, { recursive: true })
    await mkdir(artifact1Dir, { recursive: true })
    await writeFile(join(artifact1Dir, 'instructions.md'), '# Test Space')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('writes model_reasoning_effort to config.toml when provided via codexOptions', async () => {
    const input = {
      targetName: 'test-target',
      compose: [],
      roots: [],
      loadOrder: [],
      artifacts: [
        {
          spaceKey: 'space1@abc' as SpaceKey,
          spaceId: 'space1',
          artifactPath: artifact1Dir,
          pluginName: 'space1',
          pluginVersion: '1.0.0',
        },
      ],
      settingsInputs: [],
      codexOptions: {
        model_reasoning_effort: 'high',
      },
    }

    await adapter.composeTarget(input, outputDir, { clean: true })

    const configRaw = await readFile(join(outputDir, 'codex.home', 'config.toml'), 'utf-8')
    const parsed = TOML.parse(configRaw) as Record<string, unknown>
    expect(parsed['model_reasoning_effort']).toBe('high')
  })

  test('omits model_reasoning_effort from config.toml when not set in codexOptions', async () => {
    const input = {
      targetName: 'test-target',
      compose: [],
      roots: [],
      loadOrder: [],
      artifacts: [
        {
          spaceKey: 'space1@abc' as SpaceKey,
          spaceId: 'space1',
          artifactPath: artifact1Dir,
          pluginName: 'space1',
          pluginVersion: '1.0.0',
        },
      ],
      settingsInputs: [],
      codexOptions: {
        model: 'gpt-5.4',
      },
    }

    await adapter.composeTarget(input, outputDir, { clean: true })

    const configRaw = await readFile(join(outputDir, 'codex.home', 'config.toml'), 'utf-8')
    const parsed = TOML.parse(configRaw) as Record<string, unknown>
    expect(parsed['model_reasoning_effort']).toBeUndefined()
  })

  test('preserves other codexOptions fields alongside model_reasoning_effort', async () => {
    const input = {
      targetName: 'test-target',
      compose: [],
      roots: [],
      loadOrder: [],
      artifacts: [
        {
          spaceKey: 'space1@abc' as SpaceKey,
          spaceId: 'space1',
          artifactPath: artifact1Dir,
          pluginName: 'space1',
          pluginVersion: '1.0.0',
        },
      ],
      settingsInputs: [],
      codexOptions: {
        model: 'gpt-5.3-codex',
        approval_policy: 'on-request' as const,
        model_reasoning_effort: 'medium',
      },
    }

    await adapter.composeTarget(input, outputDir, { clean: true })

    const configRaw = await readFile(join(outputDir, 'codex.home', 'config.toml'), 'utf-8')
    const parsed = TOML.parse(configRaw) as Record<string, unknown>
    expect(parsed['model']).toBe('gpt-5.3-codex')
    expect(parsed['approval_policy']).toBe('on-request')
    expect(parsed['model_reasoning_effort']).toBe('medium')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Precedence: CLI override beats composed config.toml default
// ─────────────────────────────────────────────────────────────────────────────

describe('CodexAdapter: model_reasoning_effort precedence', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
  })

  test('buildRunArgs CLI override "high" beats any lower precedence default', () => {
    // Simulates: config.toml has model_reasoning_effort=low (from compose)
    // but CLI passes modelReasoningEffort="high" — CLI wins
    const bundle = makeBundle('/tmp/fake')
    const argsWithOverride = adapter.buildRunArgs(bundle, {
      interactive: false,
      prompt: 'test precedence',
      modelReasoningEffort: 'high', // CLI override
    })
    const argsWithoutOverride = adapter.buildRunArgs(bundle, {
      interactive: false,
      prompt: 'test precedence',
      // no CLI override — codex will use whatever is in config.toml
    })

    // With CLI override: model_reasoning_effort="high" must appear in args
    const overridePresent = argsWithOverride.some(
      (a, i) => i > 0 && argsWithOverride[i - 1] === '-c' && a === 'model_reasoning_effort="high"'
    )
    expect(overridePresent).toBe(true)

    // Without CLI override: model_reasoning_effort must NOT appear in args
    // (config.toml handles the default; we don't re-emit it in args)
    const noOverrideAbsent = !argsWithoutOverride.some((a) => a.includes('model_reasoning_effort'))
    expect(noOverrideAbsent).toBe(true)
  })
})
