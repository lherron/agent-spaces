import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { validateEventEnvelope } from 'spaces-harness-broker-protocol'
import { createCaptureGate } from '../../../src/capture/capture-gate'
import { openCaptureIndex } from '../../../src/capture/capture-index'
import { createRawJournal } from '../../../src/capture/raw-journal'
import {
  CLAUDE_CODE_HRCPTY_DRIVER_KIND,
  createClaudeCodeHrcptyDriver,
} from '../../../src/drivers/claude-code-hrcpty/driver'
import {
  type HookEnvelopeHandler,
  createClaudeCodeTmuxDriver,
} from '../../../src/drivers/claude-code-tmux/driver'
import type { Driver } from '../../../src/drivers/driver'
import { deliveryEvidenceOf } from '../../../src/drivers/driver'
import { inputIdFrom } from '../../ids'
import {
  type TmuxExecCall,
  claudeTmuxSpec,
  createCtx,
  createRecordingExec,
  defaultLease,
  now,
} from '../claude-code-tmux/driver-red.helpers'
import { type FakeHrcpty, createFakeHrcpty, hrcptyLease } from './fake-hrcpty'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-hrcpty-driver-'))
  roots.push(root)
  return root
}

const hrcptySpec = (): HarnessInvocationSpec => {
  const spec = claudeTmuxSpec()
  return {
    ...spec,
    harness: { ...spec.harness, driver: 'claude-code-hrcpty' },
    driver: { kind: 'claude-code-hrcpty', terminalHost: 'hrcpty' },
  } as HarnessInvocationSpec
}

function userInput(inputId: string, text: string, extra: Partial<InvocationInput> = {}) {
  return {
    inputId: inputIdFrom(inputId),
    kind: 'user',
    content: [{ type: 'text', text }],
    ...extra,
  } as InvocationInput
}

type Started = {
  driver: Driver
  fake: FakeHrcpty
  events: InvocationEventEnvelope[]
  hook: (hookData: Record<string, unknown>, turnId?: string) => Promise<unknown>
  hookSocket: string
  root: string
}

async function startHrcpty(
  options: {
    fake?: FakeHrcpty
    lease?: unknown
    driverOptions?: Partial<Parameters<typeof createClaudeCodeHrcptyDriver>[0]>
    withCapture?: boolean
  } = {}
): Promise<Started> {
  const root = tempRoot()
  const hookSocket = join(root, 'claude-hooks.sock')
  const fake = options.fake ?? createFakeHrcpty()
  let handler: HookEnvelopeHandler | undefined
  const events: InvocationEventEnvelope[] = []
  const driver = createClaudeCodeHrcptyDriver({
    hrcpty: { connect: fake.connect, token: async () => 'tok-fake' },
    hooks: {
      listen: async (listener) => {
        handler = listener
        return { socketPath: hookSocket, close: async () => undefined }
      },
    },
    now,
    ...options.driverOptions,
  })
  const ctx = createCtx(
    events,
    { terminalSurface: (options.lease ?? hrcptyLease()) as never },
    'inv_claude_tmux_1'
  )
  if (options.withCapture === true) {
    ctx.capture = createCaptureGate({
      invocationId: 'inv_claude_tmux_1' as InvocationId,
      journal: createRawJournal({
        invocationId: 'inv_claude_tmux_1' as InvocationId,
        dir: join(root, 'journal'),
      }),
      index: openCaptureIndex(join(root, 'capture.db')),
      normalizer: { name: CLAUDE_CODE_HRCPTY_DRIVER_KIND, version: 'test' },
      now,
      emitWarning: (payload) => ctx.emit('capture.warning', payload).seq,
      warn: () => undefined,
    })
  }
  await driver.start(hrcptySpec(), ctx)
  const hook = async (hookData: Record<string, unknown>, turnId?: string) =>
    handler?.({
      invocationId: 'inv_claude_tmux_1',
      generation: 1,
      callbackSocket: hookSocket,
      ...(turnId !== undefined ? { turnId } : {}),
      hookData,
    } as never)
  return { driver, fake, events, hook, hookSocket, root }
}

