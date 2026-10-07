/**
 * Codex hooks: HRC hook config and trust state, and space pre_tool_use hooks
 * carried from materialization through composition to a blocking command.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'
import {
  codexArtifact,
  composeTargetInput,
  createMaterializeInput,
} from '../test-support/codex-adapter-inputs.js'
import {
  CODEX_INTERACTIVE_HOOK_EVENTS,
  CodexAdapter,
  buildCodexHookTrustState,
  buildHrcCodexHooksConfig,
} from './codex-adapter.js'

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
  })

  test('interactive hook materialization includes SessionStart and trust state', () => {
    const hooksConfig = buildHrcCodexHooksConfig(CODEX_INTERACTIVE_HOOK_EVENTS)
    const hookNames = Object.keys(hooksConfig['hooks'] as Record<string, unknown>)

    expect(hookNames).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
    ])
    expect(Object.keys(buildHrcCodexHooksConfig()['hooks'] as Record<string, unknown>)).toEqual([
      'Stop',
    ])

    const trustState = buildCodexHookTrustState('/tmp/codex-home/hooks.json', hooksConfig)
    expect(Object.keys(trustState)).toContain('/tmp/codex-home/hooks.json:session_start:0:0')
    expect(trustState['/tmp/codex-home/hooks.json:session_start:0:0']?.trusted_hash).toMatch(
      /^sha256:[a-f0-9]{64}$/
    )
  })

  describe('space pre_tool_use hooks (T-10389)', () => {
    let tmpDir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `codex-adapter-space-hooks-${Date.now()}`)
      const hooksDir = join(tmpDir, 'snapshot', 'hooks')
      await mkdir(join(hooksDir, 'scripts'), { recursive: true })
      await writeFile(
        join(hooksDir, 'hooks.toml'),
        [
          '[[hook]]',
          'event = "pre_tool_use"',
          'script = "hooks/scripts/guard.sh"',
          'tools = ["Bash"]',
          'harness = "codex"',
          '',
          '[[hook]]',
          'event = "pre_tool_use"',
          'script = "hooks/scripts/claude-only.sh"',
          'harness = "claude"',
          '',
          '[[hook]]',
          'event = "pre_tool_use"',
          'script = "hooks/scripts/neutral.sh"',
          '',
          '[[hook]]',
          'event = "stop"',
          'script = "hooks/scripts/guard.sh"',
          'harness = "codex"',
          '',
        ].join('\n')
      )
      await writeFile(
        join(hooksDir, 'scripts', 'guard.sh'),
        '#!/usr/bin/env bash\ngrep -q misordered && { echo "Refused: recipe" >&2; exit 2; }\nexit 0\n',
        { mode: 0o755 }
      )
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('only harness=codex pre_tool_use entries reach the composed hooks.json, and they block', async () => {
      const cacheDir = join(tmpDir, 'cache')
      const materialized = await adapter.materializeSpace(
        createMaterializeInput(join(tmpDir, 'snapshot')),
        cacheDir,
        { force: true, useHardlinks: false }
      )
      expect(materialized.files).toContain('space-hooks.json')
      expect(JSON.parse(await readFile(join(cacheDir, 'space-hooks.json'), 'utf-8'))).toEqual([
        { event: 'pre_tool_use', script: 'hooks/scripts/guard.sh', tools: ['Bash'] },
      ])

      const outputDir = join(tmpDir, 'output')
      await adapter.composeTarget(
        composeTargetInput('hooks-target', [codexArtifact('guarded@abc', cacheDir, '1.0.0')]),
        outputDir,
        { clean: true }
      )
      const codexHome = join(outputDir, 'codex.home')
      const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
      }
      // HRC's Stop capture is untouched; the space hook is the only PreToolUse group.
      expect(Object.keys(hooks.hooks).sort()).toEqual(['PreToolUse', 'Stop'])
      expect(hooks.hooks['Stop']).toHaveLength(1)
      const groups = hooks.hooks['PreToolUse'] ?? []
      expect(groups).toHaveLength(1)
      expect(groups[0]?.matcher).toBe('Bash')
      const command = groups[0]?.hooks[0]?.command ?? ''
      expect(command).toContain('${CODEX_HOME:-}/space-hooks/guarded/hooks/scripts/guard.sh')
      expect(command).not.toContain(tmpDir)

      // The fragment is kept for the runtime home's interactive re-merge.
      expect(
        JSON.parse(await readFile(join(codexHome, 'space-hooks.json'), 'utf-8')).hooks.PreToolUse
      ).toEqual(groups)

      // Trust state covers the merged PreToolUse handler.
      const config = TOML.parse(await readFile(join(codexHome, 'config.toml'), 'utf-8')) as {
        hooks?: { state?: Record<string, unknown> }
      }
      expect(
        Object.keys(config.hooks?.state ?? {}).some((k) => k.endsWith(':pre_tool_use:0:0'))
      ).toBe(true)

      // The command, run as codex runs it, blocks with exit 2 and the reason on stderr.
      const run = (stdin: string, env: Record<string, string>) =>
        Bun.spawnSync(['bash', '-c', command], {
          stdin: new TextEncoder().encode(stdin),
          env: { PATH: process.env['PATH'] ?? '', ...env },
        })
      const blocked = run('misordered', { CODEX_HOME: codexHome })
      expect(blocked.exitCode).toBe(2)
      expect(blocked.stderr.toString()).toContain('Refused: recipe')
      expect(run('fine', { CODEX_HOME: codexHome }).exitCode).toBe(0)
      // A home without the script fails open.
      expect(run('misordered', { CODEX_HOME: join(tmpDir, 'nowhere') }).exitCode).toBe(0)
    })
  })
})
