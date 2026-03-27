/**
 * RED tests for M6: CLI surface for standalone agent execution.
 *
 * Tests for `asp agent` subcommands, existing CLI compatibility,
 * and bundle selection flags.
 *
 * wrkq tasks: T-00865 (asp agent <scope-ref> <mode>), T-00866 (asp agent resolve),
 *             T-00867 (existing CLI compat), T-00868 (bundle selection flags)
 *
 * PASS CONDITIONS:
 * 1. `asp agent <scope-ref> <mode>` parses positional ScopeRef + mode verb.
 * 2. `asp agent resolve <scope-ref>` resolves and prints without executing.
 * 3. Existing `asp run`, `asp install`, etc. still work unchanged.
 * 4. Bundle selection flags (--bundle, --agent-target, --project-target, --compose) work.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Resolve fixture roots directly — CLI tests can't use workspace package subpath imports
const FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'config',
  'src',
  '__fixtures__',
  'v2'
)
function resolveAgentRoot(): string {
  return join(FIXTURES_DIR, 'agent-root')
}
function resolveProjectRoot(): string {
  return join(FIXTURES_DIR, 'project-root')
}

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')

/**
 * Run the asp CLI with args and return stdout/stderr/exitCode.
 * Uses execFileSync with timeout to avoid hanging.
 */
function runAsp(
  args: string[],
  options: { env?: Record<string, string>; expectError?: boolean } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...options.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout: result, stderr: '', exitCode: 0 }
  } catch (err: any) {
    if (options.expectError) {
      return {
        stdout: err.stdout?.toString() ?? '',
        stderr: err.stderr?.toString() ?? '',
        exitCode: err.status ?? 1,
      }
    }
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    }
  }
}

// ===================================================================
// T-00865: asp agent <scope-ref> <mode>
// ===================================================================
describe('asp agent <scope-ref> <mode> (T-00865)', () => {
  test('asp agent --help shows agent subcommand', () => {
    const result = runAsp(['agent', '--help'], { expectError: true })
    const output = result.stdout + result.stderr

    // The agent subcommand should be recognized and show help
    expect(output).toMatch(/agent/i)
    // Should mention scope-ref or ScopeRef
    expect(output).toMatch(/scope.?ref|agent:/i)
  })

  test('asp agent "agent:alice" query --dry-run shows invocation', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'What is your name?',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // --dry-run should not spawn, just print invocation details
    expect(output).toMatch(/dry.?run|invocation|command|resolve/i)
  })

  test('asp agent "agent:alice" heartbeat --dry-run works without prompt', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'heartbeat',
        '--agent-root',
        agentRoot,
        '--frontend',
        'agent-sdk',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // heartbeat mode should not require a prompt
    expect(output).not.toMatch(/prompt.*required/i)
  })

  test('asp agent "agent:alice" query requires a prompt', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        '--agent-root',
        agentRoot,
        '--frontend',
        'agent-sdk',
        '--dry-run',
      ],
      { expectError: true }
    )

    // query mode without a prompt should fail with a descriptive error
    const output = result.stdout + result.stderr
    expect(output).toMatch(/prompt.*required|missing.*prompt/i)
  })

  test('--print-command shows shell command', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--print-command',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    expect(output).toMatch(/print|command|claude|codex/i)
  })
})

// ===================================================================
// T-00866: asp agent resolve <scope-ref>
// ===================================================================
describe('asp agent resolve (T-00866)', () => {
  test('asp agent resolve shows resolved bundle', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      ['agent', 'resolve', 'agent:alice', '--agent-root', agentRoot, '--mode', 'query'],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // Should print resolution output, not execute
    expect(output).toMatch(/resolve|bundle|placement|instructions|spaces/i)
  })

  test('asp agent resolve --json outputs JSON', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      ['agent', 'resolve', 'agent:alice', '--agent-root', agentRoot, '--mode', 'query', '--json'],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // Should contain JSON output
    expect(output).toMatch(/\{|json|resolve/i)
  })

  test('asp agent resolve with project context', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'resolve',
        'agent:alice:project:demo',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--mode',
        'task',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    expect(output).toMatch(/resolve|bundle|placement/i)
  })
})

// ===================================================================
// T-00867: Existing CLI compatibility
// ===================================================================
describe('existing CLI compatibility (T-00867)', () => {
  test('asp --help still lists existing commands', () => {
    const result = runAsp(['--help'])
    const output = result.stdout + result.stderr

    // All existing commands should still be listed
    expect(output).toMatch(/run/)
    expect(output).toMatch(/install/)
    expect(output).toMatch(/build/)
    expect(output).toMatch(/explain/)
  })

  test('asp run --help still works', () => {
    const result = runAsp(['run', '--help'], { expectError: true })
    const output = result.stdout + result.stderr

    // run command should show its own help
    expect(output).toMatch(/run|target|space/i)
  })

  test('asp install --help still works', () => {
    const result = runAsp(['install', '--help'], { expectError: true })
    const output = result.stdout + result.stderr

    expect(output).toMatch(/install/i)
  })

  test('asp --help includes new agent subcommand', () => {
    const result = runAsp(['--help'])
    const output = result.stdout + result.stderr

    // The new agent command should appear in top-level help
    expect(output).toMatch(/agent/i)
  })
})