describe('claude-code-hrcpty lease', () => {
  test.each([
    ['a tmux-pane lease', defaultLease(), "terminalSurface.kind === 'hrcpty'"],
    ['a broker-owned hrcpty lease', { ...hrcptyLease(), ownership: 'broker' }, 'ownership'],
    ['no lease', undefined, 'got kind undefined'],
  ])('refuses %s before touching any socket', async (_label, lease, message) => {
    const fake = createFakeHrcpty()
    const driver = createClaudeCodeHrcptyDriver({
      hrcpty: { connect: fake.connect, token: async () => 'tok-fake' },
      hooks: { listen: async () => ({ socketPath: '/tmp/x.sock', close: async () => undefined }) },
    })
    const events: InvocationEventEnvelope[] = []
    await expect(
      driver.start(
        hrcptySpec(),
        createCtx(events, lease === undefined ? {} : { terminalSurface: lease as never })
      )
    ).rejects.toThrow(message)
    expect(fake.calls).toEqual([])
    expect(events).toEqual([])
  })

  test('a wrong attach token fails start loudly and spawns nothing', async () => {
    const fake = createFakeHrcpty({ token: 'the-real-token' })
    await expect(startHrcpty({ fake })).rejects.toThrow(/hrcpty supervisor unreachable.*token/)
    expect(fake.spawnParams()).toBeUndefined()
  })
})

describe('claude-code-hrcpty spawn', () => {
  test('spawns the tmux route’s Claude argv and env at the supervisor size, then reports the socket', async () => {
    const fake = createFakeHrcpty({ size: { cols: 132, rows: 41 } })
    const { events, hookSocket } = await startHrcpty({ fake })

    expect(fake.tokens).toEqual(['tok-fake'])
    expect(fake.calls.map((call) => call.method)).toEqual(['hello', 'spawn'])
    const spawn = fake.spawnParams() as {
      argv: string[]
      env: Record<string, string>
      cwd: string
      cols: number
      rows: number
    }
    expect(spawn.argv.slice(0, 3)).toEqual(['/opt/bin/claude', '--model', 'sonnet'])
    expect(spawn.argv.at(-2)).toBe('--settings')
    const settings = JSON.parse(readFileSync(spawn.argv.at(-1) as string, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd']) {
      expect(settings.hooks[event]?.[0]?.hooks[0]?.command).toContain(hookSocket)
    }
    expect(spawn.env).toMatchObject({
      ANTHROPIC_API_KEY: 'test-key',
      HARNESS_BROKER_INVOCATION_ID: 'inv_claude_tmux_1',
      HARNESS_BROKER_CALLBACK_SOCKET: hookSocket,
      HARNESS_BROKER_HOOK_GENERATION: '1',
      HARNESS_BROKER_RUNTIME_ID: 'runtime-driver-red',
    })
    expect(spawn.env['PATH']).toBeDefined()
    expect(spawn.env['TMUX']).toBeUndefined()
    expect(spawn.env['CLAUDE_CODE_FORCE_TERMINAL_IMAGES']).toBeUndefined()
    expect(spawn.cwd).toBe(process.cwd())
    expect([spawn.cols, spawn.rows]).toEqual([132, 41])

    const surface = events.filter((event) => event.type === 'terminal.surface.reported')
    expect(surface).toHaveLength(1)
    expect(surface[0]).toMatchObject({
      payload: { kind: 'hrcpty-socket', socketPath: '/tmp/bipc/rt/hrcpty.sock' },
      driver: { kind: CLAUDE_CODE_HRCPTY_DRIVER_KIND, rawType: 'hrcpty.surface' },
    })
    expect(() => validateEventEnvelope(surface[0])).not.toThrow()
  })

  test('without a token option the default reads attach.token beside the leased socket', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'attach.token'), 'tok-from-file\n')
    const fake = createFakeHrcpty({ token: 'tok-from-file' })
    const driver = createClaudeCodeHrcptyDriver({
      hrcpty: { connect: fake.connect },
      hooks: {
        listen: async () => ({ socketPath: join(root, 'h.sock'), close: async () => undefined }),
      },
    })
    await driver.start(
      hrcptySpec(),
      createCtx([], { terminalSurface: hrcptyLease(join(root, 'hrcpty.sock')) as never })
    )
    expect(fake.tokens).toEqual(['tok-from-file'])
    await driver.dispose()
  })
})

