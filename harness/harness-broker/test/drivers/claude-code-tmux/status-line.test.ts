import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  InvocationEventEnvelope,
  InvocationId,
  RawProviderRecord,
} from 'spaces-harness-broker-protocol'
import { type CaptureGate, createCaptureGate } from '../../../src/capture/capture-gate'
import { openCaptureIndex } from '../../../src/capture/capture-index'
import { createRawJournal } from '../../../src/capture/raw-journal'
import { createClaudeCodeTmuxDriver } from '../../../src/drivers/claude-code-tmux/driver'
import { listenForHookEnvelopes } from '../../../src/drivers/tmux-shared'
import type { HookEnvelope, TmuxExecCall } from './driver-red.helpers'
import {
  claudeTmuxSpec,
  createCtx,
  createRecordingExec,
  defaultLease,
  loadFactory,
  now,
  pastedTexts,
  removeTempHookDirs,
  tempHookSocketPath,
  waitFor,
} from './driver-red.helpers'

afterEach(removeTempHookDirs)

/**
 * T-10929: Claude Code's statusline input is the ONE source of the Claude
 * context reading. The fixture is two REAL renders from Claude Code 2.1.299
 * (`--model opus`): the startup render (`current_usage: null`) and the render
 * after a one-word reply. The transcript assistant row of that same model call
 * carried input 2 + cache writes 24121 + cache reads 25387 + output 4.
 */
const FIXTURE = join(import.meta.dir, '../../fixtures/claude-statusline/claude-code-2.1.299.ndjson')
const [STARTUP, AFTER_TURN] = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>) as [
  Record<string, unknown>,
  Record<string, unknown>,
]
const AFTER_TURN_USED = 2 + 24_121 + 25_387 + 4

const PACKAGE_ROOT = join(import.meta.dir, '../../..')
const REPO_ROOT = join(PACKAGE_ROOT, '../..')
const STATUSLINE_SH = join(REPO_ROOT, 'drivers/harness-claude/assets/statusline.sh')
const BRIDGE_BIN = join(PACKAGE_ROOT, 'bin/harness-broker.js')

function withUsage(
  base: Record<string, unknown>,
  patch: { used?: number; window?: number; model?: string }
): Record<string, unknown> {
  const cw = base['context_window'] as Record<string, unknown>
  const usage = cw['current_usage'] as Record<string, number>
  return {
    ...base,
    model: { ...(base['model'] as object), ...(patch.model ? { id: patch.model } : {}) },
    context_window: {
      ...cw,
      ...(patch.window !== undefined ? { context_window_size: patch.window } : {}),
      current_usage:
        patch.used !== undefined
          ? {
              ...usage,
              cache_read_input_tokens: (usage['cache_read_input_tokens'] ?? 0) + patch.used,
            }
          : usage,
    },
  }
}

