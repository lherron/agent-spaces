import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { createCaptureGate } from '../../../src/capture/capture-gate'
import { openCaptureIndex } from '../../../src/capture/capture-index'
import { createRawJournal } from '../../../src/capture/raw-journal'
import type { HookEnvelope, TmuxExecCall } from './driver-red.helpers'
import {
  claudeTmuxSpec,
  createCtx,
  createRecordingExec,
  defaultLease,
  loadFactory,
  now,
  waitFor,
} from './driver-red.helpers'

describe('claude-code-tmux driver RED lifecycle', () => {
  test('native transcript notifications terminalize the 7ec78cf3 no-successor interrupt and re-arm on retarget', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-watch-driver-'))
    const firstTranscript = join(root, 'first.jsonl')
    const secondTranscript = join(root, 'second.jsonl')
    writeFileSync(secondTranscript, '')
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
    const watchers: Array<EventEmitter & { close: () => void }> = []
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return { socketPath: hookSocket, close: async () => undefined }
        },
      },
      watchTranscript: (_path, _options, listener) => {
        const watcher = new EventEmitter() as EventEmitter & { close: () => void }
        watcher.close = () => watcher.removeAllListeners()
        watcher.on('change', listener)
        watchers.push(watcher)
        return watcher
      },
      now,
    })

    const sessionStart = async (transcriptPath: string): Promise<void> => {
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      })
    }

    try {
      await driver.start(claudeTmuxSpec(), createCtx(events, { terminalSurface: defaultLease() }))
      await sessionStart(firstTranscript)
      // MTJE0CA6: SessionStart names the eventual path before Claude creates
      // it. Absence is an expected lazy-arm state, never a warning.
      expect(events.filter((event) => event.type === 'capture.warning')).toHaveLength(0)
      expect(watchers).toHaveLength(0)
      writeFileSync(firstTranscript, '')
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_7ec78cf3',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'long tool turn' },
      })
      expect(watchers).toHaveLength(1)

      // Exact native SHAPES from 7ec78cf3 rows 153-154: Claude writes the
      // rejected tool result and interrupt marker after PreToolUse, then emits
      // no later hook. Deliver the file-change notification explicitly so the
      // test exercises that intake without depending on OS watcher scheduling.
      appendFileSync(
        firstTranscript,
        `${[
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  content: "The user doesn't want to proceed with this tool use.",
                  is_error: true,
                  tool_use_id: 'toolu_01Wr3CsAAaPMBXheFrCayDnk',
                },
              ],
            },
            toolUseResult: 'User rejected tool use',
          },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
            },
            interruptedMessageId: 'msg_011CedfqB7G8pdha5Em52eVk',
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      watchers[0]?.emit('change')

      await waitFor(
        () =>
          events.some(
            (event) => event.type === 'turn.interrupted' && event.turnId === 'turn_7ec78cf3'
          ),
        'watcher-observed interrupt terminal'
      )

      const preempt = await driver.applyInputNow({
        inputId: 'input_preempt_after_watch',
        kind: 'user',
        content: [{ type: 'text', text: 'preempt after watch' }],
      })
      appendFileSync(
        firstTranscript,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'preempt after watch' } })}\n`
      )
      watchers[0]?.emit('change')
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'submission.executed' && event.inputId === 'input_preempt_after_watch'
          ),
        'watcher-observed preempt execution'
      )
      expect(
        events.filter(
          (event) =>
            event.type === 'submission.executed' && event.inputId === 'input_preempt_after_watch'
        )
      ).toHaveLength(1)
      expect(preempt.turnId).toBeDefined()
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: preempt.turnId,
        hookData: { hook_event_name: 'Stop' },
      })

      // Race a native notification against a hook read. Both enqueue onto the
      // same drain chain; the byte-offset tailer must normalize this row once.
      const raced = await driver.applyInputNow({
        inputId: 'input_watch_hook_race',
        kind: 'user',
        content: [{ type: 'text', text: 'watch hook race' }],
      })
      appendFileSync(
        firstTranscript,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'watch hook race' } })}\n`
      )
      watchers[0]?.emit('change')
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'Notification', message: 'concurrent drain' },
      })
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'submission.executed' && event.inputId === 'input_watch_hook_race'
          ),
        'serialized watcher and hook drain'
      )
      expect(
        events.filter((event) => event.type === 'turn.started' && event.turnId === raced.turnId)
      ).toHaveLength(1)
      expect(
        events.filter(
          (event) => event.type === 'user.message' && event.inputId === 'input_watch_hook_race'
        )
      ).toHaveLength(1)
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: raced.turnId,
        hookData: { hook_event_name: 'Stop' },
      })

      await sessionStart(secondTranscript)
      expect(watchers).toHaveLength(2)
      const retargeted = await driver.applyInputNow({
        inputId: 'input_retargeted_watch',
        kind: 'user',
        content: [{ type: 'text', text: 'retargeted watch' }],
      })
      appendFileSync(
        secondTranscript,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'retargeted watch' } })}\n`
      )
      watchers[1]?.emit('change')
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === 'submission.executed' && event.inputId === 'input_retargeted_watch'
          ),
        'retargeted transcript watcher'
      )
      expect(
        events.filter(
          (event) => event.type === 'turn.started' && event.turnId === retargeted.turnId
        )
      ).toHaveLength(1)
      expect(events.filter((event) => event.type === 'capture.warning')).toHaveLength(0)
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('watcher error re-arms once and drains rows appended during the gap', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-watch-rearm-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const watchers: Array<EventEmitter & { close: () => void }> = []
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return { socketPath: hookSocket, close: async () => undefined }
        },
      },
      watchTranscript: (_path, _options, _listener) => {
        const watcher = new EventEmitter() as EventEmitter & { close: () => void }
        watcher.close = () => undefined
        watchers.push(watcher)
        return watcher
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
        turnId: 'turn_rearm_gap',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'rearm gap' },
      })
      expect(watchers).toHaveLength(1)

      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }],
          },
        })}\n`
      )
      watchers[0]?.emit('error', new Error('injected watcher loss'))

      await waitFor(
        () =>
          events.some(
            (event) => event.type === 'turn.interrupted' && event.turnId === 'turn_rearm_gap'
          ),
        're-arm gap drain'
      )
      expect(watchers).toHaveLength(2)
      expect(events.filter((event) => event.type === 'capture.warning')).toHaveLength(0)
      expect(driver.runtimeHealth()).toEqual({ state: 'healthy' })
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('watcher re-arm failure degrades once and refuses preempt/interrupt typed', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-watch-degraded-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const watchers: Array<EventEmitter & { close: () => void }> = []
    const hookSocket = '/tmp/harness-broker/claude-hooks.sock'
    let watchCalls = 0
    const driver = createDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: HookEnvelope) => Promise<void>
          return { socketPath: hookSocket, close: async () => undefined }
        },
      },
      watchTranscript: (_path, _options, _listener) => {
        watchCalls += 1
        if (watchCalls === 2) throw new Error('injected re-arm failure')
        const watcher = new EventEmitter() as EventEmitter & { close: () => void }
        watcher.close = () => undefined
        watchers.push(watcher)
        return watcher
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
      expect(watchers).toHaveLength(1)
      watchers[0]?.emit('error', new Error('injected watcher loss'))

      expect(events.filter((event) => event.type === 'capture.warning')).toHaveLength(1)
      expect(events.find((event) => event.type === 'capture.warning')?.payload).toMatchObject({
        kind: 'native_wakeup_lost',
      })
      expect(driver.runtimeHealth()).toEqual({
        state: 'degraded',
        reason: 'native_wakeup_lost',
      })
      expect(driver.admissionRejectionReason('preempt')).toBe('native_wakeup_lost')
      expect(driver.admissionRejectionReason('exclusive')).toBeUndefined()
      expect(await driver.interrupt({ scope: 'turn' })).toEqual({
        accepted: false,
        effect: 'unsupported',
        reason: 'native_wakeup_lost',
      })
    } finally {
      await driver.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Stop hook_cancelled plus adjacent late marker is ignored-known after completion', async () => {
    const createDriver = await loadFactory()
    const tmuxCalls: TmuxExecCall[] = []
    let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
    const events: InvocationEventEnvelope[] = []
    const root = mkdtempSync(join(tmpdir(), 'claude-stop-cancelled-driver-'))
    const transcriptPath = join(root, 'session.jsonl')
    writeFileSync(transcriptPath, '')
    const archivePath = join(
      import.meta.dir,
      '../../fixtures/claude-preempt-stop-hook-cancelled-a3da8a7e.rows168-180.jsonl'
    )
    const signature = readFileSync(archivePath, 'utf8').trimEnd().split('\n').slice(3, 5)
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
        turnId: 'turn_completed',
        hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'completed base turn' },
      })
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        turnId: 'turn_completed',
        hookData: { hook_event_name: 'Stop' },
      })

      appendFileSync(transcriptPath, `${signature.join('\n')}\n`)
      await hookHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: hookSocket,
        hookData: { hook_event_name: 'Notification' },
      })

      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'turn.interrupted')).toHaveLength(0)
      expect(events.filter((event) => event.type === 'capture.warning')).toHaveLength(0)
      expect(
        index
          .list('inv_claude_tmux_1')
          .filter((row) => row.sourceKind === 'provider-jsonl')
          .map((row) => ({
            nativeType: row.nativeType,
            disposition: row.disposition,
            detail: row.detail,
          }))
      ).toEqual([
        {
          nativeType: 'attachment:hook_cancelled',
          disposition: 'ignored-known',
          detail: JSON.stringify({
            hookName: 'Stop',
            hookEvent: 'Stop',
            durationMs: 72,
            timedOut: false,
          }),
        },
        {
          nativeType: 'user',
          disposition: 'ignored-known',
          detail: 'late interrupt marker; Stop hook cancelled after delivery',
        },
      ])
    } finally {
      await driver.dispose()
      index.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
