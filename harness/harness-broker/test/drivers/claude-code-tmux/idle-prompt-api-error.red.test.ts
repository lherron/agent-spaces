import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { type HookDriverRun, removeTempHookDirs, startHookDriver } from './driver-red.helpers'

afterEach(removeTempHookDirs)

/**
 * T-11969: after a non-retried API error Claude Code sends no `Stop`. It
 * returns to the prompt and, about 60 s later, sends `Notification` with
 * `notification_type: idle_prompt`. That hook closes the turn as
 * `turn.failed provider_api_error` while the API-error row is still the turn's
 * latest assistant/tool evidence.
 *
 * The replay uses the real hrcdev sequence from 2026-10-26 (rt-21bd2c09):
 * transcript rows 1012-1034 of session 211e8bdd verbatim, and the
 * `Notification` hook payload of broker ledger seq 14 (eb60980f24db).
 */
const HRCDEV_ROWS = readFileSync(
  join(import.meta.dir, 'claude-idle-prompt-api-error-211e8bdd.rows1012-1034.jsonl'),
  'utf8'
)

const HRCDEV_IDLE_PROMPT = {
  cwd: '/Users/lherron/praesidium/agent-spaces',
  hook_event_name: 'Notification',
  message: 'Claude is waiting for your input',
  notification_type: 'idle_prompt',
  prompt_id: 'd027cb89-5665-4350-ade5-28328c2b571d',
  session_id: '211e8bdd-bdde-436c-8e45-f5e6a444ab42',
  transcript_path:
    '/Users/lherron/.claude/projects/-Users-lherron-praesidium-agent-spaces/211e8bdd-bdde-436c-8e45-f5e6a444ab42.jsonl',
}

const HRCDEV_PROMPT = JSON.parse(HRCDEV_ROWS.split('\n')[1] ?? '{}').message.content as string

const TERMINALS = new Set(['turn.completed', 'turn.failed', 'turn.interrupted'])
const terminals = (events: InvocationEventEnvelope[]) =>
  events.filter((event) => TERMINALS.has(event.type))

const rows = (...entries: Record<string, unknown>[]) =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')

const API_ERROR_ROW = {
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'overloaded_error',
  message: {
    id: 'msg_err',
    model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: Overloaded' }],
  },
}

async function withRun(body: (run: HookDriverRun) => Promise<void>): Promise<void> {
  const run = await startHookDriver()
  try {
    await body(run)
  } finally {
    await run.cleanup()
  }
}

describe('claude-code-tmux idle_prompt closes an API-error turn (T-11969)', () => {
  test('hrcdev replay: login expiry then idle_prompt yields exactly one turn.failed', async () => {
    await withRun(async (run) => {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: HRCDEV_PROMPT })
      const turnId = run.ofType('turn.started')[0]?.turnId
      expect(turnId).toBeDefined()

      appendFileSync(run.transcriptPath, HRCDEV_ROWS)
      await run.hook(HRCDEV_IDLE_PROMPT)

      expect(run.ofType('diagnostic')).toMatchObject([
        {
          turnId,
          payload: {
            message: 'Login expired · Please run /login',
            data: { code: 'api_error', errorClass: 'auth' },
          },
        },
      ])
      // The idle notice is still reported as a notice.
      expect(run.ofType('driver.notice').map((event) => event.payload)).toContainEqual(
        expect.objectContaining({ message: 'Claude is waiting for your input' })
      )
      expect(terminals(run.events)).toMatchObject([
        {
          type: 'turn.failed',
          turnId,
          payload: {
            turnId,
            status: 'failed',
            code: 'provider_api_error',
            message: 'Claude Code provider API error',
            data: { diagnosticCode: 'api_error', closedBy: 'idle_prompt' },
          },
          driver: { kind: 'claude-code-tmux', rawType: 'Notification' },
        },
      ])

      // A late Stop dedupes; a second idle_prompt mints nothing.
      await run.hook({ hook_event_name: 'Stop' })
      await run.hook(HRCDEV_IDLE_PROMPT)
      expect(terminals(run.events)).toHaveLength(1)

      // The seat is free: the next prompt opens a fresh turn.
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'second dispatch' })
      const started = run.ofType('turn.started').map((event) => event.turnId)
      expect(started).toHaveLength(2)
      expect(started[1]).not.toBe(turnId)
    })
  })

  test('control: a normal turn closed by Stop then idle_prompt gets one turn.completed', async () => {
    await withRun(async (run) => {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })
      appendFileSync(
        run.transcriptPath,
        rows({
          type: 'assistant',
          message: {
            id: 'msg_ok',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
          },
        })
      )
      await run.hook({ hook_event_name: 'Stop', last_assistant_message: 'hi' })
      await run.hook(HRCDEV_IDLE_PROMPT)

      expect(terminals(run.events).map((event) => event.type)).toEqual(['turn.completed'])
    })
  })

  test('control: an API-error turn that recovers with assistant and tool rows gets no terminal from idle_prompt', async () => {
    await withRun(async (run) => {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      appendFileSync(
        run.transcriptPath,
        rows(
          API_ERROR_ROW,
          {
            type: 'assistant',
            message: {
              id: 'msg_retry',
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
              stop_reason: 'tool_use',
            },
          },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
            },
          }
        )
      )
      await run.hook(HRCDEV_IDLE_PROMPT)

      expect(run.ofType('diagnostic')).toHaveLength(1)
      expect(run.ofType('tool.call.completed')).toHaveLength(1)
      expect(terminals(run.events)).toEqual([])
    })
  })

  test('control: a recovered turn whose only later evidence is an assistant prose row stays open', async () => {
    await withRun(async (run) => {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      appendFileSync(
        run.transcriptPath,
        rows(API_ERROR_ROW, {
          type: 'assistant',
          message: { id: 'msg_retry', content: [{ type: 'text', text: 'working' }] },
        })
      )
      await run.hook(HRCDEV_IDLE_PROMPT)

      expect(terminals(run.events)).toEqual([])
    })
  })

  test('control: permission_prompt on an API-error turn gets no terminal', async () => {
    await withRun(async (run) => {
      await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: HRCDEV_PROMPT })
      appendFileSync(run.transcriptPath, HRCDEV_ROWS)
      await run.hook({
        ...HRCDEV_IDLE_PROMPT,
        message: 'Claude needs your permission to use Bash',
        notification_type: 'permission_prompt',
      })

      expect(run.ofType('diagnostic')).toHaveLength(1)
      expect(terminals(run.events)).toEqual([])
    })
  })
})
