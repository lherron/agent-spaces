import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeHookTranscriptReader } from '../../../src/drivers/claude-code-tmux/hook-transcript'

/**
 * Phase 4 promoted emitters (wrkq T-07873, doc §6/§6.1): `usage`,
 * `conversation` and `tool` are minted from the session JSONL rows that are
 * their evidence, not from the hooks that used to carry copies of them.
 *
 * Every row shape here is taken from a REAL Claude Code session — in particular
 * the fact that ONE assistant message is written as SEVERAL rows, one per
 * content block, all repeating the same `message.id`, `stop_reason` and
 * `usage`. A reader that treats a row as a message triples a turn's token
 * counts and splits its prose, which is why that shape is asserted directly.
 */

type Emitted = { type: string; payload: Record<string, unknown>; turnId?: string | undefined }

const roots: string[] = []
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function harness(options: { turnId?: string | undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-transcript-authority-'))
  roots.push(dir)
  const transcript = join(dir, 'session.jsonl')
  writeFileSync(transcript, '')
  const emitted: Emitted[] = []
  const started: string[] = []

  const reader = createClaudeHookTranscriptReader({
    invocationId: 'inv_authority',
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    getCurrentTurnId: () => options.turnId ?? 'turn_1',
    emit: (type, payload, extra) => {
      emitted.push({
        type,
        payload: payload as unknown as Record<string, unknown>,
        turnId: extra?.turnId,
      })
    },
    onAssistantMessageStarted: (messageId) => started.push(messageId),
    // The disposition mirror has its own suite; here it reports "no fact
    // minted" so the reader's own emitters are what is under test.
    onTranscriptEntry: () => false,
  })
  reader.handleHook({ hook_event_name: 'SessionStart', transcript_path: transcript })

  return {
    reader,
    emitted,
    started,
    write(...rows: Array<Record<string, unknown>>) {
      for (const row of rows) appendFileSync(transcript, `${JSON.stringify(row)}\n`)
      reader.drain()
    },
  }
}

const USAGE = {
  input_tokens: 2,
  output_tokens: 25,
  cache_creation_input_tokens: 28_820,
  cache_read_input_tokens: 26_349,
  output_tokens_details: { thinking_tokens: 0 },
}

/** One content block of one assistant message, as Claude writes it. */
const assistantRow = (
  block: Record<string, unknown>,
  overrides: { message?: Record<string, unknown>; row?: Record<string, unknown> } = {}
): Record<string, unknown> => ({
  type: 'assistant',
  uuid: `uuid_${String(block['type'])}_${String(block['id'] ?? block['text'] ?? '')}`,
  apiBlockIndex: 0,
  ...overrides.row,
  message: {
    id: 'msg_01',
    model: 'claude-opus-5',
    role: 'assistant',
    type: 'message',
    stop_reason: 'end_turn',
    content: [block],
    usage: USAGE,
    ...overrides.message,
  },
})

describe('claude-code-tmux transcript authority: usage', () => {
  test('one `usage.updated` per MESSAGE, not per row', () => {
    // The deciding measurement: 155/155 assistant rows carry `message.usage`
    // and every row of a multi-row message repeats the SAME object (0 differing
    // across the archived corpus and a live session). Emitting per row would
    // report this turn's tokens three times.
    const h = harness()
    h.write(
      assistantRow({ type: 'thinking', thinking: 'considering' }),
      assistantRow({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }),
      assistantRow({ type: 'text', text: 'done' })
    )

    const usage = h.emitted.filter((event) => event.type === 'usage.updated')
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ turnId: 'turn_1', payload: { usage: USAGE } })
  })

  test('a `cost-state` row reports the session roll-up', () => {
    const h = harness()
    h.write({
      type: 'cost-state',
      sessionId: 'sess_1',
      totalCostUSD: 1.2677,
      modelUsage: { 'claude-opus-5': { inputTokens: 4562, outputTokens: 7459 } },
    })

    const usage = h.emitted.filter((event) => event.type === 'usage.updated')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload['usage']).toMatchObject({
      totalCostUSD: 1.2677,
      modelUsage: { 'claude-opus-5': { inputTokens: 4562, outputTokens: 7459 } },
    })
    // The row `type` is carried by the raw record's provenance, not smuggled
    // into the usage body.
    expect(usage[0]?.payload['usage']).not.toHaveProperty('type')
  })
})

