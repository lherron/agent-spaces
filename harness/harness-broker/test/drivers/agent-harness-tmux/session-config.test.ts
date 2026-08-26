import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
  HarnessInvocationSpec,
  InvocationEvent,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { validateAgentHarnessControlFrame } from 'spaces-harness-broker-protocol'
import { createAgentHarnessTmuxDriver } from '../../../src/drivers/agent-harness-tmux/driver'
import type { DriverContext } from '../../../src/drivers/driver'

/**
 * T-07585. The acceptance red only ever projects a spec that HAS a continuation
 * key, so it could not see that requiring one makes a FIRST launch
 * unrepresentable: the child feeds the key to SessionManager.open, which throws
 * when the named session does not exist, and only `undefined` means "create
 * fresh". Both cells are pinned here — fresh AND resume.
 */

// Deliberately free of the substring 'continuation': the requestId is derived
// from the invocationId, and the leak assertion below greps the whole frame.
const invocationId = 'inv_ah_tmux_fresh_resume'

const paneLease = () => ({
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/harness-broker/agent-harness-tmux.sock',
  sessionId: '$3',
  windowId: '@4',
  paneId: '%5',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true, capture: true },
})

function specWith(continuation: { key: string } | undefined): HarnessInvocationSpec {
  return {
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
    agent: { agentId: 'sparky', projectId: 'agent-spaces', runMode: 'task' },
    ...(continuation !== undefined
      ? { continuation: { ...continuation, provider: 'openai', kind: 'session' } }
      : {}),
  } as HarnessInvocationSpec
}

function createExec() {
  let pending = ''
  return async (argv: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (argv.includes('display-message')) return { stdout: '$3\t@4\t%5\n', stderr: '' }
    if (argv.includes('load-buffer')) {
      pending = readFileSync(argv.at(-1) ?? '', 'utf8')
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('send-keys') && argv.includes('Enter')) {
      pending = ''
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('capture-pane')) return { stdout: pending, stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function createCtx(): DriverContext {
  const events: InvocationEventEnvelope[] = []
  return {
    invocationId,
    clientCapabilities: {},
    runtime: { terminalSurface: paneLease() },
    dispatchEnv: {},
    emit: ((type: string, payload: unknown) => {
      const envelope = { invocationId, seq: events.length + 1, type, payload }
      events.push(envelope as InvocationEventEnvelope)
      return envelope
    }) as never,
    emitEvent: ((event: InvocationEvent) => {
      const envelope = { invocationId, seq: events.length + 1, ...event }
      events.push(envelope as InvocationEventEnvelope)
      return envelope
    }) as never,
  } as DriverContext
}

async function projectSessionConfig(
  continuation: { key: string } | undefined
): Promise<AgentHarnessControlRequest | undefined> {
  const requests: AgentHarnessControlRequest[] = []
  let handler: ((frame: AgentHarnessControlFrame) => Promise<void>) | undefined
  const driver = createAgentHarnessTmuxDriver({
    tmux: { tmuxBin: '/opt/bin/tmux', exec: createExec() },
    control: {
      listen: async (next) => {
        handler = next
        return {
          socketPath: '/tmp/harness-broker/agent-harness-continuation.sock',
          request: async (frame): Promise<AgentHarnessControlAck> => {
            requests.push(frame)
            return { ack: true }
          },
          close: async () => undefined,
        }
      },
    },
    now: () => new Date('2026-08-25T21:00:00.000Z'),
  })
  await driver.start(specWith(continuation), createCtx())
  await handler?.({ verb: 'hello', payload: { protocolVersion: 'agent-harness-control/v1' } })
  return requests.find((frame) => frame.verb === 'session.config')
}

describe('agent-harness-tmux session.config continuation projection', () => {
  test('omits continuation entirely when the spec carries none — fresh launch', async () => {
    const frame = await projectSessionConfig(undefined)

    expect(frame).toBeDefined()
    expect(frame?.payload).not.toHaveProperty('continuation')
    // A synthesized key here would name a session file that does not exist, and
    // the child opens-or-throws on it.
    expect(JSON.stringify(frame)).not.toContain('continuation')
    // The projection must still be a legal frame with continuation absent.
    expect(() => validateAgentHarnessControlFrame(frame)).not.toThrow()
  })

  test('projects the spec key verbatim when one is present — resume', async () => {
    const frame = await projectSessionConfig({ key: 'session-resume-07585.jsonl' })

    expect(frame?.payload).toMatchObject({
      continuation: { key: 'session-resume-07585.jsonl' },
    })
    expect(() => validateAgentHarnessControlFrame(frame)).not.toThrow()
  })

  test('starting without a continuation no longer refuses to start', async () => {
    await expect(projectSessionConfig(undefined)).resolves.toBeDefined()
  })
})
