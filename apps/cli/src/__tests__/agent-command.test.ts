/**
 * `asp agent <scope-ref> <mode>` command surface: mode verbs, prompt
 * requirements, resolve output and bundle selection flags.
 *
 * wrkq: T-00865 (modes), T-00866 (resolve), T-00868 (bundle selection),
 *       T-01092 (foreground selection)
 */

import { describe, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AGENT_ROOT, agentArgs, cliTest, defaultAspHome, runAsp } from './asp-cli'

const AGENT_COMMAND_SOURCE = join(import.meta.dirname, '..', 'commands', 'agent', 'index.ts')

/** Combined stdout + stderr of an `asp agent` invocation. */
function agentOutput(...args: Parameters<typeof agentArgs>): string {
  const result = runAsp(agentArgs(...args))
  return result.stdout + result.stderr
}

describe('asp agent <scope-ref> <mode> (T-00865)', () => {
  cliTest(
    'query --dry-run prints the would-execute argv ending in the prompt and spawns nothing',
    () => {
      const result = runAsp(
        agentArgs({ prompt: 'What is your name?', harness: 'claude', flags: ['--dry-run'] })
      )

      expect(result.exitCode).toBe(0)
      const lines = result.stdout.split('\n')
      expect(lines).toContain('Dry run — would execute:')
      const argvLine = lines.find((line) => line.startsWith('  argv: '))
      expect(argvLine).toBeDefined()
      const argv = JSON.parse(argvLine?.slice('  argv: '.length) ?? '[]') as string[]
      expect(argv.slice(-2)).toEqual(['--', 'What is your name?'])
    }
  )

  cliTest('asp agent "agent:alice" query requires a prompt', () => {
    const output = agentOutput({ harness: 'claude', flags: ['--dry-run'] })

    // query mode without a prompt should fail with a descriptive error
    expect(output).toMatch(/prompt.*required|missing.*prompt/i)
  })

  cliTest(
    '--print-command prints the env-prefixed claude shell command ending in the prompt',
    () => {
      const result = runAsp(
        agentArgs({ prompt: 'Hello', harness: 'claude', flags: ['--dry-run', '--print-command'] })
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toStartWith(`ASP_PLUGIN_ROOT=${join(defaultAspHome(), 'codex-homes')}/`)
      expect(result.stdout).toMatch(/ ASP_PRIMING_PROMPT=Hello \S*claude --model /)
      expect(result.stdout).toContain(' -- Hello\n')
    }
  )
})

describe('asp agent resolve (T-00866)', () => {
  cliTest('resolve prints the placement and the resolved bundle without executing', () => {
    const result = runAsp(agentArgs({ mode: 'resolve' }))

    expect(result.exitCode).toBe(0)
    const lines = result.stdout.split('\n')
    expect(lines).toContain(`  agentRoot: ${AGENT_ROOT}`)
    expect(lines).toContain('  runMode:   resolve')
    expect(lines).toContain('  bundle:    agent-project')
    expect(lines).toContain('Resolved Bundle:')
    expect(lines.some((line) => /^ {2}identity: {5}bundle:[0-9a-f]+$/.test(line))).toBe(true)
    expect(lines).toContain('    space:agent:private-ops -> private-ops@agent')
  })
})

describe('bundle selection flags (T-00868)', () => {
  cliTest('repeated --compose refs replace the agent-project bundle, in the given order', () => {
    const result = runAsp(
      agentArgs({
        mode: 'resolve',
        flags: [
          '--compose',
          'space:agent:task-worker',
          '--compose',
          'space:agent:private-ops',
          '--json',
        ],
      })
    )

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    // compose takes precedence over the agent name the scope ref selects (T-00993)
    expect(parsed.placement.bundle).toEqual({
      kind: 'compose',
      compose: ['space:agent:task-worker', 'space:agent:private-ops'],
    })
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
})