describe('claude-code-tmux transcript authority: conversation', () => {
  test('mail-hint hook attachments never mint or attribute a turn', () => {
    const h = harness()
    const rows = readFileSync(
      join(import.meta.dir, '../../fixtures/claude-transcript/mail-hint-attachments-2.1.259.jsonl'),
      'utf8'
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    h.write(...rows)

    expect(h.emitted).toEqual([])
    expect(h.started).toEqual([])
  })

  test('prose spread across several rows of one message becomes ONE completed message', () => {
    const h = harness()
    h.write(
      assistantRow({ type: 'text', text: 'first half. ' }),
      assistantRow({ type: 'thinking', thinking: 'not prose' }),
      assistantRow({ type: 'text', text: 'second half.' }),
      // A `user` row is what ends a message; attachments interleave freely and
      // must NOT split it.
      { type: 'attachment', attachment: { type: 'total_tokens_reminder' } },
      { type: 'user', promptSource: 'typed', message: { role: 'user', content: 'next' } }
    )

    const completed = h.emitted.filter((event) => event.type === 'assistant.message.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      turnId: 'turn_1',
      payload: {
        messageId: 'msg_01',
        content: [{ type: 'text', text: 'first half. second half.' }],
        final: true,
      },
    })
    expect(h.started).toEqual(['msg_01'])
  })

  test('an interleaved attachment does not split a message in two', () => {
    const h = harness()
    h.write(
      assistantRow({ type: 'text', text: 'a' }),
      { type: 'attachment', attachment: { type: 'hook_success' } },
      { type: 'last-prompt', prompt: 'x' },
      assistantRow({ type: 'text', text: 'b' }),
      { type: 'system', subtype: 'turn_duration', durationMs: 10 }
    )

    const completed = h.emitted.filter((event) => event.type === 'assistant.message.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.payload['content']).toEqual([{ type: 'text', text: 'ab' }])
  })

  test("`final` follows the row's own `stop_reason`", () => {
    const h = harness()
    h.write(
      assistantRow(
        { type: 'text', text: 'thinking out loud' },
        {
          message: { stop_reason: 'tool_use' },
        }
      ),
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] },
      }
    )
    expect(
      h.emitted.find((event) => event.type === 'assistant.message.completed')?.payload['final']
    ).toBe(false)
  })

  test('the Stop flush is what closes the LAST message of a turn', () => {
    // Claude writes a turn's closing `system` rows only AFTER the Stop hooks
    // return, so at the moment the terminal is needed nothing in the transcript
    // has ended the message. The hook is the control; the event still carries
    // the assistant row's own message id.
    const h = harness()
    h.write(assistantRow({ type: 'text', text: 'the answer' }))
    expect(h.emitted.filter((e) => e.type === 'assistant.message.completed')).toEqual([])

    expect(h.reader.flushTerminalAssistantMessage()).toBe(true)
    expect(h.emitted.filter((e) => e.type === 'assistant.message.completed')).toEqual([
      {
        type: 'assistant.message.completed',
        turnId: 'turn_1',
        payload: {
          messageId: 'msg_01',
          content: [{ type: 'text', text: 'the answer' }],
          final: true,
        },
      },
    ])
    // Nothing held: a second flush must not mint a second final.
    expect(h.reader.flushTerminalAssistantMessage()).toBe(false)
  })

  test('an aborted message is flushed as NON-final, and the abort names its record', () => {
    // `isAbortedMidStream` is the only signal an interrupted turn leaves: no
    // `Stop`, so no `turn_duration` / `stop_hook_summary` row will ever end the
    // message. Losing the partial answer is not an option.
    const h = harness()
    h.write(
      assistantRow(
        { type: 'text', text: 'partial ans' },
        { row: { isAbortedMidStream: true }, message: { stop_reason: null } }
      )
    )
    expect(h.emitted.filter((e) => e.type === 'assistant.message.completed')).toEqual([
      {
        type: 'assistant.message.completed',
        turnId: 'turn_1',
        payload: {
          messageId: 'msg_01',
          content: [{ type: 'text', text: 'partial ans' }],
          final: false,
        },
      },
    ])
  })
})

