import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { createCaptureGate } from '../../../src/capture/capture-gate'
import { openCaptureIndex } from '../../../src/capture/capture-index'
import { createRawJournal } from '../../../src/capture/raw-journal'
import { inputIdFrom } from '../../ids'
import type { HookEnvelope, TmuxExecCall } from './driver-red.helpers'
import {
  claudeTmuxSpec,
  createCtx,
  createRecordingExec,
  defaultLease,
  loadFactory,
  now,
} from './driver-red.helpers'

describe('claude-code-tmux driver RED lifecycle', () => {
  test('a continuation-backed start excludes historical transcript assistant rows', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-resume-transcript-driver-'))
    const transcriptPath = join(root, 'session.jsonl')
    const assistantRow = (id: string, text: string): string =>
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id,
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        },
      })}\n`
    writeFileSync(transcriptPath, assistantRow('msg_historical', 'historical answer'))
    const hookSocket = join(root, 'claude-hooks.sock')
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
    const spec = claudeTmuxSpec()
    spec.continuation = { provider: 'anthropic', kind: 'session', key: 'session-existing' }

    try {
      await driver.start(spec, createCtx(events, { terminalSurface: defaultLease() }))
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      appendFileSync(transcriptPath, assistantRow('msg_current', 'current answer'))
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_resumed',
        hookData: { hook_event_name: 'Stop' },
      })

      expect(
        events
          .filter((event) => event.type === 'assistant.message.completed')
          .map((event) => (event.payload as { content: Array<{ text: string }> }).content[0]?.text)
      ).toEqual(['current answer'])
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('applyInputNow correlation id opens on a user row but is never opened for absorption', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-disposition-driver-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
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

    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_live',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'base turn' },
      })

      const applied = await driver.applyInputNow({
        inputId: inputIdFrom('input_absorbed'),
        kind: 'user',
        content: [{ type: 'text', text: 'broker steer' }],
      })
      appendFileSync(
        transcriptPath,
        `${[
          { type: 'queue-operation', operation: 'enqueue', content: 'broker steer' },
          { type: 'queue-operation', operation: 'remove', content: 'broker steer' },
          { type: 'attachment', attachment: { type: 'queued_command', prompt: 'broker steer' } },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'broker steer' },
      })

      expect(
        events.some((event) => event.type === 'turn.started' && event.turnId === applied.turnId)
      ).toBe(false)
      expect(events.find((event) => event.type === 'submission.absorbed')).toMatchObject({
        turnId: 'turn_live',
        inputId: 'input_absorbed',
        payload: { submissionId: 'input_absorbed', turnId: 'turn_live' },
      })

      await driver.applyInputNow({
        inputId: inputIdFrom('input_removed'),
        kind: 'user',
        content: [{ type: 'text', text: 'removed without attachment' }],
      })
      appendFileSync(
        transcriptPath,
        `${[
          { type: 'queue-operation', operation: 'enqueue', content: 'removed without attachment' },
          { type: 'queue-operation', operation: 'remove', content: 'removed without attachment' },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )

      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'Stop' },
      })
      expect(
        events.some(
          (event) => event.type === 'submission.cancelled' && event.inputId === 'input_removed'
        )
      ).toBe(false)
      expect(events.find((event) => event.type === 'capture.warning')).toMatchObject({
        driver: { kind: 'claude-code-tmux', rawType: 'Stop' },
        payload: {
          message:
            'Claude queue remove reached a disposition boundary without queued_command evidence',
        },
      })
      const idle = await driver.applyInputNow({
        inputId: inputIdFrom('input_executed'),
        kind: 'user',
        content: [{ type: 'text', text: 'idle own turn' }],
      })
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'idle own turn' } })}\n`
      )
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'idle own turn' },
      })
      expect(
        events.find(
          (event) => event.type === 'submission.executed' && event.inputId === 'input_executed'
        )
      ).toMatchObject({
        turnId: idle.turnId,
        inputId: 'input_executed',
        payload: { submissionId: 'input_executed', turnId: idle.turnId },
      })
      expect(
        events.filter((event) => event.type === 'turn.started' && event.turnId === idle.turnId)
      ).toHaveLength(1)
      // T-07873 / EN-02688 guard. HRC resolves a hook-observed turn to its run
      // from the ENVELOPE-level inputId — `resolveRunIdForEvent` reads
      // `envelope.inputId` and looks the run up by it. A `turn.started` that
      // carries the id only in its PAYLOAD binds to no run, so `runs.started_at`
      // is never stamped, no auto-reply intent is minted, the envelope stays
      // presented and the sender's `--wait` hangs. The metadata spread is
      // therefore load-bearing, not decoration: assert it at the envelope level
      // and not merely inside the payload.
      expect(
        events.find((event) => event.type === 'turn.started' && event.turnId === idle.turnId)
      ).toMatchObject({
        turnId: idle.turnId,
        inputId: 'input_executed',
        payload: { source: 'hook-observed', inputId: 'input_executed' },
      })
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a blocked Stop hook writes feedback as a user row that must NOT halt the cursor', async () => {
    // Reproduced on the PREVIOUS release before being fixed here: when the
    // broker blocks a Stop decision (the structured-output retry), Claude
    // writes the reason back as an ordinary `type:'user'` row with string
    // content while the turn is still active. Routed to the disposition mirror
    // that is "a plain user row arrived while a turn is active" — a
    // load-bearing anomaly, which HALTS the cursor and stalls the invocation.
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-stop-feedback-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
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

    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_structured',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'return a number' },
      })
      appendFileSync(
        transcriptPath,
        `${[
          {
            type: 'user',
            message: {
              role: 'user',
              content: 'Stop hook feedback:\n/ must be valid JSON matching schema',
            },
          },
          {
            type: 'attachment',
            attachment: {
              type: 'hook_blocking_error',
              hookName: 'Stop',
              hookEvent: 'Stop',
              blockingError: { blockingError: '/ must be valid JSON matching schema' },
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      const before = events.length
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'Notification', message: 'after feedback' },
      })

      const captured = events.slice(before)
      expect(captured.filter((event) => event.type === 'capture.warning')).toEqual([])
      // And it is not mistaken for an operator prompt either.
      expect(captured.map((event) => event.type)).not.toContain('user.message')
      expect(captured.map((event) => event.type)).not.toContain('turn.started')
    } finally {
      await driver.dispose().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  // T-10332: both doors into a compaction, rows in the order Claude Code 2.1.289
  // appended them (idle auto-compaction on rt-b77e9114; typed `/compact` on the
  // fresh probe seat rt-15d64e71).
  const compactBoundary = {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 257556, postTokens: 9353 },
  }
  const compactSummary = {
    type: 'user',
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    message: {
      role: 'user',
      content:
        'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. ...',
    },
  }
  const userRow = (content: string, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    ...extra,
    message: { role: 'user', content },
  })
  const compactionDoors: Array<[string, Array<Record<string, unknown>>]> = [
    ['idle auto-compaction', [compactBoundary, compactSummary]],
    [
      'typed /compact',
      [
        userRow('/compact'),
        compactBoundary,
        compactSummary,
        userRow(
          "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context.</local-command-caveat>",
          { isMeta: true }
        ),
        userRow(
          '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>'
        ),
        userRow(
          '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'
        ),
      ],
    ],
  ]

  test.each(compactionDoors)(
    '%s mints no turn and the seat stays idle (T-10332)',
    async (_door, rows) => {
      // Reproduced live on rt-b77e9114 (2026-10-05 17:39:31Z): Claude Code's
      // idle compaction ("Compacted while idle") writes a compact_boundary system
      // row and then a `type:'user'` row carrying the summary, flagged
      // `isCompactSummary`. Routed as an operator prompt it minted
      // submission.executed + turn.started, and no Stop hook ever follows a
      // compaction, so the seat sat at busy for hours at an idle prompt.
      const createDriver = await loadFactory()
      const tmuxCalls: TmuxExecCall[] = []
      let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
      const events: InvocationEventEnvelope[] = []
      const root = mkdtempSync(join(tmpdir(), 'claude-idle-compact-'))
      const transcriptPath = join(root, 'session.jsonl')
      writeFileSync(transcriptPath, '')
      const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
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
      const hook = (hookData: Record<string, unknown>, turnId?: string) =>
        hookHandler?.({
          invocationId: 'inv_claude_tmux_1',
          generation: 1,
          callbackSocket: hookSocket,
          ...(turnId !== undefined ? { turnId } : {}),
          hookData,
        })

      try {
        await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
        await hook({ hook_event_name: 'SessionStart', transcript_path: transcriptPath })
        await hook({
          hook_event_name: 'SessionStart',
          source: 'compact',
          transcript_path: transcriptPath,
        })
        appendFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
        const before = events.length
        await hook({ hook_event_name: 'Notification', message: 'after compaction' })

        const types = events.slice(before).map((event) => event.type)
        expect(types).not.toContain('turn.started')
        expect(types).not.toContain('submission.executed')
        expect(types).not.toContain('user.message')
        expect(events.map((event) => event.type)).not.toContain('turn.started')

        // An ordinary turn after the compaction still brackets busy -> idle.
        await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'what next?' }, 'turn_after')
        appendFileSync(
          transcriptPath,
          `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'what next?' } })}\n`
        )
        await hook({ hook_event_name: 'Stop', last_assistant_message: 'done' }, 'turn_after')
        const after = events.map((event) => event.type)
        expect(after.filter((type) => type === 'turn.started')).toHaveLength(1)
        expect(after.filter((type) => type === 'turn.completed')).toHaveLength(1)
      } finally {
        await driver.dispose().catch(() => undefined)
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  test('a plain user row mid-turn warns loudly and the turn still completes (T-07883)', async () => {
    // The exact shape that stalled three real seats overnight: a HUMAN typing
    // into the seat's pane (or a `wrkc` resend landing) while a turn is active
    // writes an ordinary `user` row the disposition mirror cannot attribute.
    // That is a load-bearing anomaly and it must stay loud — but under the halt
    // it stopped the invocation's cursor, so the turn's own `turn.completed`
    // never reached the stream and HRC saw the seat busy forever.
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const logged: string[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-plain-user-mid-turn-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
    const index = openCaptureIndex(join(root, 'capture.db'))
    const ctx = createCtx(events, { terminalSurface: defaultLease() })
    const capture = createCaptureGate({
      invocationId: 'inv_claude_tmux_1' as InvocationId,
      journal: createRawJournal({
        invocationId: 'inv_claude_tmux_1' as InvocationId,
        dir: join(root, 'journal'),
      }),
      index,
      normalizer: { name: 'claude-code-tmux', version: 'test' },
      now,
      emitWarning: (payload) => ctx.emit('capture.warning', payload).seq,
      warn: (line) => void logged.push(line),
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

    try {
      await driver.start(claudeTmuxSpec(), ctx)
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_active',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'a long running turn' },
      })

      // Someone types into the pane while the turn is running.
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'typed into the pane mid-turn' },
        })}\n`
      )
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'Notification', message: 'reading the transcript' },
      })

      // (a) It is still reported, at the loudest level, on both surfaces.
      const warning = events.find((event) => event.type === 'capture.warning')
      expect(warning?.payload).toMatchObject({
        kind: 'blocked_unknown',
        message: 'Claude plain user row arrived while a turn is active',
      })
      expect(
        (warning?.payload as { raw: { family: string; loadBearing: boolean } }).raw
      ).toMatchObject({ family: 'submission-disposition', loadBearing: true, cursorHalted: false })
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('WARN harness-broker capture blocked_unknown')
      expect(logged[0]).toContain('driver=claude-code-tmux')
      expect(logged[0]).toContain('family=submission-disposition')
      expect(logged[0]).toContain('message=Claude plain user row arrived while a turn is active')

      // (b) The turn's own terminal still reaches the envelope stream — the
      // thing the halt cost. Under the halt this Stop hook was DEFERRED behind
      // the blocked record and no turn.completed was ever emitted.
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_active',
        hookData: { hook_event_name: 'Stop' },
      })
      expect(
        events.filter((event) => event.type === 'turn.completed' && event.turnId === 'turn_active')
      ).toHaveLength(1)

      // (c) Capture never left `open`, and every raw record still reached a
      // durable disposition — evidence is not what was traded away.
      expect(capture.state()).toMatchObject({ state: 'open', deferredCount: 0 })
      expect(capture.state().blockedOn).toBeUndefined()
      expect(
        index.list('inv_claude_tmux_1').filter((row) => row.disposition === 'pending')
      ).toEqual([])
    } finally {
      index.close()
      await driver.dispose().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('transcript interrupt terminalizes the original before a dequeue-promoted successor', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-interrupt-driver-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
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

    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_original',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'long turn' },
      })
      appendFileSync(
        transcriptPath,
        `${[
          { type: 'queue-operation', operation: 'enqueue', content: 'CHARLIE' },
          { type: 'queue-operation', operation: 'dequeue' },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: '[Request interrupted by user]' }],
            },
          },
          { type: 'user', message: { role: 'user', content: 'CHARLIE' } },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      const before = events.length
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'Notification', message: 'after promotion' },
      })

      const captured = events.slice(before)
      expect(captured.map((event) => event.type).slice(0, 4)).toEqual([
        'turn.interrupted',
        'turn.started',
        'user.message',
        'submission.executed',
      ])
      expect(captured[0]).toMatchObject({ turnId: 'turn_original' })
      expect(captured[1]?.turnId).not.toBe('turn_original')
      expect(captured.at(-1)).toMatchObject({
        type: 'driver.notice',
        turnId: captured[1]?.turnId,
      })
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('stop() drains a trailing API-error transcript row as a diagnostic carrying the active turn id', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })

    const root = mkdtempSync(join(tmpdir(), 'claude-stop-drain-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')

    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))

      // SessionStart points the transcript reader at our file; UserPromptSubmit
      // makes turn_drain_1 the active turn (and reads the still-empty transcript).
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
        turnId: 'turn_drain_1',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      })

      // The API error lands AFTER the last hook — only the stop() drain can surface it.
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          isApiErrorMessage: true,
          requestId: 'req_drain',
          error: 'unknown',
          message: { content: [{ type: 'text', text: 'API Error: Internal server error' }] },
        })}\n`
      )

      const before = events.length
      expect(await driver.stop({} as never)).toEqual({ accepted: true, state: 'exited' })

      const drained = events.slice(before).filter((event) => event.type === 'diagnostic')
      expect(drained).toHaveLength(1)
      const diag = drained[0]!
      expect(diag.payload).toMatchObject({ level: 'error', source: 'harness' })
      expect((diag.payload as { data?: Record<string, unknown> }).data).toMatchObject({
        code: 'api_error',
        rawType: 'assistant',
        isApiErrorMessage: true,
        requestId: 'req_drain',
      })
      expect((diag.payload as { message?: string }).message).toBe(
        'API Error: Internal server error'
      )
      // Drained before reset/turn-id loss → it still carries the active turn id.
      expect<string | undefined>(diag.turnId).toBe('turn_drain_1')
      expect(diag.driver).toEqual({ kind: 'claude-code-tmux', rawType: 'assistant' })
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('same-turn API error diagnostic is followed by an attributed failed terminal on Stop', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return {
            socketPath: '/tmp/harness-broker/claude-hooks.sock',
            close: async () => undefined,
          }
        },
      },
      now,
    })

    const root = mkdtempSync(join(tmpdir(), 'claude-api-error-terminal-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')

    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
        turnId: 'turn_api_error_1',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      })
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          isApiErrorMessage: true,
          status: 529,
          requestId: 'req_terminal',
          error: 'overloaded_error',
          message: { content: [{ type: 'text', text: 'API Error: Overloaded' }] },
        })}\n`
      )

      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: '/tmp/harness-broker/claude-hooks.sock',
        turnId: 'turn_api_error_1',
        hookData: { hook_event_name: 'Stop' },
      })

      const sameTurn = events.filter((event) => event.turnId === 'turn_api_error_1')
      expect(sameTurn.map((event) => event.type)).toContain('diagnostic')
      expect(sameTurn.map((event) => event.type)).not.toContain('turn.completed')
      expect(sameTurn.find((event) => event.type === 'turn.failed')).toMatchObject({
        payload: {
          turnId: 'turn_api_error_1',
          status: 'failed',
          code: 'provider_api_error',
          message: expect.stringContaining('provider API error'),
        },
        driver: { kind: 'claude-code-tmux', rawType: 'Stop' },
      })
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