describe('Claude statusline reading (T-10929)', () => {
  /** Run StatusLine records through a fresh captured driver; return its usage.updated payloads. */
  async function usageReadings(records: Record<string, unknown>[]): Promise<UsageReading[]> {
    const root = mkdtempSync(join(tmpdir(), 'claude-statusline-reading-'))
    const live = await startCapturedDriver(root, 'reading')
    try {
      for (const record of records) await live.hook(statusLine(record))
      return live.events
        .filter((event) => event.type === 'usage.updated')
        .map((event) => event.payload as UsageReading)
    } finally {
      await live.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('a StatusLine record mints a usage reading only when fill, window or model changes', async () => {
    const readings = await usageReadings([
      // Startup render: the window is known but there is no fill yet.
      STARTUP,
      AFTER_TURN,
      // Re-renders with the same reading are state-only.
      AFTER_TURN,
      { ...AFTER_TURN, cost: { total_cost_usd: 9 } },
      // Any of the three keys changing is a new reading.
      withUsage(AFTER_TURN, { used: 10 }),
      withUsage(AFTER_TURN, { used: 10, window: 200_000 }),
      withUsage(AFTER_TURN, { used: 10, window: 200_000, model: 'claude-x' }),
    ])

    expect(readings[0]).toEqual({
      usage: AFTER_TURN['context_window'],
      model: { id: 'claude-opus-5-5', source: 'provider-response' },
      context: { usedTokens: AFTER_TURN_USED, windowTokens: 1_000_000 },
    })
    expect(readings.map((reading) => [reading.model?.id, reading.context])).toEqual([
      ['claude-opus-5-5', { usedTokens: AFTER_TURN_USED, windowTokens: 1_000_000 }],
      ['claude-opus-5-5', { usedTokens: AFTER_TURN_USED + 10, windowTokens: 1_000_000 }],
      ['claude-opus-5-5', { usedTokens: AFTER_TURN_USED + 10, windowTokens: 200_000 }],
      ['claude-x', { usedTokens: AFTER_TURN_USED + 10, windowTokens: 200_000 }],
    ])
  })

  test('a [1m] StatusLine model mints the base model id and leaves the raw usage verbatim', async () => {
    const variant: Record<string, unknown> = {
      ...AFTER_TURN,
      model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5' },
    }
    const before = JSON.stringify(variant)
    const readings = await usageReadings([
      variant,
      // Only a TRAILING bracketed variant is dropped.
      { ...AFTER_TURN, model: { id: 'claude-x[a]-1' } },
    ])

    expect(readings[0]?.model).toEqual({ id: 'claude-opus-5-5', source: 'provider-response' })
    expect(readings[0]?.usage).toEqual(variant['context_window'])
    expect(JSON.stringify(variant)).toBe(before)
    expect(readings[1]?.model?.id).toBe('claude-x[a]-1')
  })

  test('a StatusLine with a malformed fill mints nothing; one missing the window still mints the fill', async () => {
    const cw = AFTER_TURN['context_window'] as Record<string, unknown>
    const readings = await usageReadings([
      { context_window: { current_usage: { input_tokens: 1 } } },
      { context_window: { current_usage: cw['current_usage'] } },
    ])

    expect(readings).toEqual([
      {
        usage: { current_usage: cw['current_usage'] },
        context: { usedTokens: AFTER_TURN_USED },
      },
    ])
  })
})

type UsageReading = {
  usage?: unknown
  model?: { id: string; source: string } | undefined
  context?: { usedTokens: number; windowTokens?: number } | undefined
}

type Harness = {
  events: InvocationEventEnvelope[]
  capture: CaptureGate
  transcript: string
  hook: (
    envelope: Omit<HookEnvelope, 'invocationId' | 'generation' | 'callbackSocket'>
  ) => Promise<void>
  close: () => Promise<void>
}

async function startCapturedDriver(root: string, name: string): Promise<Harness> {
  const createDriver = await loadFactory()
  const tmuxCalls: TmuxExecCall[] = []
  const events: InvocationEventEnvelope[] = []
  let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
  const hookSocket = tempHookSocketPath()
  const transcript = join(root, `${name}.jsonl`)
  writeFileSync(transcript, '')
  const index = openCaptureIndex(join(root, `${name}.db`))
  const ctx = createCtx(events, { terminalSurface: defaultLease() })
  const capture = createCaptureGate({
    invocationId: 'inv_claude_tmux_1' as InvocationId,
    journal: createRawJournal({
      invocationId: 'inv_claude_tmux_1' as InvocationId,
      dir: join(root, `${name}-journal`),
    }),
    index,
    normalizer: { name: 'claude-code-tmux', version: 'test' },
    now,
    emitWarning: (payload) => ctx.emit('capture.warning', payload).seq,
    warn: () => undefined,
  })
  ctx.capture = capture
  const driver = createDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
    hooks: {
      listen: async (handler) => {
        hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
        return { socketPath: hookSocket, close: async () => undefined }
      },
    },
    now,
  })
  await driver.start(claudeTmuxSpec(), ctx)
  return {
    events,
    capture,
    transcript,
    hook: async (envelope) => {
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        ...envelope,
      } as HookEnvelope)
    },
    close: async () => {
      index.close()
      await driver.dispose().catch(() => undefined)
    },
  }
}

const statusLine = (raw: Record<string, unknown>) => ({
  hookEventName: 'StatusLine',
  hookData: raw,
})

function contexts(events: InvocationEventEnvelope[]): unknown[] {
  return events
    .filter((event) => event.type === 'usage.updated')
    .map((event) => (event.payload as { context?: unknown }).context)
    .filter((context) => context !== undefined)
}

