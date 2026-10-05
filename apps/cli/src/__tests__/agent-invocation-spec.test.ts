/**
 * The placement invocation spec `asp agent ... --dry-run --json` prints:
 * full harness argv and env (T-00874), prompt placement (T-00875) and model
 * selection (T-00878) for the claude and codex harnesses.
 */

import { describe, expect } from 'bun:test'

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
  })

  cliTest('displayCommand is present and non-empty', () => {
    const { spec } = agentDryRunSpec({ prompt: 'Hello' })

    expect(spec.displayCommand).toBeDefined()
    expect(typeof spec.displayCommand).toBe('string')
    expect(spec.displayCommand?.length).toBeGreaterThan(0)
  })

  cliTest('ASP_HOME is in env', () => {
    const { spec } = agentDryRunSpec({ prompt: 'Hello' })

    expect(spec.env['ASP_HOME']).toBeDefined()
    expect(typeof spec.env['ASP_HOME']).toBe('string')
  })

  cliTest('adapter env vars present (ASP_PLUGIN_ROOT for claude-code)', () => {
    const { spec } = agentDryRunSpec({ prompt: 'Hello' })

    expect(spec.env['ASP_PLUGIN_ROOT']).toBeDefined()
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

  cliTest('codex-cli descriptor contains prompt text', () => {
    const { spec } = agentDryRunSpec({
      prompt: CLIPASS_PROMPT,
      harness: 'codex',
      flags: ['--presentation', 'false'],
    })

    expect(spec.argv).not.toContain(CLIPASS_PROMPT)
    expect(spec.codexAppServer?.prompt).toContain(CLIPASS_PROMPT)
  })

  cliTest('no prompt in argv when prompt not provided (heartbeat)', () => {
    const { spec } = agentDryRunSpec({ mode: 'heartbeat' })

    expect(spec.argv).not.toContain('-p')
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

  cliTest('codex-cli default model is GPT-5.6 Terra in dry-run', () => {
    const { spec } = agentDryRunSpec({
      prompt: 'Hello',
      harness: 'codex',
      flags: ['--presentation', 'false'],
    })

    expect(spec.argv).not.toContain('--model')
    expect(spec.codexAppServer?.model).toBe('gpt-5.6-terra')
  })
})
