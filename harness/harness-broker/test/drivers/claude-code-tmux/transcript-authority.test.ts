import { describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { startHookDriver } from './driver-red.helpers'

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

const plain = (event: InvocationEventEnvelope): Emitted => ({
  type: event.type,
  payload: event.payload as unknown as Record<string, unknown>,
  turnId: event.turnId as string | undefined,
})

/**
 * The claude-code-tmux driver with turn `turn_1` open (unless `openTurn` is
 * false). `write` appends rows to the session transcript and fires a
 * PostToolUse hook, which is what makes the driver read them.
 */
async function harness(options: { openTurn?: boolean } = {}) {
  const run = await startHookDriver()
  const turnId = options.openTurn === false ? undefined : 'turn_1'
  if (turnId !== undefined) {
    await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, turnId)
  }
  const since = run.events.length
  return {
    run,
    /** Events the transcript rows produced, after the start and the turn bracket. */
    emitted: (type?: string): Emitted[] =>
      run.events
        .slice(since)
        .filter((event) => type === undefined || event.type === type)
        .map(plain),
    async write(...rows: Array<Record<string, unknown>>) {
      for (const row of rows) appendFileSync(run.transcriptPath, `${JSON.stringify(row)}\n`)
      await run.hook(
        { hook_event_name: 'PostToolUse', tool_use_id: 'call_1', tool_name: 'Bash' },
        turnId
      )
    },
  }
}

async function withHarness(
  body: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
  options: { openTurn?: boolean } = {}
): Promise<void> {
  const h = await harness(options)
  try {
    await body(h)
  } finally {
    await h.run.cleanup()
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
  test('one `usage.updated` per MESSAGE, not per row', () =>
    withHarness(async (h) => {
      // The deciding measurement: 155/155 assistant rows carry `message.usage`
      // and every row of a multi-row message repeats the SAME object (0 differing
      // across the archived corpus and a live session). Emitting per row would
      // report this turn's tokens three times.
      await h.write(
        assistantRow({ type: 'thinking', thinking: 'considering' }),
        assistantRow({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }),
        assistantRow({ type: 'text', text: 'done' })
      )

      const usage = h.emitted('usage.updated')
      expect(usage).toHaveLength(1)
      expect(usage[0]).toMatchObject({ turnId: 'turn_1', payload: { usage: USAGE } })
    }))

  test('a `cost-state` row reports the session roll-up', () =>
    withHarness(async (h) => {
      await h.write({
        type: 'cost-state',
        sessionId: 'sess_1',
        totalCostUSD: 1.2677,
        modelUsage: { 'claude-opus-5': { inputTokens: 4562, outputTokens: 7459 } },
      })

      const usage = h.emitted('usage.updated')
      expect(usage).toHaveLength(1)
      expect(usage[0]?.payload['usage']).toMatchObject({
        totalCostUSD: 1.2677,
        modelUsage: { 'claude-opus-5': { inputTokens: 4562, outputTokens: 7459 } },
      })
      // The row `type` is carried by the raw record's provenance, not smuggled
      // into the usage body.
      expect(usage[0]?.payload['usage']).not.toHaveProperty('type')
    }))

  test.each([
    {
      evidence: 'an assistant row naming its model',
      row: assistantRow({ type: 'text', text: 'done' }),
      model: { id: 'claude-opus-5', source: 'provider-response' },
    },
    {
      evidence: 'an assistant row naming no model',
      row: assistantRow({ type: 'text', text: 'done' }, { message: { model: undefined } }),
      model: undefined,
    },
    {
      evidence: 'a single-model cost-state',
      row: {
        type: 'cost-state',
        sessionId: 'sess_1',
        modelUsage: { 'claude-opus-5': { inputTokens: 4562, outputTokens: 7459 } },
      },
      model: { id: 'claude-opus-5', source: 'provider-response' },
    },
    {
      evidence: 'a cost-state spanning two models',
      row: {
        type: 'cost-state',
        sessionId: 'sess_1',
        modelUsage: {
          'claude-opus-5': { inputTokens: 4562 },
          'claude-haiku-4-5-20251001': { inputTokens: 12 },
        },
      },
      model: undefined,
    },
  ])(
    'usage.updated names the serving model only when the transcript names exactly one ($evidence)',
    ({ row, model }) =>
      withHarness(async (h) => {
        await h.write(row)

        const usage = h.emitted('usage.updated')
        expect(usage).toHaveLength(1)
        expect(usage[0]?.payload['model']).toEqual(model)
        // T-08430: the per-model detail is not lost when no winner is named.
        if (row['type'] === 'cost-state') {
          expect(usage[0]?.payload['usage']).toHaveProperty('modelUsage')
        }
      })
  )
})

