import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../../../src/drivers/driver'

type TmuxExecCall = { argv: string[]; env?: Record<string, string | undefined> | undefined }

type LaunchArtifact = {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined> | undefined
}

const invocationId = 'inv_pi_tui_tmux_driver_1'
const now = () => new Date('2026-06-17T04:45:00.000Z')

const piTmuxSpec = (): HarnessInvocationSpec =>
  ({
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'pi-cli', provider: 'openai', driver: 'pi-tui-tmux' },
    process: {
      command: '/opt/bin/pi',
      args: ['--no-context-files', '--extension', '/tmp/asp-hrc-events.bridge.js'],
      cwd: process.cwd(),
      lockedEnv: { PI_CODING_AGENT_DIR: '/tmp/pi-bundle' },
      harnessTransport: { kind: 'pty' },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'pi-tui-tmux', terminalHost: 'tmux', hookBridge: 'pi-hrc-events/v1' },
    correlation: { hostSessionId: 'host-pi-driver', runtimeId: 'runtime-pi-driver' },
  }) as HarnessInvocationSpec

const paneLease = () => ({
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/harness-broker/pi-tmux.sock',
  sessionId: '$9',
  windowId: '@4',
  paneId: '%42',
  sessionName: 'hrc-owned-pi',
  windowName: 'main',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true },
})

const createCtx = (events: InvocationEventEnvelope[]): DriverContext =>
  ({
    invocationId,
    clientCapabilities: {},
    runtime: { terminalSurface: paneLease() },
    dispatchEnv: { ASP_PROJECT: 'agent-spaces' },
    emit(type, payload, extra) {
      const event = {
        invocationId,
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  }) as DriverContext

const recordingExec = (calls: TmuxExecCall[]) => {
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    if (argv.includes('display-message')) return { stdout: '$9\t@4\t%42\n', stderr: '' }
    if (argv.includes('capture-pane')) return { stdout: '$ pi\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
}

function launchArtifact(calls: TmuxExecCall[]): LaunchArtifact {
  const pasted = calls
    .map((call) => call.argv)
    .filter((argv) => argv.includes('set-buffer'))
    .map((argv) => argv.at(-1) ?? '')
    .find((text) => text.includes('.pi.launch.json'))
  if (pasted === undefined) throw new Error('tmux launch artifact command was not pasted')
  const match = pasted.match(/\/tmp\/[^ ]+\.pi\.launch\.json/)
  if (match === null) throw new Error(`unable to parse launch artifact path from: ${pasted}`)
  return JSON.parse(readFileSync(match[0], 'utf8')) as LaunchArtifact
}

describe('pi-tui-tmux driver', () => {
  test('consumes an hrc-owned pane lease, reports the pane, and launches Pi with broker hook env', async () => {
    const target = (await import('../../../src/drivers/pi-tui-tmux/driver')) as {
      createPiTuiTmuxDriver: typeof import(
        '../../../src/drivers/pi-tui-tmux/driver'
      ).createPiTuiTmuxDriver
    }
    const calls: TmuxExecCall[] = []
    const events: InvocationEventEnvelope[] = []
    let hookHandler: ((envelope: unknown) => Promise<void>) | undefined
    const driver = target.createPiTuiTmuxDriver({
      tmux: { exec: recordingExec(calls) },
      hooks: {
        listen: async (handler) => {
          hookHandler = handler as (envelope: unknown) => Promise<void>
          return { socketPath: '/tmp/harness-broker/pi-hooks.sock', close: async () => {} }
        },
        bridgeCommand: 'bun packages/harness-broker/bin/harness-broker.js pi-hook',
      },
      now,
    })

    await driver.start(piTmuxSpec(), createCtx(events))
    await hookHandler?.({
      invocationId,
      generation: 1,
      callbackSocket: '/tmp/harness-broker/pi-hooks.sock',
      runtimeId: 'runtime-pi-driver',
      hookData: { eventName: 'session_start', payload: { sessionId: 'pi-session-from-hook' } },
    })

    expect(events[0]).toMatchObject({
      type: 'terminal.surface.reported',
      driver: { kind: 'pi-tui-tmux', rawType: 'tmux.surface' },
      payload: {
        kind: 'tmux-pane',
        socketPath: '/tmp/harness-broker/pi-tmux.sock',
        sessionId: '$9',
        windowId: '@4',
        paneId: '%42',
      },
    })
    expect(events[1]).toMatchObject({
      type: 'continuation.updated',
      driver: { kind: 'pi-tui-tmux', rawType: 'session_start' },
      payload: { provider: 'openai', kind: 'session', key: 'pi-session-from-hook' },
    })
    const artifact = launchArtifact(calls)
    expect(artifact.argv).toEqual([
      '/opt/bin/pi',
      '--no-context-files',
      '--extension',
      '/tmp/asp-hrc-events.bridge.js',
    ])
    expect(artifact.env).toMatchObject({
      PI_CODING_AGENT_DIR: '/tmp/pi-bundle',
      ASP_PROJECT: 'agent-spaces',
      HRC_LAUNCH_HOOK_CLI: '/tmp/harness-broker/pi-hooks.sock.pi-hook.ts',
      HARNESS_BROKER_INVOCATION_ID: invocationId,
      HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/harness-broker/pi-hooks.sock',
      HARNESS_BROKER_RUNTIME_ID: 'runtime-pi-driver',
    })
  })
})
