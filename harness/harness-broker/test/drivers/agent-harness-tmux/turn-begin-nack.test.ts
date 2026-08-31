import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
  HarnessInvocationSpec,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createAgentHarnessTmuxDriver } from '../../../src/drivers/agent-harness-tmux/driver'

/**
 * T-07584 acceptance: a `turn.begin` the child cannot bind is a RECOVERABLE
 * TURN failure, not an invocation death and not an input failure.
 *
 * The shape under test is the one daedalus approved at hrcchat#21059 and the
 * one the amended `agent-harness-runtime-boundary` law now requires. It is
 * deliberately NOT the shape that was rejected first: making `applyInputNow`
 * throw would skip `recordDisposition`, leaving `input.accepted{started}`
 * asserting a start that never happened and the same inputId re-drivable. Every
 * assertion below that names the ledger exists to keep that door shut.
 */

type TmuxExecCall = {
  argv: string[]
  loadedText?: string | undefined
}

const invocationId = 'inv_agent_harness_tmux_nack'
const controlSocket = '/tmp/harness-broker/agent-harness-control.nack.sock'
const now = () => new Date('2026-08-25T21:15:00.000Z')
const REFUSED_TEXT = 'this text must never reach the pane'
const RECOVERED_TEXT = 'this text must reach the pane'

/** One macrotask hop — the same one the driver's outbound gate flushes on. */
const flushGate = () => new Promise((resolve) => setTimeout(resolve, 0))

const paneLease = () => ({
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/harness-broker/agent-harness-tmux-nack.sock',
  sessionId: '$12',
  windowId: '@8',
  paneId: '%52',
  sessionName: 'hrc-owned-agent-harness-nack',
  windowName: 'main',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true, capture: true },
})

const spec = (): HarnessInvocationSpec =>
  ({
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness-tmux' },
    process: {
      command: '/opt/bin/agent-harness',
      args: [],
      cwd: '/workspace/agent-spaces',
      lockedEnv: {},
      harnessTransport: { kind: 'pty' },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: {
      kind: 'agent-harness-tmux',
      terminalHost: 'tmux',
      permissionPolicy: { mode: 'allow' },
    },
    sdk: {
      runtime: 'pi-sdk',
      provider: 'openai',
      modelId: 'gpt-5.6-test',
      authMode: 'api-key',
    },
    agent: { agentId: 'smokey', projectId: 'agent-spaces' },
    correlation: { runtimeId: 'runtime-agent-harness-nack' },
  }) as HarnessInvocationSpec

const userInput = (inputId: string, text: string): InvocationInput => ({
  inputId,
  kind: 'user',
  content: [{ type: 'text', text }],
})

function createRecordingExec(calls: TmuxExecCall[]) {
  // Mirrors driver.red.test.ts: `capture-pane` must echo the pending buffer or
  // the driver's paste verification never observes its own line and spins.
  let pendingLine = ''
  return async (argv: string[]): Promise<{ stdout: string; stderr: string }> => {
    const call: TmuxExecCall = { argv }
    calls.push(call)
    if (argv.includes('display-message')) return { stdout: '$12\t@8\t%52\n', stderr: '' }
    if (argv.includes('load-buffer')) {
      pendingLine = readFileSync(argv.at(-1) ?? '', 'utf8')
      call.loadedText = pendingLine
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('send-keys') && argv.includes('Enter')) {
      pendingLine = ''
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('capture-pane')) return { stdout: pendingLine, stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function pastedText(calls: TmuxExecCall[], text: string): boolean {
  return calls.some(
    (call) =>
      call.loadedText?.includes(text) === true ||
      (call.argv.includes('send-keys') && call.argv.includes(text))
  )
}

/**
 * A child that refuses the FIRST `turn.begin` it is offered and binds every one
 * after it. `settleAck` controls whether the refusal is answered synchronously
 * or on a later microtask, so the ordering guarantee can be tested against a
 * child that nacks as fast as the wire allows.
 */
function createRefusingControl(options: { immediate?: boolean } = {}) {
  const requests: AgentHarnessControlRequest[] = []
  let handler: ((frame: AgentHarnessControlFrame) => Promise<void>) | undefined
  let closeCount = 0
  let refused = false
  return {
    requests,
    get closeCount() {
      return closeCount
    },
    turnBeginCount(): number {
      return requests.filter((frame) => frame.verb === 'turn.begin').length
    },
    listen: async (nextHandler: (frame: AgentHarnessControlFrame) => Promise<void>) => {
      handler = nextHandler
      return {
        socketPath: controlSocket,
        request: async (frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck> => {
          requests.push(frame)
          if (frame.verb !== 'turn.begin' || refused) return { ack: true }
          refused = true
          const nack: AgentHarnessControlAck = {
            ack: false,
            code: 'turn_already_active',
            message: `Cannot begin a pi SDK turn while turn ${frame.payload.turnId}-prev is active`,
          }
          if (options.immediate === true) return nack
          await Promise.resolve()
          return nack
        },
        close: async () => {
          closeCount += 1
        },
      }
    },
    async start(): Promise<void> {
      await handler?.({ verb: 'hello', payload: { protocolVersion: 'agent-harness-control/v1' } })
      await handler?.({
        verb: 'ready',
        payload: { sessionFile: '/sessions/agent-harness-nack.jsonl' },
      })
    },
  }
}

async function startBroker(control: ReturnType<typeof createRefusingControl>) {
  const calls: TmuxExecCall[] = []
  const events: InvocationEventEnvelope[] = []
  const driver = createAgentHarnessTmuxDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(calls) },
    control: { listen: control.listen },
    now,
  })
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event: InvocationEventEnvelope) => events.push(event),
    now,
  })
  const starting = broker.start({ spec: spec() }, {}, { terminalSurface: paneLease() })
  await Bun.sleep(0)
  await control.start()
  await starting
  calls.length = 0
  return { broker, calls, events }
}