describe('claude-code-tmux transcript authority: conversation', () => {
  test('mail-hint hook attachments never mint or attribute a turn', () =>
    withHarness(
      async (h) => {
        const rows = readFileSync(
          join(
            import.meta.dir,
            '../../fixtures/claude-transcript/mail-hint-attachments-2.1.259.jsonl'
          ),
          'utf8'
        )
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)

        await h.write(...rows)

        expect(h.emitted()).toEqual([])
      },
      { openTurn: false }
    ))

  test('prose spread across several rows of one message becomes ONE completed message', () =>
    withHarness(async (h) => {
      await h.write(
        assistantRow({ type: 'text', text: 'first half. ' }),
        assistantRow({ type: 'thinking', thinking: 'not prose' }),
        assistantRow({ type: 'text', text: 'second half.' }),
        // A `user` row is what ends a message; attachments interleave freely and
        // must NOT split it.
        { type: 'attachment', attachment: { type: 'total_tokens_reminder' } },
        { type: 'user', promptSource: 'typed', message: { role: 'user', content: 'next' } }
      )

      const completed = h.emitted('assistant.message.completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]).toMatchObject({
        turnId: 'turn_1',
        payload: {
          messageId: 'msg_01',
          content: [{ type: 'text', text: 'first half. second half.' }],
          final: true,
        },
      })
      expect(h.emitted('assistant.message.started').map((event) => event.payload)).toEqual([
        { messageId: 'msg_01' },
      ])
    }))

  test('an interleaved attachment does not split a message in two', () =>
    withHarness(async (h) => {
      await h.write(
        assistantRow({ type: 'text', text: 'a' }),
        { type: 'attachment', attachment: { type: 'hook_success' } },
        { type: 'last-prompt', prompt: 'x' },
        assistantRow({ type: 'text', text: 'b' }),
        { type: 'system', subtype: 'turn_duration', durationMs: 10 }
      )

      const completed = h.emitted('assistant.message.completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]?.payload['content']).toEqual([{ type: 'text', text: 'ab' }])
    }))

  test("`final` follows the row's own `stop_reason`", () =>
    withHarness(async (h) => {
      await h.write(
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
      const completed = h.emitted('assistant.message.completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]?.payload['final']).toBe(false)
    }))

  test('an aborted message is flushed as NON-final, and the abort names its record', () =>
    withHarness(async (h) => {
      // `isAbortedMidStream` is the only signal an interrupted turn leaves: no
      // `Stop`, so no `turn_duration` / `stop_hook_summary` row will ever end the
      // message. Losing the partial answer is not an option.
      await h.write(
        assistantRow(
          { type: 'text', text: 'partial ans' },
          { row: { isAbortedMidStream: true }, message: { stop_reason: null } }
        )
      )
      expect(h.emitted('assistant.message.completed')).toEqual([
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
    }))
})

describe('claude-code-tmux transcript authority: tool', () => {
  test('a `tool_use` block starts the call and a `tool_result` block completes it', () =>
    withHarness(async (h) => {
      await h.write(
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

      expect(h.emitted().filter((e) => e.type.startsWith('tool.call.'))).toEqual([
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
    }))

  test.each([
    {
      result: 'is_error:true',
      tool: { id: 'toolu_read_1', name: 'Read', input: { file_path: '/x' } },
      toolUseResult: 'File does not exist.' as unknown,
      block: { content: 'File does not exist.', is_error: true },
      completed: { toolCallId: 'toolu_read_1', name: 'Read', isError: true },
    },
    {
      // Preserved from the hook-path suite: a failing command still completes.
      result: 'exit_code 1 with is_error:false',
      tool: { id: 'toolu_bash_1', name: 'Bash', input: { command: 'false' } },
      toolUseResult: { stdout: '', stderr: '', exit_code: 1 } as unknown,
      block: { content: '', is_error: false },
      completed: {
        toolCallId: 'toolu_bash_1',
        name: 'Bash',
        isError: false,
        result: { details: { stdout: '', stderr: '', exit_code: 1 } },
      },
    },
  ])(
    'a tool result reports isError from its is_error flag, not from the command exit code ($result)',
    ({ tool, toolUseResult, block, completed }) =>
      withHarness(async (h) => {
        await h.write(assistantRow({ type: 'tool_use', ...tool }), {
          type: 'user',
          toolUseResult,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: tool.id, ...block }],
          },
        })

        const done = h.emitted('tool.call.completed')
        expect(done).toHaveLength(1)
        expect(done[0]?.payload).toMatchObject(completed)
        expect(h.emitted('tool.call.failed')).toEqual([])
      })
  )

  test('a result with no matching start still completes, named `tool`', () =>
    withHarness(async (h) => {
      // Defensive: a transcript that was retargeted or truncated mid-call can
      // deliver a result whose start this reader never saw. `name` is required,
      // so the event must still be well-formed rather than dropped.
      await h.write({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'x' }],
        },
      })
      expect(h.emitted('tool.call.completed').map((event) => event.payload)).toEqual([
        expect.objectContaining({ toolCallId: 'toolu_orphan', name: 'tool' }),
      ])
    }))
})
