/**
 * The placement invocation spec `asp agent ... --dry-run --json` prints:
 * full harness argv and env (T-00874), prompt placement (T-00875) and model
 * selection (T-00878) for the claude and codex harnesses.
 */

import { afterAll, describe, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentArgs, agentDryRunSpec, cliTest, runAsp } from './asp-cli'

const CLIPASS_PROMPT = 'Reply with exactly: CLIPASS'

describe('placement invocation produces full argv (T-00874)', () => {
  cliTest('claude-code argv contains real binary path and --model flag', () => {
    const { spec } = agentDryRunSpec({
      prompt: 'Hello',
      flags: ['--host-session-id', 'argv-test-1'],
    })

    // argv must have more than just [frontend] — should have real binary + flags
    expect(spec.argv.length).toBeGreaterThan(1)
    // argv[0] should be a real binary path, not just "claude-code"
    expect(spec.argv[0]).not.toBe('claude-code')
    expect(spec.argv).toContain('--model')
  })

  cliTest('codex-cli argv contains app-server subcommand and structured model descriptor', () => {
    const { spec } = agentDryRunSpec({
      prompt: 'Hello',
      harness: 'codex',
      flags: ['--host-session-id', 'argv-test-2', '--presentation', 'false'],
    })

    expect(spec.argv.length).toBeGreaterThan(1)
    expect(spec.argv).toContain('--enable')
    expect(spec.argv).toContain('goals')
    expect(spec.argv).toContain('app-server')
    expect(spec.argv).not.toContain('exec')
    expect(spec.argv).not.toContain('--model')
    expect(spec.codexAppServer).toMatchObject({
      model: 'gpt-5.6-terra',
      approvalPolicy: 'never',
      featureFlags: ['goals'],
    })
    expect(spec.codexAppServer?.prompt).toContain('Hello')
    // The codex prompt travels in the descriptor, never on argv.
    expect(spec.argv).not.toContain('Hello')
  })

  cliTest('displayCommand is the env-prefixed shell form of argv ending in the prompt', () => {
    const { spec } = agentDryRunSpec({ prompt: 'Hello' })

    expect(spec.displayCommand).toStartWith(`ASP_PLUGIN_ROOT=${spec.env['ASP_PLUGIN_ROOT']} `)
    expect(spec.displayCommand).toContain(` ${spec.argv[0]} ${spec.argv[1]} `)
    expect(spec.displayCommand).toEndWith(' -- Hello')
  })

  describe('under an explicit ASP_HOME', () => {
    const aspHome = mkdtempSync(join(tmpdir(), 'asp-invocation-spec-home-'))
    afterAll(() => rmSync(aspHome, { recursive: true, force: true }))

    cliTest(
      'ASP_HOME reaches the spec env and the claude plugin root is materialized under it',
      () => {
        const { spec } = agentDryRunSpec({ prompt: 'Hello' }, { ASP_HOME: aspHome })

        expect(spec.env['ASP_HOME']).toBe(aspHome)
        expect(spec.env['ASP_PLUGIN_ROOT']).toStartWith(`${join(aspHome, 'codex-homes')}/`)
        expect(spec.env['ASP_PLUGIN_ROOT']).toEndWith('/claude')
      }
    )
  })

  cliTest('unsupported model throws via placement path', () => {
    const result = runAsp(
      agentArgs({
        prompt: 'Hello',
        harness: 'claude',
        flags: ['--model', 'not-a-real-model', '--dry-run', '--json'],
      })
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/does not support model|model not supported/i)
  })
})

describe('prompt in argv (T-00875)', () => {
  cliTest('claude-code argv contains -p flag with prompt text', () => {
    const { spec } = agentDryRunSpec({ prompt: CLIPASS_PROMPT, flags: ['--presentation', 'false'] })

    const pIdx = spec.argv.indexOf('-p')
    expect(pIdx).toBeGreaterThan(-1)
    expect(spec.argv[pIdx + 1]).toBe(CLIPASS_PROMPT)
  })

  cliTest('heartbeat without a prompt succeeds and carries no prompt anywhere', () => {
    const { result, spec } = agentDryRunSpec({ mode: 'heartbeat' })

    expect(result.exitCode).toBe(0)
    expect(spec.argv).not.toContain('-p')
    // A claude query prompt rides after `--`; a heartbeat has no prompt tail.
    expect(spec.argv).not.toContain('--')
    expect(spec.env['ASP_PRIMING_PROMPT']).toBeUndefined()
  })
})

describe('gpt-5.5 model support (T-00878)', () => {
  cliTest('codex-cli accepts gpt-5.5 model', () => {
    const { result, spec } = agentDryRunSpec({
      prompt: 'Hello',
      harness: 'codex',
      flags: ['--model', 'gpt-5.5', '--presentation', 'false'],
    })

    expect(result.exitCode).toBe(0)
    expect(spec.argv).not.toContain('--model')
    expect(spec.codexAppServer?.model).toBe('gpt-5.5')
  })
})