describe('claude-code-hrcpty turn delivery', () => {
  test('a turn is one bracketed paste then CR, confirmed by the emptied box', async () => {
    const { driver, fake } = await startHrcpty()
    const result = await driver.applyInputNow(userInput('input_1', 'hello there'))

    expect(String(result.turnId)).toBe('turn_inv_claude_tmux_1_1')
    expect(fake.inputs()).toEqual(['\x1b[200~hello there\x1b[201~', '\r'])
    expect(fake.screen.submitted).toEqual(['hello there'])
  })

  test('newlines stay newlines inside the paste and stray bracket markers are removed', async () => {
    const { driver, fake } = await startHrcpty()
    await driver.applyInputNow(userInput('input_1', 'line one\r\nline two\x1b[201~tail'))
    expect(fake.inputs()[0]).toBe('\x1b[200~line one\nline twotail\x1b[201~')
  })

  test('a swallowed CR is pressed again only while the box still shows the paste', async () => {
    const fake = createFakeHrcpty({ screen: { swallowEnters: 1 } })
    const { driver } = await startHrcpty({ fake })
    await driver.applyInputNow(userInput('input_1', 'retry me'))
    expect(fake.inputs()).toEqual(['\x1b[200~retry me\x1b[201~', '\r', '\r'])
    expect(fake.screen.submitted).toEqual(['retry me'])
  })

  test('CR waits for the paste to show in the box, so an unrendered paste never passes for a submit', async () => {
    const fake = createFakeHrcpty({ screen: { pasteLagMs: 600 } })
    const { driver } = await startHrcpty({ fake })
    await driver.applyInputNow(userInput('input_1', 'slow paste'))
    expect(fake.screen.dropped ?? 0).toBe(0)
    expect(fake.screen.submitted).toEqual(['slow paste'])
    expect(fake.screen.box).toBe('')
  })

  test('the first delivery waits for Claude to draw its input box', async () => {
    const fake = createFakeHrcpty({ screen: { booting: true } })
    const { driver } = await startHrcpty({ fake })
    setTimeout(() => {
      fake.screen.booting = false
    }, 300)
    const startedAt = Date.now()
    await driver.applyInputNow(userInput('input_1', 'after boot'))
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
    expect(fake.screen.submitted).toEqual(['after boot'])
  })

  test('a box that never appears refuses as not written, before any byte', async () => {
    const fake = createFakeHrcpty({ screen: { booting: true } })
    const { driver } = await startHrcpty({ fake, driverOptions: { inputReadyTimeoutMs: 200 } })
    const error = await driver.applyInputNow(userInput('input_1', 'never')).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('pane_not_quiescent')
    expect(deliveryEvidenceOf(error)).toBe('not_written')
    expect(fake.inputs()).toEqual([])
  })

  test('after our interrupt, the prompt Claude put back is cleared with Ctrl-U before the next paste', async () => {
    const fake = createFakeHrcpty({ screen: { restoreOnInterrupt: true } })
    const { driver } = await startHrcpty({ fake })
    await driver.applyInputNow(userInput('input_1', 'first prompt'))
    expect(
      await driver.interrupt({ invocationId: 'inv_claude_tmux_1' as never, scope: 'turn' })
    ).toEqual({
      accepted: true,
      effect: 'turn_interrupted',
    })
    expect(fake.screen.interrupts).toBe(1)
    expect(fake.screen.box).toBe('first prompt')

    await driver.applyInputNow(userInput('input_2', 'second prompt'))
    expect(fake.inputs().slice(2)).toEqual(['\x15', '\x1b[200~second prompt\x1b[201~', '\r'])
    expect(fake.screen.submitted).toEqual(['first prompt', 'second prompt'])
  })

  test('an interrupt that restores nothing costs at most the restore window, then delivers', async () => {
    const { driver, fake } = await startHrcpty({ driverOptions: { interruptRestoreWaitMs: 300 } })
    await driver.applyInputNow(userInput('input_1', 'first'))
    await driver.interrupt({ invocationId: 'inv_claude_tmux_1' as never, scope: 'turn' })
    await driver.applyInputNow(userInput('input_2', 'second'))
    expect(fake.inputs()).not.toContain('\x15')
    expect(fake.screen.submitted).toEqual(['first', 'second'])
  })

  test('a steer waits for a quiet empty box, then lands as one write', async () => {
    const { driver, fake } = await startHrcpty()
    await driver.applySteerNow?.(userInput('input_steer', 'steer text'))
    expect(fake.inputs()).toEqual(['\x1b[200~steer text\x1b[201~\r'])
    expect(fake.screen.submitted).toEqual(['steer text'])
  })

  test('a steer into an operator’s half-typed box refuses as not written', async () => {
    const fake = createFakeHrcpty({ screen: { box: 'operator typing' } })
    const { driver } = await startHrcpty({ fake })
    const error = await driver
      .applySteerNow?.(userInput('input_steer', 'steer text'))
      .catch((e) => e)
    expect(deliveryEvidenceOf(error)).toBe('not_written')
    expect(fake.screen.box).toBe('operator typing')
    expect(fake.inputs()).toEqual([])
  }, 15_000)

  test('stop leaves the supervisor alone and later deliveries find no live surface', async () => {
    const { driver, fake } = await startHrcpty()
    await driver.stop({ invocationId: 'inv_claude_tmux_1' as never })
    expect(fake.calls.map((call) => call.method)).toEqual(['hello', 'spawn'])
    expect(
      await driver.interrupt({ invocationId: 'inv_claude_tmux_1' as never, scope: 'turn' })
    ).toEqual({ accepted: false, effect: 'no_active_turn' })
    await expect(driver.applyInputNow(userInput('input_1', 'x'))).rejects.toThrow(
      'hrcpty surface not established'
    )
  })
})

