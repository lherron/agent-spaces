/**
 * `asp agent <scope-ref> <mode>` command surface: mode verbs, prompt
 * requirements, resolve output and bundle selection flags.
 *
 * wrkq: T-00865 (modes), T-00866 (resolve), T-00868 (bundle selection),
 *       T-01092 (foreground selection), T-00872 (hostSessionId handler)
 */

import { describe, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { agentArgs, cliTest, runAsp } from './asp-cli'

const AGENT_COMMAND_SOURCE = join(import.meta.dirname, '..', 'commands', 'agent', 'index.ts')

/** Combined stdout + stderr of an `asp agent` invocation. */
function agentOutput(...args: Parameters<typeof agentArgs>): string {
  const result = runAsp(agentArgs(...args))
  return result.stdout + result.stderr
}

describe('asp agent <scope-ref> <mode> (T-00865)', () => {
  cliTest('asp agent --help shows agent subcommand', () => {
    const result = runAsp(['agent', '--help'])
    const output = result.stdout + result.stderr

    // The agent subcommand should be recognized and show help
    expect(output).toMatch(/agent/i)
    // Should mention scope in usage
    expect(output).toMatch(/scope|agent:/i)
  })

  cliTest('asp agent "agent:alice" query --dry-run shows invocation', () => {
    const output = agentOutput({
      prompt: 'What is your name?',
      harness: 'claude',
      flags: ['--dry-run'],
    })

    // --dry-run should not spawn, just print invocation details
    expect(output).toMatch(/dry.?run|invocation|command|resolve/i)
  })

  cliTest('asp agent "agent:alice" heartbeat --dry-run works without prompt', () => {
    const result = runAsp(agentArgs({ mode: 'heartbeat', harness: 'claude', flags: ['--dry-run'] }))

    // heartbeat mode should not require a prompt
    expect(result.exitCode).toBe(0)
  })

  cliTest('asp agent "agent:alice" query requires a prompt', () => {
    const output = agentOutput({ harness: 'claude', flags: ['--dry-run'] })

    // query mode without a prompt should fail with a descriptive error
    expect(output).toMatch(/prompt.*required|missing.*prompt/i)
  })

  cliTest('--print-command shows shell command', () => {
    const output = agentOutput({
      prompt: 'Hello',
      harness: 'claude',
      flags: ['--dry-run', '--print-command'],
    })

    expect(output).toMatch(/print|command|claude|codex/i)
  })
})

describe('asp agent resolve (T-00866)', () => {
  cliTest('asp agent resolve shows resolved bundle', () => {
    // Should print resolution output, not execute
    expect(agentOutput({ mode: 'resolve' })).toMatch(
      /resolve|bundle|placement|instructions|spaces/i
    )
  })

  cliTest('asp agent resolve --json outputs JSON', () => {
    expect(agentOutput({ mode: 'resolve', flags: ['--json'] })).toMatch(/\{|json|resolve/i)
  })

  cliTest('asp agent resolve with project context', () => {
    const output = agentOutput({
      scopeRef: 'agent:alice:project:demo',
      mode: 'resolve',
      withProjectRoot: true,
    })

    expect(output).toMatch(/resolve|bundle|placement/i)
  })
})

describe('bundle selection flags (T-00868)', () => {
  cliTest('--compose accepts repeated space refs', () => {
    const output = agentOutput({
      prompt: 'Hello',
      harness: 'claude',
      flags: [
        '--compose',
        'space:agent:private-ops',
        '--compose',
        'space:agent:task-worker',
        '--dry-run',
      ],
    })

    expect(output).not.toMatch(/unknown.*option.*compose/i)
  })
})

describe('agent command handler source', () => {
  // T-01092: foreground process selection
  cliTest(
    'projects the selected harness from the compiler catalog without a local route table',
    () => {
      const source = readFileSync(AGENT_COMMAND_SOURCE, 'utf8')

      expect(source).toContain('resolveHarnessExecution')
      expect(source).toContain('HARNESS_CATALOG[resolution.selection.harness]')
      expect(source).not.toMatch(/if \(input === '(?:claude|codex|muse|agent-harness)'\)/)
    }
  )

  // T-00872: the handler must use hostSessionId, never the legacy cpSessionId.
  cliTest('source code has no cpSessionId in agent command handler', () => {
    const cpSessionIdLines = readFileSync(AGENT_COMMAND_SOURCE, 'utf8')
      .split('\n')
      .filter((line) => line.includes('cpSessionId') && !line.trimStart().startsWith('//'))
    expect(cpSessionIdLines).toEqual([])
  })
})
