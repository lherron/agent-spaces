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
import { cp, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type TestFn = () => unknown | Promise<unknown>

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
const SAMPLE_FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'integration-tests',
  'fixtures'
)
const CLAUDE_SHIM_DIR = join(SAMPLE_FIXTURES_DIR, 'claude-shim')
const CLI_TEST_TIMEOUT_MS = 60000

function cliTest(name: string, fn: TestFn): void
function cliTest(name: string, fn: TestFn, timeout: number): void
function cliTest(name: string, options: { timeout?: number }, fn: TestFn): void
function cliTest(
  name: string,
  optionsOrFn: { timeout?: number } | TestFn,
  maybeFnOrTimeout?: TestFn | number
): void {
  if (typeof optionsOrFn === 'function') {
    const timeout = typeof maybeFnOrTimeout === 'number' ? maybeFnOrTimeout : CLI_TEST_TIMEOUT_MS
    test(name, optionsOrFn, timeout)
    return
  }

  if (typeof maybeFnOrTimeout === 'function') {
    const timeout = optionsOrFn.timeout ?? CLI_TEST_TIMEOUT_MS
    test(name, maybeFnOrTimeout, timeout)
    return
  }

  throw new TypeError(`Invalid cliTest arguments for ${name}`)
}

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
      timeout: CLI_TEST_TIMEOUT_MS,
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
  cliTest('asp agent --help shows agent subcommand', () => {
    const result = runAsp(['agent', '--help'], { expectError: true })
    const output = result.stdout + result.stderr

    // The agent subcommand should be recognized and show help
    expect(output).toMatch(/agent/i)
    // Should mention scope in usage
    expect(output).toMatch(/scope|agent:/i)
  })

  cliTest('asp agent "agent:alice" query --dry-run shows invocation', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'What is your name?',
        '--agent-root',
        agentRoot,
        '--harness',
        'claude-code',
        '--dry-run',
      ],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // --dry-run should not spawn, just print invocation details
    expect(output).toMatch(/dry.?run|invocation|command|resolve/i)
  })

  cliTest(
    'asp agent "agent:alice" heartbeat --dry-run works without prompt',
    { timeout: CLI_TEST_TIMEOUT_MS },
    () => {
      const agentRoot = resolveAgentRoot()

      const result = runAsp(
        [
          'agent',
          'agent:alice',
          'heartbeat',
          '--agent-root',
          agentRoot,
          '--harness',
          'agent-sdk',
          '--dry-run',
        ],
        { expectError: true }
      )

      const output = result.stdout + result.stderr
      // heartbeat mode should not require a prompt
      expect(output).not.toMatch(/prompt.*required/i)
    }
  )

  cliTest('asp agent "agent:alice" query requires a prompt', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        '--agent-root',
        agentRoot,
        '--harness',
        'agent-sdk',
        '--dry-run',
      ],
      { expectError: true }
    )

    // query mode without a prompt should fail with a descriptive error
    const output = result.stdout + result.stderr
    expect(output).toMatch(/prompt.*required|missing.*prompt/i)
  })

  cliTest('--print-command shows shell command', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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
// T-01092: pi-sdk provider mapping
// ===================================================================
describe('pi-sdk provider mapping (T-01092)', () => {
  cliTest(
    'normalizeHarness delegates provider/frontend resolution to shared catalog helpers',
    () => {
      const source = readFileSync(
        join(import.meta.dirname, '..', 'commands', 'agent', 'index.ts'),
        'utf8'
      )
      const fn = source.match(/function normalizeHarness[\s\S]*?^}/m)?.[0]

      expect(fn).toBeDefined()
      expect(fn).toMatch(/const frontend = resolveHarnessFrontendName\(input\)/)
      expect(fn).toMatch(/const provider = resolveHarnessProvider\(input\)/)
    }
  )
})