// ===================================================================
// T-00868: Bundle selection flags
// ===================================================================
describe('bundle selection flags (T-00868)', () => {
  test('--bundle agent-default is accepted', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--bundle',
        'agent-default',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // Should recognize --bundle flag
    expect(output).not.toMatch(/unknown.*option.*bundle/i)
  })

  test('--agent-target selects named agent target', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--agent-target',
        'review',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    expect(output).not.toMatch(/unknown.*option.*agent-target/i)
  })

  test('--project-target requires --project-root', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--project-target',
        'default',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // Should fail because --project-root is missing
    expect(output).toMatch(/project.?root.*required|missing.*project.?root/i)
  })

  test('--project-target with --project-root is accepted', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice:project:demo',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--project-target',
        'default',
        '--frontend',
        'claude-code',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    expect(output).not.toMatch(/unknown.*option.*project-target/i)
  })

  test('--compose accepts repeated space refs', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--compose',
        'space:agent:private-ops',
        '--compose',
        'space:agent:task-worker',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    expect(output).not.toMatch(/unknown.*option.*compose/i)
  })

  test('defaults to agent-default when no bundle selector provided', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // Should work without any bundle selector (defaults to agent-default)
    expect(output).toMatch(/dry.?run|invocation|agent-default|resolve/i)
  })
})

// ===================================================================
// T-00872: hostSessionId defect regression
// Defect: CLI layer passed cpSessionId: '' and legacy shim fields
// (aspHome, spec, cwd) instead of hostSessionId to both
// buildProcessInvocationSpec and runTurnNonInteractive.
// ===================================================================
describe('hostSessionId regression (T-00872)', () => {
  test('--host-session-id propagates as AGENT_HOST_SESSION_ID in env', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--host-session-id',
        'regression-hsid-42',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    // Parse the JSON output — must contain the correct env var
    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.env.AGENT_HOST_SESSION_ID).toBe('regression-hsid-42')
  })

  test('no AGENT_HOST_SESSION_ID when --host-session-id omitted (no correlation)', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    // Without --host-session-id, no correlation block is built, so no env var
    expect(parsed.spec.env.AGENT_HOST_SESSION_ID).toBeUndefined()
  })

  test('source code has no cpSessionId in agent command handler', () => {
    // Static regression: ensure the defect pattern never returns.
    // The agent command handler must use hostSessionId, not cpSessionId.
    const source = readFileSync(
      join(import.meta.dirname, '..', 'commands', 'agent', 'index.ts'),
      'utf8'
    )
    const lines = source.split('\n')
    const cpSessionIdLines = lines.filter(
      (line) => line.includes('cpSessionId') && !line.trimStart().startsWith('//')
    )
    expect(cpSessionIdLines).toEqual([])
  })
})

// ===================================================================
// T-00874: Full CLI argv from buildPlacementInvocationSpec
// Defect: buildPlacementInvocationSpec produced stub argv: [frontend].
// Now uses harness adapter for full binary path, model, args, env.
// ===================================================================
describe('placement invocation produces full argv (T-00874)', () => {
  test('claude-code argv contains real binary path and --model flag', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--host-session-id',
        'argv-test-1',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    // argv must have more than just [frontend] — should have real binary + flags
    expect(parsed.spec.argv.length).toBeGreaterThan(1)
    // argv[0] should be a real binary path, not just "claude-code"
    expect(parsed.spec.argv[0]).not.toBe('claude-code')
    // Must include --model flag
    expect(parsed.spec.argv).toContain('--model')
  })

  test('codex-cli argv contains exec subcommand and --model flag', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'codex-cli',
        '--host-session-id',
        'argv-test-2',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.argv.length).toBeGreaterThan(1)
    expect(parsed.spec.argv).toContain('exec')
    expect(parsed.spec.argv).toContain('--model')
  })

  test('displayCommand is present and non-empty', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.displayCommand).toBeDefined()
    expect(typeof parsed.spec.displayCommand).toBe('string')
    expect(parsed.spec.displayCommand.length).toBeGreaterThan(0)
  })

  test('ASP_HOME is in env', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.env.ASP_HOME).toBeDefined()
    expect(typeof parsed.spec.env.ASP_HOME).toBe('string')
  })

  test('adapter env vars present (ASP_PLUGIN_ROOT for claude-code)', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    // claude-code adapter sets ASP_PLUGIN_ROOT
    expect(parsed.spec.env.ASP_PLUGIN_ROOT).toBeDefined()
  })

  test('unsupported model throws via placement path', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--model',
        'not-a-real-model',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    // Should fail with model not supported error
    expect(result.exitCode).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toMatch(/[Mm]odel not supported/)
  })
})

// ===================================================================
// T-00875: Prompt passed through to CLI argv
// Defect: prompt was not included in spawned CLI argv.
// Fix plumbs prompt through adapter.buildRunArgs() runOptions.
// ===================================================================
describe('prompt in argv (T-00875)', () => {
  test('claude-code argv contains -p flag with prompt text', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Reply with exactly: CLIPASS',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    // Must include -p flag followed by the prompt text
    const pIdx = parsed.spec.argv.indexOf('-p')
    expect(pIdx).toBeGreaterThan(-1)
    expect(parsed.spec.argv[pIdx + 1]).toBe('Reply with exactly: CLIPASS')
  })

  test('codex-cli argv contains prompt text', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Reply with exactly: CLIPASS',
        '--agent-root',
        agentRoot,
        '--frontend',
        'codex-cli',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    // Codex puts the prompt as a positional arg
    expect(parsed.spec.argv).toContain('Reply with exactly: CLIPASS')
  })

  test('no prompt in argv when prompt not provided (heartbeat)', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'heartbeat',
        '--agent-root',
        agentRoot,
        '--frontend',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    // heartbeat has no prompt — argv should NOT contain -p
    expect(parsed.spec.argv).not.toContain('-p')
  })
})