const schemaResponse = {
  kind: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { status: { type: 'string' } },
    required: ['status'],
  },
} as InvocationInput['responseFormat']

/** One Claude turn as the hooks and session JSONL report it: a tool call, then an answer. */
function transcriptRows(prompt: string): string[] {
  const rows = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: prompt } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'readme text' }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      message: {
        id: 'msg_2',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [{ type: 'text', text: '{"status":"ok"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 7 },
      },
    },
  ]
  return rows.map((row) => `${JSON.stringify(row)}\n`)
}

/**
 * Drive one structured turn through a driver: the broker's submission, then
 * the hooks and transcript rows Claude writes for it. Returns the events with
 * the fields that legitimately differ between hosts (driver kind, seq, time,
 * raw record ids) removed.
 */
async function driveTurn(
  driver: Driver,
  hook: (hookData: Record<string, unknown>, turnId?: string) => Promise<unknown>,
  events: InvocationEventEnvelope[],
  transcriptPath: string,
  submittedPrompt: () => string
) {
  await hook({ hook_event_name: 'SessionStart', transcript_path: transcriptPath })
  const applied = await driver.applyInputNow(
    userInput('input_parity', 'return status', { responseFormat: schemaResponse })
  )
  const prompt = submittedPrompt()
  const [user, toolUse, toolResult, answer] = transcriptRows(prompt)
  appendFileSync(transcriptPath, user as string)
  await hook({ hook_event_name: 'UserPromptSubmit', prompt })
  appendFileSync(transcriptPath, toolUse as string)
  await hook({
    hook_event_name: 'PreToolUse',
    tool_use_id: 'toolu_1',
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
  })
  appendFileSync(transcriptPath, toolResult as string)
  await hook({
    hook_event_name: 'PostToolUse',
    tool_use_id: 'toolu_1',
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    tool_response: { content: 'readme text' },
  })
  appendFileSync(transcriptPath, answer as string)
  const decision = await hook({
    hook_event_name: 'Stop',
    last_assistant_message: '{"status":"ok"}',
  })
  await driver.stop({ invocationId: 'inv_claude_tmux_1' as never })
  return {
    applied,
    decision,
    prompt,
    normalized: events
      .filter((event) => event.type !== 'terminal.surface.reported')
      .map(({ seq: _seq, time: _time, driver: eventDriver, provenance, ...rest }) => ({
        ...rest,
        rawType: eventDriver?.rawType,
        sourceKind: (provenance as { sourceKind?: string } | undefined)?.sourceKind,
      })),
    kinds: [...new Set(events.map((event) => event.driver?.kind))],
  }
}

