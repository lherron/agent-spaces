/**
 * model_reasoning_effort in CodexAdapter run args (T-00947)
 *
 * WHY: Codex CLI supports `-c model_reasoning_effort="<value>"` to control
 * reasoning effort at runtime. A runtime override (modelReasoningEffort) is
 * emitted as a CLI `-c` override for interactive runs and carried in the
 * app-server descriptor for headless runs; without one, nothing is emitted and
 * the composed config.toml default applies (see codex-adapter.compose.test.ts).
 *
 * wrkq task: T-00947
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposedTargetBundle } from 'spaces-config'
import { CodexAdapter, buildCodexAppServerLaunchDescriptor } from './codex-adapter.js'

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

  test('headless app-server mode: carries modelReasoningEffort in descriptor', () => {
    const bundle = makeBundle(tmpDir)
    const options = {
      interactive: false,
      prompt: 'do the thing',
      modelReasoningEffort: 'high',
    } as const
    const args = adapter.buildRunArgs(bundle, options)
    const descriptor = buildCodexAppServerLaunchDescriptor(options)

    expect(args).toEqual(['--enable', 'goals', 'app-server'])
    expect(descriptor.modelReasoningEffort).toBe('high')
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

  test('interactive launch without an effort emits no model_reasoning_effort override', () => {
    const bundle = makeBundle(tmpDir)
    const args = adapter.buildRunArgs(bundle, {
      interactive: true,
      prompt: 'work normally',
    })

    const hasMre = args.some((a) => a.includes('model_reasoning_effort'))
    expect(hasMre).toBe(false)
  })
})
