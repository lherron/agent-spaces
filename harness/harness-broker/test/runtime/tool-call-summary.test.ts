import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createTestDriver } from '../../src/testing/test-driver'
import { testDriverSpec } from '../helpers'
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

const codeMode = (cmds: string[]) =>
  cmds.map((cmd) => `tools.exec_command({cmd:${JSON.stringify(cmd)}})`).join(';\n')

let seq = 0
/** Emit one `tool.call.started` through the real broker; return the published envelope. */
async function published(start: {
  name: string
  input: unknown
  summary?: string
}): Promise<InvocationEventEnvelope<'tool.call.started'>> {
  seq += 1
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver()
  const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
  await broker.start({ spec: testDriverSpec(`inv_tool_summary_${seq}`) })
  controller.emitRaw('tool.call.started', {
    toolCallId: toolCallIdFrom(`call_${seq}`),
    ...start,
  } as never)
  const event = events.find((e) => e.type === 'tool.call.started')
  if (event === undefined) throw new Error('tool.call.started was not published')
  return event as InvocationEventEnvelope<'tool.call.started'>
}

describe('tool.call.started summary — exec calls only (T-10932)', () => {
  test.each([
    // 0. Non-exec tools get no summary, even with a description.
    { row: 'live Read', start: live(3), summary: undefined },
    { row: 'live Agent with a description', start: live(4), summary: undefined },
    { row: 'live MCP', start: live(5), summary: undefined },
    {
      row: 'Grep',
      start: { name: 'Grep', input: { pattern: 'foo', path: '/x' } },
      summary: undefined,
    },
    {
      row: 'Edit',
      start: { name: 'Edit', input: { file_path: '/x.ts', old_string: 'a' } },
      summary: undefined,
    },
    { row: 'Read with no input', start: { name: 'Read', input: undefined }, summary: undefined },
    // apply_patch carries its patch in `command` but is not exec.
    { row: 'live apply_patch', start: live(9), summary: undefined },
    // 1. A Claude description is used verbatim, not overwritten.
    { row: 'live Bash description', start: live(0), summary: 'Show working tree changes' },
    {
      row: 'live Monitor description',
      start: live(2),
      summary: 'just verify cdfb423d failures/exit',
    },
    // A blank description falls through to the exec-derived summary.
    {
      row: 'blank description',
      start: { name: 'Bash', input: { command: 'git status', description: '   ' } },
      summary: 'Running git...',
    },
    // 2. A driver-supplied summary is kept.
    {
      row: 'driver-supplied summary',
      start: { ...live(0), summary: 'From driver' },
      summary: 'From driver',
    },
    // 3. Shell wrappers are unwrapped to the real program.
    { row: "live zsh -lc 'git status -sb && ...'", start: live(6), summary: 'Running git...' },
    { row: 'live zsh -lc wrkc heredoc', start: live(7), summary: 'Running wrkc...' },
    {
      row: 'argv zsh -lc',
      start: { name: 'command', input: { command: ['/bin/zsh', '-lc', 'rg -n foo; cat x'] } },
      summary: 'Running rg...',
    },
    {
      row: 'argv bash -c',
      start: { name: 'command', input: { command: ['bash', '-c', 'git push'] } },
      summary: 'Running git...',
    },
    {
      row: 'env -u',
      start: { name: 'exec_command', input: { cmd: '/usr/bin/env -u CLAUDECODE git push' } },
      summary: 'Running git...',
    },
    // 4. Env assignments and `cd x &&` are skipped.
    { row: 'live cd x && wrkc', start: live(1), summary: 'Running wrkc...' },
    { row: 'live VAR=x wrkc', start: live(8), summary: 'Running wrkc...' },
    {
      row: 'cd; quoted assignment; script path',
      start: { name: 'Bash', input: { command: 'cd /tmp; FOO="a b" ./scripts/run.sh x' } },
      summary: 'Running run.sh...',
    },
    {
      row: 'command-substitution assignment',
      start: {
        name: 'Bash',
        input: {
          command:
            'S=/tmp/scratch; R=$(ls -d $S/lake/releases/*/); cd ~/x && uv run python - <<EOF',
        },
      },
      summary: 'Running uv...',
    },
    // 5. Multi-command code mode lists every distinct program in order, capped at five.
    { row: 'live code mode pwd, git', start: live(10), summary: 'Running pwd, git...' },
    { row: 'live code mode hrc, sed', start: live(11), summary: 'Running hrc, sed...' },
    {
      row: 'code mode with six programs',
      start: {
        name: 'exec/orchestration',
        input: { codeMode: codeMode(['git a', 'sed b', 'rg c', 'git d', 'cat e', 'jq f']) },
      },
      summary: 'Running git, sed, rg, cat, jq...',
    },
    // A template-literal cmd uses its literal prefix.
    { row: 'live template-literal cmd', start: live(12), summary: 'Running wrkc...' },
    // 6. Code mode without a literal cmd names its tool calls, never blank.
    {
      row: 'live cmd:files.map(...)',
      start: live(13),
      summary: 'Running exec_command, apply_patch...',
    },
    { row: 'live write_stdin', start: live(14), summary: 'Running write_stdin...' },
    { row: 'live apply_patch call', start: live(15), summary: 'Running apply_patch...' },
    {
      row: 'code mode with no tool call',
      start: { name: 'exec/orchestration', input: { codeMode: 'text(1+1)' } },
      summary: 'Running exec/orchestration...',
    },
    {
      row: 'blank command',
      start: { name: 'Bash', input: { command: '   ' } },
      summary: 'Running Bash...',
    },
    // Whitespace and newlines collapse to single spaces; no length cap.
    {
      row: 'multi-line description',
      start: { name: 'Bash', input: { command: 'x', description: '  Show\n\tthe   tree ' } },
      summary: 'Show the tree',
    },
    {
      row: '500-char description',
      start: { name: 'Bash', input: { command: 'x', description: 'd'.repeat(500) } },
      summary: 'd'.repeat(500),
    },
  ])(
    'a published tool.call.started for $row carries the expected summary',
    async ({ start, summary }) => {
      const event = await published(start)
      if (summary === undefined) {
        expect('summary' in event.payload).toBe(false)
      } else {
        expect(event.payload.summary).toBe(summary)
      }
      // The summary is added alongside the input, never in place of it.
      expect(event.payload.input).toEqual(start.input)
    }
  )
})