describe('claude-code-tmux transcript authority: tool', () => {
  test('a `tool_use` block starts the call and a `tool_result` block completes it', () => {
    const h = harness()
    h.write(
      assistantRow({
        type: 'tool_use',
        id: 'toolu_01L8uQ47YNLhdmSpmG9FKhsg',
        name: 'Bash',
        input: { command: 'ls -la' },
      }),
      {
        type: 'user',
        toolUseResult: { stdout: 'total 0', stderr: '', interrupted: false },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01L8uQ47YNLhdmSpmG9FKhsg',
              content: 'total 0',
              is_error: false,
            },
          ],
        },
      }
    )

    expect(h.emitted.filter((e) => e.type.startsWith('tool.call.'))).toEqual([
      {
        type: 'tool.call.started',
        turnId: 'turn_1',
        payload: {
          toolCallId: 'toolu_01L8uQ47YNLhdmSpmG9FKhsg',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      },
      {
        type: 'tool.call.completed',
        turnId: 'turn_1',
        payload: {
          toolCallId: 'toolu_01L8uQ47YNLhdmSpmG9FKhsg',
          // The name is remembered from the `tool_use` block: `tool_result`
          // carries none, and `name` is required on the payload.
          name: 'Bash',
          isError: false,
          result: {
            content: [{ type: 'text', text: 'total 0' }],
            details: { stdout: 'total 0', stderr: '', interrupted: false },
          },
        },
      },
    ])
  })

  test('a nonzero exit is command result DATA, not a failed tool call', () => {
    // Preserved from the hook-path suite: `isError` follows the block's own
    // `is_error`, and a failing command still completes.
    const h = harness()
    h.write(
      assistantRow({
        type: 'tool_use',
        id: 'toolu_bash_1',
        name: 'Bash',
        input: { command: 'false' },
      }),
      {
        type: 'user',
        toolUseResult: { stdout: '', stderr: '', exit_code: 1 },
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_bash_1', content: '', is_error: false },
          ],
        },
      }
    )

    const completed = h.emitted.filter((e) => e.type === 'tool.call.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.payload).toMatchObject({
      name: 'Bash',
      isError: false,
      result: { details: { stdout: '', stderr: '', exit_code: 1 } },
    })
    expect(h.emitted.map((e) => e.type)).not.toContain('tool.call.failed')
  })

  test('`is_error` on the result block is reported as an errored completion', () => {
    const h = harness()
    h.write(
      assistantRow({
        type: 'tool_use',
        id: 'toolu_read_1',
        name: 'Read',
        input: { file_path: '/x' },
      }),
      {
        type: 'user',
        toolUseResult: 'File does not exist.',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read_1',
              content: 'File does not exist.',
              is_error: true,
            },
          ],
        },
      }
    )

    expect(h.emitted.find((e) => e.type === 'tool.call.completed')?.payload).toMatchObject({
      toolCallId: 'toolu_read_1',
      name: 'Read',
      isError: true,
    })
  })

  test('a result with no matching start still completes, named `tool`', () => {
    // Defensive: a transcript that was retargeted or truncated mid-call can
    // deliver a result whose start this reader never saw. `name` is required,
    // so the event must still be well-formed rather than dropped.
    const h = harness()
    h.write({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'x' }],
      },
    })
    expect(h.emitted.find((e) => e.type === 'tool.call.completed')?.payload).toMatchObject({
      toolCallId: 'toolu_orphan',
      name: 'tool',
    })
  })
})
