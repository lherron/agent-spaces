/**
 * RED tests for T-00894: CLI accepts ScopeHandle shorthand in `asp agent`.
 *
 * The `asp agent` and `asp agent resolve` commands currently only accept
 * canonical ScopeRef (agent:alice:project:demo). This test verifies that
 * shorthand ScopeHandle (alice@demo) is also accepted and produces
 * identical canonical output.
 *
 * PASS CONDITIONS:
 * 1. `asp agent resolve alice@demo ...` resolves identically to `agent:alice:project:demo`.
 * 2. `asp agent alice@demo query ... --dry-run` produces canonical scopeRef in correlation.
 * 3. SessionHandle ~lane suffix populates correlation.sessionRef.laneRef.
 * 4. Canonical ScopeRef still works unchanged (backward compat).
 * 5. Invalid shorthand (@demo, empty, etc.) produces clear errors.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

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
// T-00894: ScopeHandle acceptance in resolve path
// ===================================================================
describe('ScopeHandle in asp agent resolve (T-00894)', () => {
  test('alice@demo resolves same as agent:alice:project:demo', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    // Run with shorthand
    const shorthand = runAsp(
      [
        'agent',
        'alice@demo',
        'resolve',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--json',
      ],
      { expectError: true }
    )

    // Run with canonical
    const canonical = runAsp(
      [
        'agent',
        'agent:alice:project:demo',
        'resolve',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--json',
      ],
      { expectError: true }
    )

    // Both should succeed
    expect(shorthand.exitCode).toBe(0)
    expect(canonical.exitCode).toBe(0)

    // Placement scopeRef should be canonical in both
    const shorthandParsed = JSON.parse(shorthand.stdout)
    const canonicalParsed = JSON.parse(canonical.stdout)
    expect(shorthandParsed.placement.correlation.sessionRef.scopeRef).toBe(
      'agent:alice:project:demo'
    )
    expect(shorthandParsed.placement.correlation.sessionRef.scopeRef).toBe(
      canonicalParsed.placement.correlation.sessionRef.scopeRef
    )
  })

  test('alice@demo:t1/reviewer resolves as full task-role scope', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'alice@demo:t1/reviewer',
        'resolve',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.placement.correlation.sessionRef.scopeRef).toBe(
      'agent:alice:project:demo:task:t1:role:reviewer'
    )
  })
})

// ===================================================================
// T-00894: ScopeHandle acceptance in execute path
// ===================================================================
describe('ScopeHandle in asp agent execute (T-00894)', () => {
  test('alice@demo query --dry-run works and uses canonical scopeRef', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'alice@demo',
        'query',
        'test prompt',
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
    // Correlation scopeRef must be canonical form
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice:project:demo')
  })

  test('correlation sessionRef.scopeRef is canonical even with shorthand input', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'alice',
        'query',
        'test',
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
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice')
  })
})

// ===================================================================
// T-00894: SessionHandle ~lane in CLI
// ===================================================================
describe('SessionHandle ~lane in CLI (T-00894)', () => {
  test('alice@demo~repair sets laneRef to lane:repair', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'alice@demo~repair',
        'resolve',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.placement.correlation.sessionRef.scopeRef).toBe('agent:alice:project:demo')
    expect(parsed.placement.correlation.sessionRef.laneRef).toBe('lane:repair')
  })

  test('alice@demo~main uses main lane (no lane: prefix)', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'alice@demo~main',
        'resolve',
        '--agent-root',
        agentRoot,
        '--project-root',
        projectRoot,
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.placement.correlation.sessionRef.scopeRef).toBe('agent:alice:project:demo')
    expect(parsed.placement.correlation.sessionRef.laneRef).toBe('main')
  })

  test('~lane in execute path sets AGENT_LANE_REF', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'alice~deploy',
        'query',
        'test',
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
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice')
    expect(parsed.spec.env.AGENT_LANE_REF).toBe('deploy')
  })

  test('--lane-ref flag still works without ~lane suffix', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      [
        'agent',
        'alice@demo',
        'query',
        'test',
        '--agent-root',
        agentRoot,
        '--harness',
        'claude-code',
        '--lane-ref',
        'hotfix',
        '--dry-run',
        '--json',
      ],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.spec.env.AGENT_LANE_REF).toBe('hotfix')
  })
})

// ===================================================================
// T-00894: Backward compatibility — canonical ScopeRef unchanged
// ===================================================================
describe('backward compat: canonical ScopeRef still works (T-00894)', () => {
  test('agent:alice still works in resolve', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(
      ['agent', 'agent:alice', 'resolve', '--agent-root', agentRoot, '--json'],
      { expectError: true }
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.placement.correlation.sessionRef.scopeRef).toBe('agent:alice')
  })

  test('agent:alice:project:demo:task:t1:role:reviewer still works in execute', () => {
    const agentRoot = resolveAgentRoot()
    const projectRoot = resolveProjectRoot()

    const result = runAsp(
      [
        'agent',
        'agent:alice:project:demo:task:t1:role:reviewer',
        'query',
        'test',
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
    expect(parsed.spec.env.AGENT_SCOPE_REF).toBe('agent:alice:project:demo:task:t1:role:reviewer')
  })
})

// ===================================================================
// T-00894: Error cases — invalid shorthand
// ===================================================================
describe('invalid ScopeHandle errors (T-00894)', () => {
  test('@demo produces clear error', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(['agent', '@demo', 'resolve', '--agent-root', agentRoot], {
      expectError: true,
    })

    expect(result.exitCode).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toMatch(/[Ii]nvalid|error/i)
  })

  test('empty scope-ref produces clear error', () => {
    const agentRoot = resolveAgentRoot()

    // Pass -- to prevent "" being swallowed by commander
    const result = runAsp(['agent', '', 'resolve', '--agent-root', agentRoot], {
      expectError: true,
    })

    expect(result.exitCode).not.toBe(0)
  })

  test('alice@ (trailing @) produces clear error', () => {
    const agentRoot = resolveAgentRoot()

    const result = runAsp(['agent', 'alice@', 'resolve', '--agent-root', agentRoot], {
      expectError: true,
    })

    expect(result.exitCode).not.toBe(0)
    const output = result.stdout + result.stderr
    expect(output).toMatch(/[Ii]nvalid|error/i)
  })
})
