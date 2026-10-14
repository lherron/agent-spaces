import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeEventPayload } from '../../src/runtime/event-normalize'
import { toolCallSummary } from '../../src/runtime/tool-call-summary'
import { toolCallIdFrom } from '../ids'

/**
 * T-10932 failure list. Inputs are real `tool.call.started` payloads lifted
 * from the HRC broker event store (Claude Code, Codex app-server, Codex
 * desktop code mode, pi), one per line in fixture order.
 */
const LIVE = readFileSync(
  join(import.meta.dir, '../fixtures/tool-call-summary/live-tool-inputs.ndjson'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { name: string; input: unknown })

const live = (index: number) => {
  const fixture = LIVE[index]
  if (fixture === undefined) throw new Error(`missing fixture ${index}`)
  return fixture
}
const summarize = (index: number) => toolCallSummary(live(index).name, live(index).input)

describe('toolCallSummary — exec calls only (T-10932)', () => {
  test('0. non-exec tools get no summary, even with a description', () => {
    expect(summarize(3)).toBeUndefined() // Read {file_path}
    expect(summarize(4)).toBeUndefined() // Agent {description, prompt}
    expect(summarize(5)).toBeUndefined() // MCP
    expect(toolCallSummary('Grep', { pattern: 'foo', path: '/x' })).toBeUndefined()
    expect(toolCallSummary('Edit', { file_path: '/x.ts', old_string: 'a' })).toBeUndefined()
    expect(toolCallSummary('Read', undefined)).toBeUndefined()
  })

  test('apply_patch carries its patch in `command` but is not exec', () => {
    expect(summarize(9)).toBeUndefined()
  })

  test('1. Claude description is used verbatim, not overwritten', () => {
    expect(summarize(0)).toBe('Show working tree changes')
    expect(summarize(2)).toBe('just verify cdfb423d failures/exit') // Monitor
  })

  test('blank description falls through to exec-derived', () => {
    expect(toolCallSummary('Bash', { command: 'git status', description: '   ' })).toBe(
      'Running git...'
    )
  })

  test('2. driver-supplied summary is preserved', () => {
    expect(toolCallSummary('Bash', live(0).input, 'Driver line')).toBe('Driver line')
  })

  test('3. shell wrappers are unwrapped to the real program', () => {
    expect(summarize(6)).toBe('Running git...') // /bin/zsh -lc 'git status -sb && ...'
    expect(summarize(7)).toBe('Running wrkc...') // /bin/zsh -lc "wrkc say ... <<'EOF'"
    expect(toolCallSummary('command', { command: ['/bin/zsh', '-lc', 'rg -n foo; cat x'] })).toBe(
      'Running rg...'
    )
    expect(toolCallSummary('command', { command: ['bash', '-c', 'git push'] })).toBe(
      'Running git...'
    )
    expect(toolCallSummary('exec_command', { cmd: '/usr/bin/env -u CLAUDECODE git push' })).toBe(
      'Running git...'
    )
  })

  test('4. env assignments and `cd x &&` are skipped', () => {
    expect(summarize(1)).toBe('Running wrkc...') // cd ~/praesidium/agent-spaces && wrkc say ...
    expect(summarize(8)).toBe('Running wrkc...') // WRKQ_PROJECT_ROOT=wrkq wrkc say ...
    expect(toolCallSummary('Bash', { command: 'cd /tmp; FOO="a b" ./scripts/run.sh x' })).toBe(
      'Running run.sh...'
    )
    // Live shape: an assignment whose value is a command substitution.
    expect(
      toolCallSummary('Bash', {
        command: 'S=/tmp/scratch; R=$(ls -d $S/lake/releases/*/); cd ~/x && uv run python - <<EOF',
      })
    ).toBe('Running uv...')
  })

  test('5. multi-command code mode lists every distinct program in order', () => {
    expect(summarize(10)).toBe('Running pwd, git...')
    expect(summarize(11)).toBe('Running hrc, sed...')
    const many = ['git a', 'sed b', 'rg c', 'git d', 'cat e', 'jq f']
      .map((cmd) => `tools.exec_command({cmd:${JSON.stringify(cmd)}})`)
      .join(';\n')
    expect(toolCallSummary('exec/orchestration', { codeMode: many })).toBe(
      'Running git, sed, rg, cat, jq...'
    )
  })

  test('template-literal cmd uses its literal prefix', () => {
    expect(summarize(12)).toBe('Running wrkc...')
  })

  test('6. code mode without a literal cmd names its tool calls, never blank', () => {
    expect(summarize(13)).toBe('Running exec_command, apply_patch...') // cmd:files.map(...)
    expect(summarize(14)).toBe('Running write_stdin...')
    expect(summarize(15)).toBe('Running apply_patch...')
    expect(toolCallSummary('exec/orchestration', { codeMode: 'text(1+1)' })).toBe(
      'Running exec/orchestration...'
    )
    expect(toolCallSummary('Bash', { command: '   ' })).toBe('Running Bash...')
  })

  test('whitespace and newlines collapse to single spaces; no length cap', () => {
    expect(toolCallSummary('Bash', { command: 'x', description: '  Show\n\tthe   tree ' })).toBe(
      'Show the tree'
    )
    const long = 'd'.repeat(500)
    expect(toolCallSummary('Bash', { command: 'x', description: long })).toBe(long)
  })
})

describe('normalizeEventPayload — tool.call.started summary', () => {
  test('adds summary to exec starts and leaves other tools alone', () => {
    const exec = normalizeEventPayload({
      type: 'tool.call.started',
      payload: { toolCallId: toolCallIdFrom('call_1'), ...live(6) },
    })
    expect(exec.payload.summary).toBe('Running git...')
    expect(exec.payload.input).toEqual(live(6).input)

    const read = normalizeEventPayload({
      type: 'tool.call.started',
      payload: { toolCallId: toolCallIdFrom('call_2'), ...live(3) },
    })
    expect('summary' in read.payload).toBe(false)
  })

  test('keeps a driver summary', () => {
    const { payload } = normalizeEventPayload({
      type: 'tool.call.started',
      payload: { toolCallId: toolCallIdFrom('call_3'), ...live(0), summary: 'From driver' },
    })
    expect(payload.summary).toBe('From driver')
  })
})