describe('claude-code-hrcpty turn evidence', () => {
  test('one structured turn yields the same events from both hosts, labelled with each driver’s kind', async () => {
    const tmuxRoot = tempRoot()
    const tmuxTranscript = join(tmuxRoot, 'session.jsonl')
    writeFileSync(tmuxTranscript, '')
    const tmuxCalls: TmuxExecCall[] = []
    let tmuxHandler: HookEnvelopeHandler | undefined
    const tmuxEvents: InvocationEventEnvelope[] = []
    const tmuxHookSocket = join(tmuxRoot, 'claude-hooks.sock')
    const tmuxDriver = createClaudeCodeTmuxDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(tmuxCalls) },
      hooks: {
        listen: async (listener) => {
          tmuxHandler = listener
          return { socketPath: tmuxHookSocket, close: async () => undefined }
        },
      },
      now,
    })
    await tmuxDriver.start(
      claudeTmuxSpec(),
      createCtx(tmuxEvents, { terminalSurface: defaultLease() }, 'inv_claude_tmux_1')
    )
    const tmuxHook = async (hookData: Record<string, unknown>, turnId?: string) =>
      tmuxHandler?.({
        invocationId: 'inv_claude_tmux_1',
        generation: 1,
        callbackSocket: tmuxHookSocket,
        ...(turnId !== undefined ? { turnId } : {}),
        hookData,
      } as never)
    const tmux = await driveTurn(
      tmuxDriver,
      tmuxHook,
      tmuxEvents,
      tmuxTranscript,
      () => tmuxCalls.filter((call) => call.argv.includes('load-buffer')).at(-1)?.loadedText ?? ''
    )

    const started = await startHrcpty()
    const hrcptyTranscript = join(started.root, 'session.jsonl')
    writeFileSync(hrcptyTranscript, '')
    const hrcpty = await driveTurn(
      started.driver,
      started.hook,
      started.events,
      hrcptyTranscript,
      () => (started.fake.inputs()[0] ?? '').replace('\x1b[200~', '').replace('\x1b[201~', '')
    )

    expect(hrcpty.prompt).toBe(tmux.prompt)
    expect(hrcpty.prompt).toContain('return ONLY JSON')
    expect(hrcpty.applied).toEqual(tmux.applied)
    expect(hrcpty.decision).toEqual(tmux.decision)
    expect(hrcpty.normalized).toEqual(tmux.normalized)
    const types: string[] = hrcpty.normalized.map((event) => event.type)
    for (const type of [
      'turn.started',
      'user.message',
      'tool.call.started',
      'tool.call.completed',
      'usage.updated',
      'assistant.message.completed',
      'turn.completed',
    ]) {
      expect(types).toContain(type)
    }
    expect(tmux.kinds).toEqual(['claude-code-tmux'])
    expect(hrcpty.kinds).toEqual([CLAUDE_CODE_HRCPTY_DRIVER_KIND])
    await tmuxDriver.dispose()
    await started.driver.dispose()
  })

  test('raw provider records are committed under the hrcpty driver kind', async () => {
    const started = await startHrcpty({ withCapture: true })
    const transcriptPath = join(started.root, 'session.jsonl')
    writeFileSync(transcriptPath, transcriptRows('hello').join(''))
    await started.hook({ hook_event_name: 'SessionStart', transcript_path: transcriptPath })
    await started.hook({ hook_event_name: 'Stop' })
    const journalRows = readFileSync(
      join(started.root, 'journal', 'raw', 'inv_claude_tmux_1.ndjson'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { driverKind: string; sourceKind: string })
    expect(journalRows.length).toBeGreaterThan(0)
    expect(new Set(journalRows.map((row) => row.driverKind))).toEqual(
      new Set([CLAUDE_CODE_HRCPTY_DRIVER_KIND])
    )
    expect(new Set(journalRows.map((row) => row.sourceKind))).toEqual(
      new Set(['hook', 'provider-jsonl'])
    )
    await started.driver.dispose()
  })
})
