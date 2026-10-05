/**
 * Shared harness for tests that drive the real `asp` binary.
 */

import { test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const CLI_TEST_TIMEOUT_MS = 60000

// Resolve fixture roots directly — CLI tests can't use workspace package subpath imports
const V2_FIXTURES_DIR = join(REPO_ROOT, 'core', 'config', 'src', '__fixtures__', 'v2')
export const AGENT_ROOT = join(V2_FIXTURES_DIR, 'agent-root')
export const PROJECT_ROOT = join(V2_FIXTURES_DIR, 'project-root')
export const SAMPLE_FIXTURES_DIR = join(REPO_ROOT, 'integration-tests', 'fixtures')

/** A test that spawns the CLI, with a timeout sized for a cold `bun run`. */
export function cliTest(
  name: string,
  fn: Parameters<typeof test>[1],
  timeout = CLI_TEST_TIMEOUT_MS
): void {
  test(name, fn, timeout)
}

export type AspResult = { stdout: string; stderr: string; exitCode: number }

/** Run the asp CLI; a nonzero exit is returned, not thrown. */
export function runAsp(args: string[], env: Record<string, string> = {}): AspResult {
  try {
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: CLI_TEST_TIMEOUT_MS,
      env: { ...process.env, ...env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err) {
    const failure = err as { stdout?: unknown; stderr?: unknown; status?: number | null }
    return {
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? '',
      exitCode: failure.status ?? 1,
    }
  }
}

export type AgentInvocation = {
  scopeRef?: string
  mode?: 'query' | 'heartbeat' | 'resolve'
  prompt?: string
  harness?: 'claude' | 'codex'
  /** Adds --project-root with the v2 project fixture. */
  withProjectRoot?: boolean
  flags?: string[]
}

/** argv for `asp agent <scopeRef> <mode> [prompt]` against the v2 agent fixture. */
export function agentArgs({
  scopeRef = 'agent:alice',
  mode = 'query',
  prompt,
  harness,
  withProjectRoot = false,
  flags = [],
}: AgentInvocation): string[] {
  return [
    'agent',
    scopeRef,
    mode,
    ...(prompt !== undefined ? [prompt] : []),
    '--agent-root',
    AGENT_ROOT,
    ...(withProjectRoot ? ['--project-root', PROJECT_ROOT] : []),
    ...(harness !== undefined ? ['--harness', harness] : []),
    ...flags,
  ]
}

/** The invocation spec fields these tests read from `--dry-run --json`. */
export type DryRunSpec = {
  argv: string[]
  env: Record<string, string | undefined>
  displayCommand?: string
  codexAppServer?: { model?: string; prompt?: string; [key: string]: unknown }
}

/** `asp agent ... --dry-run --json` and its parsed invocation spec. */
export function agentDryRunSpec(invocation: AgentInvocation): {
  result: AspResult
  spec: DryRunSpec
} {
  const result = runAsp(
    agentArgs({
      harness: 'claude',
      ...invocation,
      flags: [...(invocation.flags ?? []), '--dry-run', '--json'],
    })
  )
  return { result, spec: (JSON.parse(result.stdout) as { spec: DryRunSpec }).spec }
}