function typesFor(events: InvocationEventEnvelope[], turnId: string): string[] {
  return events
    .filter((event) => event.turnId === turnId || event.inputId !== undefined)
    .map((event) => event.type)
}

describe('agent-harness-tmux turn.begin negative acknowledgement', () => {
  test('refusal fails one turn, keeps the channel, and the next input runs on the same runtime', async () => {
    const control = createRefusingControl()
    const { broker, calls, events } = await startBroker(control)

    const refused = await broker.input({
      invocationId,
      input: userInput('input-refused', REFUSED_TEXT),
    })

    // The INPUT was accepted and a turn was allocated for it. This is the whole
    // point of the approved shape: the broker's accepted-input boundary is
    // preserved, so the ledger records exactly one disposition for this inputId.
    expect(refused).toMatchObject({
      inputId: 'input-refused',
      accepted: true,
      disposition: 'started',
      turnId: `turn_${invocationId}_1`,
    })

    // No pane input. The child said it could not bind the turn; pasting anyway
    // would deliver a prompt into a session that is not listening for it.
    expect(pastedText(calls, REFUSED_TEXT)).toBe(false)

    // The control channel is NOT destroyed and the invocation is NOT torn down.
    expect(control.closeCount).toBe(0)

    await flushGate()

    const failed = events.find((event) => event.type === 'turn.failed')
    expect(failed).toMatchObject({
      turnId: `turn_${invocationId}_1`,
      inputId: 'input-refused',
      payload: { status: 'failed', code: 'turn_already_active', retryable: true },
    })
    expect((failed?.payload as { message: string }).message).toContain('while turn')
    expect(typesFor(events, `turn_${invocationId}_1`)).toEqual([
      'input.accepted',
      'turn.started',
      'turn.failed',
    ])
    expect(events.some((event) => event.type === 'invocation.failed')).toBe(false)
    expect(events.some((event) => event.type === 'invocation.exited')).toBe(false)

    // Back to ready, and drivable again.
    const status = await broker.status({ invocationId })
    expect(status.state).toBe('ready')

    const recovered = await broker.input({
      invocationId,
      input: userInput('input-recovered', RECOVERED_TEXT),
    })
    expect(recovered).toMatchObject({
      inputId: 'input-recovered',
      accepted: true,
      disposition: 'started',
      turnId: `turn_${invocationId}_2`,
    })
    expect(pastedText(calls, RECOVERED_TEXT)).toBe(true)
    expect(
      events.some(
        (event) => event.type === 'turn.started' && event.turnId === `turn_${invocationId}_2`
      )
    ).toBe(true)

    await broker.stop({ invocationId, reason: 'test complete' })
    await broker.dispose({ invocationId })
  })

  test('replaying the refused inputId is answered by the ledger, never re-driven', async () => {
    const control = createRefusingControl()
    const { broker, calls, events } = await startBroker(control)

    const first = await broker.input({
      invocationId,
      input: userInput('input-refused', REFUSED_TEXT),
    })
    await flushGate()
    const turnBeginsAfterFirst = control.turnBeginCount()
    const eventsAfterFirst = events.length

    const replay = await broker.input({
      invocationId,
      input: userInput('input-refused', REFUSED_TEXT),
    })

    // The recorded disposition answers the replay verbatim: the same turnId,
    // no second turn.begin on the wire, no paste, and no new ledger events.
    expect(replay).toEqual(first)
    expect(control.turnBeginCount()).toBe(turnBeginsAfterFirst)
    expect(pastedText(calls, REFUSED_TEXT)).toBe(false)
    await flushGate()
    expect(events.length).toBe(eventsAfterFirst)
    expect(events.filter((event) => event.type === 'input.accepted')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(1)

    await broker.stop({ invocationId, reason: 'test complete' })
    await broker.dispose({ invocationId })
  })

  test('turn.failed never precedes turn.started, even when the child nacks immediately', async () => {
    const control = createRefusingControl({ immediate: true })
    const { broker, events } = await startBroker(control)

    await broker.input({ invocationId, input: userInput('input-refused', REFUSED_TEXT) })
    await flushGate()

    const startIndex = events.findIndex((event) => event.type === 'turn.started')
    const failedIndex = events.findIndex((event) => event.type === 'turn.failed')
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(failedIndex).toBeGreaterThan(startIndex)
    expect(events[startIndex]?.turnId).toBe(events[failedIndex]?.turnId)
    expect(events.every((event, index) => event.seq === index + 1)).toBe(true)

    await broker.stop({ invocationId, reason: 'test complete' })
    await broker.dispose({ invocationId })
  })

  test('a session.config refusal is a protocol violation, not a recoverable turn outcome', async () => {
    // session.config stays FAIL-CLOSED (D5 construction order). The child never
    // nacks it — it destroys the channel — so if one ever arrives the driver must
    // treat it as a violation rather than quietly continuing to launch.
    const requests: AgentHarnessControlRequest[] = []
    const calls: TmuxExecCall[] = []
    let handler: ((frame: AgentHarnessControlFrame) => Promise<void>) | undefined
    const driver = createAgentHarnessTmuxDriver({
      tmux: { tmuxBin: '/opt/bin/tmux', exec: createRecordingExec(calls) },
      control: {
        listen: async (nextHandler) => {
          handler = nextHandler
          return {
            socketPath: controlSocket,
            request: async (frame: AgentHarnessControlRequest) => {
              requests.push(frame)
              return frame.verb === 'session.config'
                ? ({
                    ack: false,
                    code: 'turn_begin_failed',
                    message: 'config refused',
                  } as AgentHarnessControlAck)
                : ({ ack: true } as AgentHarnessControlAck)
            },
            close: async () => undefined,
          }
        },
      },
      now,
    })
    const events: InvocationEventEnvelope[] = []
    const emitEvent = (event: InvocationEvent, extra?: Record<string, unknown>) => {
      const envelope = {
        invocationId,
        seq: events.length + 1,
        time: now().toISOString(),
        type: event.type,
        payload: event.payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(envelope)
      return envelope
    }
    const starting = driver.start(spec(), {
      invocationId,
      clientCapabilities: {},
      runtime: { terminalSurface: paneLease() },
      emit: (type, payload, extra) =>
        emitEvent({ type, payload } as InvocationEvent, extra) as never,
      emitEvent: (event, extra) => emitEvent(event, extra),
    } as never)
    for (let attempt = 0; attempt < 100 && handler === undefined; attempt += 1) {
      await Bun.sleep(1)
    }
    expect(handler).toBeDefined()

    const startOutcome = starting.then(
      () => undefined,
      (error: unknown) => error
    )
    const helloOutcome = handler!({
      verb: 'hello',
      payload: { protocolVersion: 'agent-harness-control/v1' },
    }).then(
      () => undefined,
      (error: unknown) => error
    )
    const [startError, helloError] = await Promise.all([startOutcome, helloOutcome])
    expect(startError).toBeInstanceOf(Error)
    expect((startError as Error).message).toMatch(/refused session.config/)
    expect(helloError).toBeInstanceOf(Error)
    expect((helloError as Error).message).toMatch(/refused session.config/)
  })
})