// ===================================================================
// T-00866: asp agent resolve <scope-ref>
// ===================================================================
describe('asp agent resolve (T-00866)', () => {
  cliTest('asp agent resolve shows resolved bundle', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(['agent', 'agent:alice', 'resolve', '--agent-root', agentRoot], {
      expectError: true,
    })

    const output = result.stdout + result.stderr
    // Should print resolution output, not execute
    expect(output).toMatch(/resolve|bundle|placement|instructions|spaces/i)
  })

  cliTest('asp agent resolve --json outputs JSON', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      ['agent', 'agent:alice', 'resolve', '--agent-root', agentRoot, '--json'],
      { expectError: true }
    )

    const output = result.stdout + result.stderr
    // Should contain JSON output
    expect(output).toMatch(/\{|json|resolve/i)
  })

  cliTest('asp agent resolve with project context', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice:project:demo',
        'resolve',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
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
  cliTest('asp --help still lists existing commands', () => {
    const result = runAsp(['--help'])
    const output = result.stdout + result.stderr

    // All existing commands should still be listed
    expect(output).toMatch(/run/)
    expect(output).toMatch(/install/)
    expect(output).toMatch(/build/)
    expect(output).toMatch(/explain/)
  })

  cliTest('asp run --help still works', () => {
    const result = runAsp(['run', '--help'], { expectError: true })
    const output = result.stdout + result.stderr

    // run command should show its own help
    expect(output).toMatch(/run|target|space/i)
  })

  cliTest('asp install --help still works', () => {
    const result = runAsp(['install', '--help'], { expectError: true })
    const output = result.stdout + result.stderr

    expect(output).toMatch(/install/i)
  })

  cliTest('asp --help includes new agent subcommand', () => {
    const result = runAsp(['--help'])
    const output = result.stdout + result.stderr

    // The new agent command should appear in top-level help
    expect(output).toMatch(/agent/i)
  })

  cliTest('asp diff --json reads asp-lock.json instead of the project directory', async () => {
    const aspHome = await mkdtemp(join(tmpdir(), 'asp-diff-home-'))
    try {
      const result = runAsp(
        [
          'diff',
          '--project',
          join(SAMPLE_FIXTURES_DIR, 'sample-project'),
          '--registry',
          join(SAMPLE_FIXTURES_DIR, 'sample-registry'),
          '--target',
          'dev',
          '--json',
        ],
        { env: { ASP_HOME: aspHome } }
      )

      const output = result.stdout + result.stderr
      expect(output).not.toContain("Dist-tag 'stable' not found for space 'frontend'")
      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain('EISDIR')
      expect(JSON.parse(result.stdout)).toMatchObject({
        diffs: [
          {
            target: 'dev',
            changes: expect.arrayContaining([
              expect.objectContaining({ spaceId: 'base', type: 'added' }),
            ]),
          },
        ],
      })
    } finally {
      await rm(aspHome, { recursive: true, force: true })
    }
  })

  cliTest('asp diff --json resolves copied project fixtures from explicit registry', async () => {
    const aspHome = await mkdtemp(join(tmpdir(), 'asp-diff-copy-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'asp-diff-copy-project-'))
    try {
      // T-05831 regression guard: drain worktrees place the project outside the
      // repo fixture tree, so --registry must remain the shared-space source.
      await cp(join(SAMPLE_FIXTURES_DIR, 'sample-project'), projectDir, { recursive: true })

      const result = runAsp(
        [
          'diff',
          '--project',
          projectDir,
          '--registry',
          join(SAMPLE_FIXTURES_DIR, 'sample-registry'),
          '--target',
          'dev',
          '--json',
        ],
        { env: { ASP_HOME: aspHome } }
      )

      const output = result.stdout + result.stderr
      expect(output).not.toContain("Dist-tag 'stable' not found for space 'frontend'")
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        diffs: [
          {
            target: 'dev',
            changes: expect.arrayContaining([
              expect.objectContaining({ spaceId: 'base', type: 'added' }),
              expect.objectContaining({ spaceId: 'frontend', type: 'added' }),
            ]),
          },
        ],
      })
    } finally {
      await rm(aspHome, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  cliTest('asp run resolves @dev shared spaces from agents root in a clean ASP_HOME', async () => {
    const aspHome = await mkdtemp(join(tmpdir(), 'asp-run-agents-root-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'asp-run-agents-root-project-'))
    const agentsRoot = await mkdtemp(join(tmpdir(), 'asp-run-agents-root-'))
    try {
      await mkdir(join(projectDir), { recursive: true })
      await writeFile(
        join(projectDir, 'asp-targets.toml'),
        [
          'schema = 1',
          '',
          '[targets.dev]',
          'description = "Clean home agents-root dev target"',
          'compose = ["space:base@dev"]',
          '',
        ].join('\n')
      )
      await mkdir(join(agentsRoot, 'spaces'), { recursive: true })
      await cp(
        join(SAMPLE_FIXTURES_DIR, 'sample-registry', 'spaces', 'base'),
        join(agentsRoot, 'spaces', 'base'),
        {
          recursive: true,
        }
      )

      const env = {
        ASP_HOME: aspHome,
        ASP_AGENTS_ROOT: agentsRoot,
        PATH: `${CLAUDE_SHIM_DIR}:${process.env.PATH ?? ''}`,
      }

      const install = runAsp(['install', '--update', '--no-fetch', '--project', projectDir], {
        env,
      })
      expect(install.exitCode).toBe(0)

      const result = runAsp(['run', 'dev', '--dry-run', '--project', projectDir], {
        env,
      })
      const output = result.stdout + result.stderr

      expect(result.exitCode).toBe(0)
      expect(output).toContain('plugins/000-base')
      expect(output).not.toContain(`${aspHome}/repo`)
    } finally {
      await rm(aspHome, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
      await rm(agentsRoot, { recursive: true, force: true })
    }
  })

  cliTest('asp doctor rejects spaces as an agent directory name', async () => {
    const aspHome = await mkdtemp(join(tmpdir(), 'asp-doctor-spaces-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'asp-doctor-spaces-project-'))
    try {
      await writeFile(
        join(projectDir, 'asp-targets.toml'),
        'schema = 1\nagents-root = "./agents"\n'
      )
      await mkdir(join(projectDir, 'agents', 'spaces'), { recursive: true })
      await writeFile(
        join(projectDir, 'agents', 'spaces', 'agent-profile.toml'),
        'name = "spaces"\n'
      )

      const result = runAsp(['doctor', '--project', projectDir, '--asp-home', aspHome, '--json'], {
        expectError: true,
      })
      const output = result.stdout + result.stderr
      const parsed = JSON.parse(result.stdout) as {
        checks: Array<{ name: string; status: string; message: string }>
      }

      expect(result.exitCode).toBe(1)
      expect(output).toContain('agent_reserved_name')
      expect(parsed.checks).toContainEqual(
        expect.objectContaining({
          name: 'agent_reserved_name',
          status: 'error',
        })
      )
    } finally {
      await rm(aspHome, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})

// ===================================================================
// T-00868: Bundle selection flags
// ===================================================================
describe('bundle selection flags (T-00868)', () => {
  cliTest('--compose accepts repeated space refs', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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
})

// ===================================================================
// T-00872: hostSessionId defect regression
// Defect: CLI layer passed cpSessionId: '' and legacy shim fields
// (aspHome, spec, cwd) instead of hostSessionId to both
// buildProcessInvocationSpec and runTurnNonInteractive.
// ===================================================================
describe('hostSessionId regression (T-00872)', () => {
  cliTest('--host-session-id propagates as AGENT_HOST_SESSION_ID in env', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('no AGENT_HOST_SESSION_ID when --host-session-id omitted (no correlation)', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('source code has no cpSessionId in agent command handler', () => {
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
// T-00892: CLI auto-populates correlation from positional ScopeRef
//
// Defect: buildPlacement() only creates placement.correlation when
// --host-session-id or --lane-ref is provided. The positional scopeRef
// is always available but not used as a baseline. Default lane is 'main'.
// Result: dry-run invocations omit AGENT_SCOPE_REF and AGENT_LANE_REF
// unless optional flags are passed.
//
// PASS CONDITIONS:
// 1. Dry-run without --host-session-id / --lane-ref still emits
//    AGENT_SCOPE_REF (from positional scopeRef) and AGENT_LANE_REF ('main').
// 2. --lane-ref overrides the default lane.
// 3. --host-session-id is propagated into AGENT_HOST_SESSION_ID.
// ===================================================================
describe('CLI default correlation from positional ScopeRef (T-00892)', () => {
  cliTest(
    'baseline dry-run auto-populates AGENT_SCOPE_REF and AGENT_LANE_REF',
    () => {
      // RED: Currently buildPlacement skips correlation entirely when
      // --host-session-id and --lane-ref are both absent (lines 284-291).
      // scopeRef "agent:alice" is parsed but not used for correlation baseline.
      const agentRoot = resolveAgentRoot()

      const result = runAsp(
        [
          'agent',
          'agent:alice',
          'query',
          'Hello',
          '--agent-root',
          agentRoot,
          '--harness',
          'claude-code',
          '--dry-run',
          '--json',
        ],
        { expectError: true }
      )

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      // AGENT_SCOPE_REF should be the positional scopeRef
      expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice')
      // AGENT_LANE_REF should default to 'main'
      expect(parsed.spec.env.AGENT_LANE_REF).toBe('main')
    },
    10_000
  )

  cliTest('--lane-ref overrides default lane', () => {
    // RED: Currently --lane-ref alone triggers correlation, but this test
    // verifies the override path works correctly with the new baseline.
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
        'claude-code',
        '--lane-ref',
        'deploy',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice')
    expect(parsed.spec.env.AGENT_LANE_REF).toBe('deploy')
  })

  cliTest('--host-session-id sets AGENT_HOST_SESSION_ID alongside scope/lane', () => {
    // GREEN: --host-session-id triggers correlation in current code, so
    // scope/lane already get set. This is the backward compat baseline.
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
        'claude-code',
        '--host-session-id',
        'hs-corr-test',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.env.AGENT_HOST_SESSION_ID).toBe('hs-corr-test')
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice')
    expect(parsed.spec.env.AGENT_LANE_REF).toBe('main')
  })

  cliTest('compound ScopeRef propagates full ref', () => {
    // RED: Same defect — no correlation without explicit flags.
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
        '--harness',
        'claude-code',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice:project:demo:task:primary')
    expect(parsed.spec.env.AGENT_LANE_REF).toBe('main')
  })
})

// ===================================================================
// T-00874: Full CLI argv from buildPlacementInvocationSpec
// Defect: buildPlacementInvocationSpec produced stub argv: [frontend].
// Now uses harness adapter for full binary path, model, args, env.
// ===================================================================
describe('placement invocation produces full argv (T-00874)', () => {
  cliTest('claude-code argv contains real binary path and --model flag', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('codex-cli argv contains app-server subcommand and structured model descriptor', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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
    expect(parsed.spec.argv).toContain('--enable')
    expect(parsed.spec.argv).toContain('goals')
    expect(parsed.spec.argv).toContain('app-server')
    expect(parsed.spec.argv).not.toContain('exec')
    expect(parsed.spec.argv).not.toContain('--model')
    expect(parsed.spec.codexAppServer).toMatchObject({
      model: 'gpt-5.6-terra',
      approvalPolicy: 'never',
      featureFlags: ['goals'],
    })
    expect(parsed.spec.codexAppServer?.prompt).toContain('Hello')
  })

  cliTest('displayCommand is present and non-empty', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('ASP_HOME is in env', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('adapter env vars present (ASP_PLUGIN_ROOT for claude-code)', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('unsupported model throws via placement path', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
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
  cliTest('claude-code argv contains -p flag with prompt text', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Reply with exactly: CLIPASS',
        '--agent-root',
        agentRoot,
        '--harness',
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

  cliTest('codex-cli descriptor contains prompt text', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Reply with exactly: CLIPASS',
        '--agent-root',
        agentRoot,
        '--harness',
        'codex-cli',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.argv).not.toContain('Reply with exactly: CLIPASS')
    expect(parsed.spec.codexAppServer?.prompt).toContain('Reply with exactly: CLIPASS')
  })

  cliTest(
    'no prompt in argv when prompt not provided (heartbeat)',
    { timeout: CLI_TEST_TIMEOUT_MS },
    () => {
      const agentRoot = resolveAgentRoot()

      const result = runAsp(
        [
          'agent',
          'agent:alice',
          'heartbeat',
          '--agent-root',
          agentRoot,
          '--harness',
          'claude-code',
          '--dry-run',
          '--json',
        ],
        { expectError: true }
      )

      const parsed = JSON.parse(result.stdout)
      // heartbeat has no prompt — argv should NOT contain -p
      expect(parsed.spec.argv).not.toContain('-p')
    }
  )
})

// ===================================================================
// T-00878: gpt-5.5 model support
// ===================================================================
describe('gpt-5.5 model support (T-00878)', () => {
  cliTest('codex-cli accepts gpt-5.5 model', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
        'codex-cli',
        '--model',
        'gpt-5.5',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    // Should succeed (exit 0) — gpt-5.5 is a valid model
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.argv).not.toContain('--model')
    expect(parsed.spec.codexAppServer?.model).toBe('gpt-5.5')
  })

  cliTest('codex-cli default model is GPT-5.6 Terra in dry-run', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Hello',
        '--agent-root',
        agentRoot,
        '--harness',
        'codex-cli',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.argv).not.toContain('--model')
    expect(parsed.spec.codexAppServer?.model).toBe('gpt-5.6-terra')
  })
})

// ===================================================================
// T-00879: pi-sdk placement path uses unified materialization
// ===================================================================
describe('pi-sdk placement path (T-00879)', () => {
  cliTest('runPlacementTurnNonInteractive uses unified materializeSpec pipeline', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'agent-spaces', 'src', 'run-placement-turn.ts'),
      'utf8'
    )
    // Scope to the runPlacementTurnNonInteractive function via its declaration to
    // EOF (it is the only top-level function in run-placement-turn.ts) instead of
    // a greedy whole-body regex, so the unified-pipeline wiring assertion stays
    // scoped without pinning the whole body.
    const declStart = source.indexOf('export async function runPlacementTurnNonInteractive')
    const runFn = declStart === -1 ? undefined : source.slice(declStart)
    expect(runFn).toBeDefined()
    // Must use resolvePlacementContext + materializeSpec (unified pipeline)
    expect(runFn).toMatch(/resolvePlacementContext\(/)
    expect(runFn).toMatch(/materializeSpec\(/)
    // Pi-sdk should load bundle from materialized output (composeTarget produces bundle.json)
    expect(runFn).toMatch(/loadPiSdkBundle\(materialized/)
  })
})

// ===================================================================
// T-00882: codex-cli placement auth propagation
// Defect: placement path skipped composeTarget(), so CODEX_HOME lacked auth.json.
// ===================================================================
describe('codex-cli placement auth propagation (T-00882)', () => {
  cliTest('dry-run links ~/.codex/auth.json into CODEX_HOME', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asp-codex-auth-'))
    const agentRoot = join(tempDir, 'agent-root')
    const fakeHome = join(tempDir, 'home')
    const fakeAuthPath = join(fakeHome, '.codex', 'auth.json')
    const codexShimDir = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'integration-tests',
      'fixtures',
      'codex-shim'
    )

    await cp(resolveAgentRoot(), agentRoot, { recursive: true })
    await mkdir(join(fakeHome, '.codex'), { recursive: true })
    await writeFile(fakeAuthPath, '{"access_token":"test-token"}\n')

    const result = runAsp(
      [
        'agent',
        'agent:alice',
        'query',
        'Reply with exactly: CODEX_PASS',
        '--agent-root',
        agentRoot,
        '--harness',
        'codex-cli',
        '--interaction',
        'headless',
        '--io',
        'pipes',
        '--dry-run',
        '--json',
      ],
      {
        expectError: true,
        env: {
          HOME: fakeHome,
          PATH: `${codexShimDir}:${process.env.PATH ?? ''}`,
          ASP_HOME: join(tempDir, 'asp-home'),
        },
      }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    const codexHome = parsed.spec.env.CODEX_HOME
    expect(typeof codexHome).toBe('string')

    const linkedAuthPath = join(codexHome, 'auth.json')
    const stats = await lstat(linkedAuthPath)
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await readlink(linkedAuthPath)).toBe(fakeAuthPath)
  })
})
