import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { ClaudeCodeTmuxDriverOptions } from '../../../src/drivers/claude-code-tmux/driver'
import type { HookEnvelope, TmuxExecCall } from './driver-red.helpers'
import {
  claudeTmuxSpec,
  createCtx,
  createRecordingExec,
  defaultLease,
  loadFactory,
  now,
} from './driver-red.helpers'

/**
 * T-11837. Claude Code batches transcript appends behind a 100 ms flush timer
 * (`FLUSH_INTERVAL_MS=100`, claude 2.1.310), so a Stop hook that returns fast
 * reaches the broker before the turn's closing `assistant` row is on disk. The
 * turn must still carry exactly ONE terminal assistant message.
 */
const SOCKET = '/tmp/harness-broker/claude-hooks.sock'

const assistantRow = (id: string, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  })}\n`
const stopSummaryRow = `${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' })}\n`

async function startDriver(extra: Partial<ClaudeCodeTmuxDriverOptions> = {}) {
  const createDriver = await loadFactory()
  const tmuxCalls: TmuxExecCall[] = []
  let handler: ((envelope: HookEnvelope) => Promise<unknown>) | undefined
  const events: InvocationEventEnvelope[] = []
  const root = mkdtempSync(join(tmpdir(), 'claude-stop-race-'))
  const transcriptPath = join(root, 'session.jsonl')
  writeFileSync(transcriptPath, '')
  const driver = createDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
    hooks: {
      listen: async (listener) => {
        handler = listener as (envelope: HookEnvelope) => Promise<unknown>
        return { socketPath: SOCKET, close: async () => undefined }
      },
    },
    now,
    ...extra,
  })
  await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
  const hook = async (hookData: Record<string, unknown>, turnId?: string) =>
    handler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: SOCKET,
      ...(turnId !== undefined ? { turnId } : {}),
      hookData,
    })
  await hook({ hook_event_name: 'SessionStart', transcript_path: transcriptPath })
  const messages = () => events.filter((event) => event.type === 'assistant.message.completed')
  return {
    events,
    transcriptPath,
    hook,
    messages,
    cleanup: async () => {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('claude-code-tmux Stop vs transcript flush (T-11837)', () => {
  test('a Stop that beats the transcript flush waits for the row and emits ONE transcript message', async () => {
    const run = await startDriver()
    try {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_fast')
      // Claude's write queue drains 40 ms after the Stop hook already arrived.
      setTimeout(() => appendFileSync(run.transcriptPath, assistantRow('msg_fast', 'DONE')), 40)
      await run.hook({ hook_event_name: 'Stop', last_assistant_message: 'DONE' }, 'turn_fast')
      // The closing rows Claude writes only after the Stop hooks return.
      appendFileSync(run.transcriptPath, stopSummaryRow)
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }, 'turn_next')

      expect(run.messages().map((event) => event.payload)).toEqual([
        {
          messageId: 'msg_fast',
          content: [{ type: 'text', text: 'DONE' }],
          final: true,
        },
      ])
      const message = run.messages()[0]
      expect(message?.turnId).toBe('turn_fast')
      expect(message?.driver?.rawType).toBe('transcript.assistant')
      const terminalSeq = run.events.find((event) => event.type === 'turn.completed')?.seq ?? 0
      expect(message?.seq ?? Number.POSITIVE_INFINITY).toBeLessThan(terminalSeq)
    } finally {
      await run.cleanup()
    }
  })

  test('a row that lands after the bounded wait is not a second terminal message', async () => {
    const run = await startDriver({ stopTranscriptWaitMs: 20 })
    try {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_slow')
      await run.hook({ hook_event_name: 'Stop', last_assistant_message: 'DONE' }, 'turn_slow')
      // The named exception fired: the turn really answered.
      expect(run.messages().map((event) => event.payload)).toEqual([
        {
          messageId: 'turn_slow_final',
          content: [{ type: 'text', text: 'DONE' }],
          final: true,
        },
      ])
      // Now the transcript catches up with the very prose the fallback carried.
      appendFileSync(run.transcriptPath, assistantRow('msg_slow', 'DONE') + stopSummaryRow)
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'next' }, 'turn_next')
      expect(run.messages()).toHaveLength(1)

      // Coverage is per turn: the next turn answering the same words still counts.
      appendFileSync(run.transcriptPath, assistantRow('msg_next', 'DONE'))
      await run.hook({ hook_event_name: 'Stop', last_assistant_message: 'DONE' }, 'turn_next')
      expect(run.messages().map((event) => [event.turnId, event.payload])).toEqual([
        ['turn_slow', expect.objectContaining({ messageId: 'turn_slow_final' })],
        ['turn_next', expect.objectContaining({ messageId: 'msg_next' })],
      ])
    } finally {
      await run.cleanup()
    }
  })

  test('closing rows that flush the reply before the Stop is processed leave ONE message, no wait', async () => {
    const run = await startDriver({ stopTranscriptWaitMs: 5_000 })
    try {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_detached')
      // The Stop hook gave up on the broker (its 1 s read timeout), so Claude
      // already wrote the reply AND its closing rows: the `system` row flushes
      // the held message before the Stop envelope is normalized.
      appendFileSync(run.transcriptPath, assistantRow('msg_detached', 'DONE') + stopSummaryRow)
      const started = performance.now()
      await run.hook({ hook_event_name: 'Stop', last_assistant_message: 'DONE' }, 'turn_detached')
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(run.messages().map((event) => [event.turnId, event.payload])).toEqual([
        [
          'turn_detached',
          { messageId: 'msg_detached', content: [{ type: 'text', text: 'DONE' }], final: true },
        ],
      ])
      expect(run.events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    } finally {
      await run.cleanup()
    }
  })

  test('a Stop with no last_assistant_message does not wait', async () => {
    const run = await startDriver({ stopTranscriptWaitMs: 5_000 })
    try {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_quiet')
      const started = performance.now()
      await run.hook({ hook_event_name: 'Stop' }, 'turn_quiet')
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(run.messages()).toHaveLength(0)
      expect(run.events.some((event) => event.type === 'turn.completed')).toBe(true)
    } finally {
      await run.cleanup()
    }
  })
})