describe('claude-code-tmux StatusLine records (T-10929)', () => {
  test('commits the statusline JSON verbatim, mints only on change, transcript rows claim no context, and replay reproduces the readings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-statusline-'))
    const live = await startCapturedDriver(root, 'live')
    try {
      await live.hook({
        hookData: { hook_event_name: 'SessionStart', transcript_path: live.transcript },
      })
      await live.hook(statusLine(STARTUP))
      await live.hook({
        turnId: 'turn_1',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'reply with pong' },
      })
      // The transcript row of the same model call: it keeps raw usage + model
      // but no longer carries a context reading.
      appendFileSync(
        live.transcript,
        `${JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: 'pong' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 24_121,
              cache_read_input_tokens: 25_387,
              output_tokens: 4,
            },
          },
        })}\n`
      )
      await live.hook({ turnId: 'turn_1', hookData: { hook_event_name: 'Stop' } })
      await live.hook(statusLine(AFTER_TURN))
      await live.hook(statusLine(AFTER_TURN))
      await live.hook(statusLine(withUsage(AFTER_TURN, { used: 7, window: 200_000 })))

      const transcriptUsage = live.events.filter(
        (event) =>
          event.type === 'usage.updated' &&
          (event.driver as { rawType?: string } | undefined)?.rawType === 'transcript.assistant'
      )
      expect(transcriptUsage).toHaveLength(1)
      expect((transcriptUsage[0]?.payload as { context?: unknown }).context).toBeUndefined()

      const liveContexts = contexts(live.events)
      expect(liveContexts).toEqual([
        { usedTokens: AFTER_TURN_USED, windowTokens: 1_000_000 },
        { usedTokens: AFTER_TURN_USED + 7, windowTokens: 200_000 },
      ])

      // Committed verbatim as StatusLine records, with their dispositions.
      const records: RawProviderRecord[] = live.capture.records()
      const statusRecords = records.filter((record) => record.nativeType === 'StatusLine')
      expect(statusRecords).toHaveLength(4)
      expect(Buffer.from(statusRecords[0]?.rawBytes ?? []).toString('utf8')).toBe(
        JSON.stringify(STARTUP)
      )
      const index = openCaptureIndex(join(root, 'live.db'))
      try {
        expect(
          statusRecords.map(
            (record) =>
              index.list('inv_claude_tmux_1').find((row) => row.rawRecordId === record.rawRecordId)
                ?.disposition
          )
        ).toEqual(['state-only', 'normalized', 'state-only', 'normalized'])
      } finally {
        index.close()
      }

      // Replay: drive the committed hook records, in commit order, through a
      // fresh driver. The StatusLine readings depend only on earlier StatusLine
      // records, so the same readings come out.
      const replay = await startCapturedDriver(root, 'replay')
      try {
        for (const record of records) {
          if (record.sourceKind !== 'hook') continue
          const hookData = JSON.parse(Buffer.from(record.rawBytes).toString('utf8')) as Record<
            string,
            unknown
          >
          await replay.hook(
            record.nativeType === 'StatusLine'
              ? statusLine(hookData)
              : { hookData: { ...hookData, transcript_path: replay.transcript } }
          )
        }
        expect(contexts(replay.events)).toEqual(liveContexts)
      } finally {
        await replay.close()
      }
    } finally {
      await live.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function runStatusline(
  input: string,
  env: Record<string, string | undefined>
): { stdout: string; status: number | null } {
  const result = spawnSync('bash', [STATUSLINE_SH], {
    input,
    env: { PATH: process.env['PATH'], ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
  return { stdout: result.stdout, status: result.status }
}

describe('statusline.sh (T-10929)', () => {
  test('renders byte-identically with the bridge env unset, failing, or posting', () => {
    for (const fixture of [STARTUP, AFTER_TURN]) {
      const input = JSON.stringify(fixture)
      const unset = runStatusline(input, {})
      expect(unset.status).toBe(0)
      expect(unset.stdout.length).toBeGreaterThan(0)
      for (const bridge of [
        'false',
        'exit 7',
        `bun ${BRIDGE_BIN} claude-hook --socket /nonexistent/sock --event StatusLine`,
        'echo NOISE; echo NOISE >&2',
      ]) {
        expect(runStatusline(input, { HARNESS_BROKER_STATUSLINE_BRIDGE: bridge })).toEqual(unset)
      }
    }
    expect(runStatusline(JSON.stringify(AFTER_TURN), {}).stdout).toContain('49K/1000K')
  })

  test('end to end: real statusline.sh → real bridge CLI → broker socket → usage.updated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-statusline-e2e-'))
    const tmuxCalls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    const driver = createClaudeCodeTmuxDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: (handler) => listenForHookEnvelopes(join(root, 'claude-hooks.sock'), handler),
        bridgeCommand: `bun ${BRIDGE_BIN} claude-hook`,
      },
      now,
    })
    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
      const launchFile = pastedTexts(tmuxCalls)
        .map((text) => text.match(/--launch-file (\S+)/)?.[1])
        .find((path) => path !== undefined)
      const launch = JSON.parse(readFileSync(launchFile ?? '', 'utf8')) as {
        env: Record<string, string>
      }
      expect(launch.env['HARNESS_BROKER_STATUSLINE_BRIDGE']).toBe(
        `bun ${BRIDGE_BIN} claude-hook --socket ${join(root, 'claude-hooks.sock')} --event StatusLine`
      )

      // Claude runs the statusline with its own (launch) env.
      const rendered = runStatusline(JSON.stringify(AFTER_TURN), launch.env)
      expect(rendered).toEqual(runStatusline(JSON.stringify(AFTER_TURN), {}))

      await waitFor(() => contexts(events).length > 0, 'StatusLine usage.updated', 15_000)
      const minted = events.find((event) => event.type === 'usage.updated')
      expect(minted?.payload).toEqual({
        usage: AFTER_TURN['context_window'],
        model: { id: 'claude-opus-5-5', source: 'provider-response' },
        context: { usedTokens: AFTER_TURN_USED, windowTokens: 1_000_000 },
      })
      expect((minted?.driver as { rawType?: string } | undefined)?.rawType).toBe('StatusLine')
    } finally {
      await driver.dispose().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
