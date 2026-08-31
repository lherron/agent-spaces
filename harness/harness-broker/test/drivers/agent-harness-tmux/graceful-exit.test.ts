import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import type { AgentHarnessControlListenerContext } from '../../../src/drivers/agent-harness-tmux/control-listener'
import { createAgentHarnessTmuxDriver } from '../../../src/drivers/agent-harness-tmux/driver'

/**
 * T-07677 acceptance: `/quit` on a sparky (agent-harness-tmux) runtime must
 * produce the user-exit signal the whole graceful-exit chain hangs off.
 *
 * That chain is one event deep. `continuation.cleared { reason:
 * 'prompt_input_exit' }` is what makes the broker push an authoritative
 * `invocation.summary`, which is what HRC records before reaping the tmux lease,
 * which is what `hrc run` reads to print its post-detach session summary. Before
 * this fix the driver emitted none of it: the control protocol had no exit verb,
 * the TUI just hung up, and the listener swallowed the disconnect — so a clean
 * `/quit` reached HRC as `runtime.crashed / broker_invocation_abnormal_terminal`
 * and the runtime sat `ready` with a live lease.
 *
 * The ORDER assertions are the load-bearing ones. `invocation.exited` overtaking
 * the continuation clear is indistinguishable, downstream, from a crash.
 */

type TmuxExecCall = { argv: string[]; loadedText?: string | undefined }

const invocationId = 'inv_agent_harness_tmux_quit'
const controlSocket = '/tmp/harness-broker/agent-harness-control.quit.sock'
const now = () => new Date('2026-08-28T19:15:00.000Z')

const paneLease = () => ({
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/harness-broker/agent-harness-tmux-quit.sock',
  sessionId: '$12',
  windowId: '@8',
  paneId: '%52',
  sessionName: 'hrc-owned-agent-harness-quit',
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
    agent: { agentId: 'sparky', projectId: 'hrc-runtime' },
    correlation: { runtimeId: 'runtime-agent-harness-quit' },
  }) as HarnessInvocationSpec

function createRecordingExec(calls: TmuxExecCall[]) {
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

/**
 * Stands in for the connected TUI. `quit()` replays exactly what the real child
 * does on `/quit` — the goodbye event frame, then the socket going away — and
 * `die()` replays every path that gets no word out (crash, killed pane).
 */
function createChildControl() {
  let onFrame: ((frame: AgentHarnessControlFrame) => Promise<void>) | undefined
  let onDisconnect: (() => void) | undefined
  let seq = 0
  let closeCount = 0

  const send = async (frame: AgentHarnessControlFrame): Promise<void> => {
    await onFrame?.(frame)
  }

  return {
    get closeCount() {
      return closeCount
    },
    listen: async (
      handler: (frame: AgentHarnessControlFrame) => Promise<void>,
      context: AgentHarnessControlListenerContext
    ) => {
      onFrame = handler
      onDisconnect = context.onDisconnect
      return {
        socketPath: controlSocket,
        request: async (_frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck> => ({
          ack: true,
        }),
        close: async () => {
          closeCount += 1
        },
      }
    },
    async start(sessionFile: string): Promise<void> {
      await send({ verb: 'hello', payload: { protocolVersion: 'agent-harness-control/v1' } })
      await send({ verb: 'ready', payload: { sessionFile } })
    },
    /** The `/quit` goodbye, then the hang-up — in the order the child sends them. */
    async quit(): Promise<void> {
      await send({
        verb: 'event',
        payload: {
          invocationId,
          seq: ++seq,
          time: now().toISOString(),
          type: 'continuation.cleared',
          payload: { reason: 'prompt_input_exit' },
          driver: { kind: 'agent-harness-tmux', rawType: 'tui.user_exit' },
        },
      } as AgentHarnessControlFrame)
      onDisconnect?.()
    },
    /** Death with no goodbye: crash, SIGKILL, killed pane. */
    die(): void {
      onDisconnect?.()
    },
  }
}

async function startBroker(control: ReturnType<typeof createChildControl>) {
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
  await control.start('/sessions/sparky-start.jsonl')
  await starting
  return { broker, events }
}

const typesOf = (events: InvocationEventEnvelope[]): string[] => events.map((event) => event.type)

describe('agent-harness-tmux graceful exit', () => {
  test('/quit emits the user-exit clear, and the broker answers it with a summary', async () => {
    const control = createChildControl()
    const { events } = await startBroker(control)

    await control.quit()

    const cleared = events.find((event) => event.type === 'continuation.cleared')
    expect(cleared).toBeDefined()
    expect(cleared?.payload).toMatchObject({ reason: 'prompt_input_exit' })

    // The summary is what HRC records before it reaps the lease, and what
    // `hrc run` renders as the post-detach session summary. No clear, no summary.
    const summary = events.find((event) => event.type === 'invocation.summary')
    expect(summary).toBeDefined()
    expect(summary?.payload).toMatchObject({ reason: 'prompt_input_exit' })
  })

  test('the teardown never overtakes the goodbye', async () => {
    const control = createChildControl()
    const { events } = await startBroker(control)

    await control.quit()

    const ordered = typesOf(events).filter((type) =>
      ['continuation.cleared', 'invocation.summary', 'invocation.exited'].includes(type)
    )
    // Exactly this order. `invocation.exited` first would read downstream as a
    // crash: HRC classifies the terminal by looking BACK for a user-initiated
    // continuation clear, and would find none.
    expect(ordered).toEqual(['continuation.cleared', 'invocation.summary', 'invocation.exited'])
  })

  test('a silent death is a crash: exited, with no user-exit clear', async () => {
    const control = createChildControl()
    const { events } = await startBroker(control)

    control.die()

    // The runtime must still terminate — an unobserved death is what left sparky
    // runtimes sitting `ready` with a live tmux lease forever.
    const exited = events.find((event) => event.type === 'invocation.exited')
    expect(exited).toBeDefined()
    expect(exited?.payload).toMatchObject({ reason: 'process-exit' })

    // But it must NOT claim a user exit: HRC keeps the continuation on a crash so
    // the runtime stays resumable on reattach (T-01761).
    expect(events.some((event) => event.type === 'continuation.cleared')).toBe(false)
    expect(events.some((event) => event.type === 'invocation.summary')).toBe(false)
  })

  test('the invocation reaches a terminal state on /quit', async () => {
    const control = createChildControl()
    const { broker } = await startBroker(control)

    await control.quit()

    const status = await broker.status({ invocationId })
    expect(status.state).toBe('exited')
  })
})
