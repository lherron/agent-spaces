import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { postEnvelope } from '../../../src/drivers/hook-bridge-transport'
import {
  appServerBroker,
  eventTypes,
  scenarioSpec,
  userInput,
  waitForEvent,
} from './fake-codex-scenario'
import {
  expectDirectStartRejects,
  expectRendererControlSocket,
  paneLease,
  rendererLaunchLines,
  tmuxLines,
  viewerRuntime,
  withFakeTmux,
} from './viewer-lease'

/**
 * Start `stop-active` with a required HRC pane lease, submit one input, and
 * hand `fn` the renderer's fenced control socket.
 */
async function withRendererControl(
  name: string,
  fn: (ctx: {
    broker: ReturnType<typeof appServerBroker>['broker']
    events: InvocationEventEnvelope[]
    invocationId: string
    runtimeId: string
    controlSocket: string
  }) => Promise<void>
): Promise<InvocationEventEnvelope[]> {
  const { broker, events } = appServerBroker()
  const runtimeId = `runtime_codex_app_server_${name}`
  const lease = paneLease()
  const spec = scenarioSpec('stop-active', {
    invocationId: `inv_renderer_${name}`,
    correlation: { runtimeId },
  })

  await withFakeTmux(
    { sessionId: lease.sessionId, windowId: lease.windowId, paneId: lease.paneId },
    async (logPath) => {
      await broker.start({ spec }, undefined, viewerRuntime(lease, { required: true }))
      await broker.input({
        invocationId: spec.invocationId ?? '',
        input: userInput,
        policy: { whenBusy: 'reject' },
      })
      const controlSocket = expectRendererControlSocket(await tmuxLines(logPath))
      await fn({
        broker,
        events,
        invocationId: spec.invocationId ?? '',
        runtimeId,
        controlSocket,
      })
    }
  )
  return events
}

describe('Codex app-server viewer contract red tests (T-04908 Phase A)', () => {
  test('valid HRC tmux-pane lease is consumed and reported with exact inspected pane ids', async () => {
    const { broker, events } = appServerBroker()
    const lease = paneLease()
    const spec = scenarioSpec('start-fresh-turn')

    await withFakeTmux(
      { sessionId: lease.sessionId, windowId: lease.windowId, paneId: lease.paneId },
      async (logPath) => {
        await broker.start({ spec }, undefined, viewerRuntime(lease))

        // This pins Phase A to the shared consumePaneLease path: a green driver
        // must inspect the leased pane before reporting it, not trust the broker
        // window or an unvalidated runtime payload.
        const tmuxLog = await readFile(logPath, 'utf8').catch(() => '')
        expect(tmuxLog).toContain('-S /tmp/harness-broker/codex-app-server-viewer.sock')
        expect(tmuxLog).toContain('display-message')
        expect(tmuxLog).toContain('%42')
      }
    )

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal.surface.reported',
        payload: {
          kind: 'tmux-pane',
          socketPath: lease.socketPath,
          sessionId: lease.sessionId,
          windowId: lease.windowId,
          paneId: lease.paneId,
          sessionName: lease.sessionName,
          windowName: lease.windowName,
        },
        driver: { kind: 'codex-app-server', rawType: 'tmux.surface' },
      })
    )
    expect(JSON.stringify(events)).not.toContain('codex-cli-tmux')
    expect(spec.interaction?.mode).toBe('headless')
    expect(spec.process.harnessTransport.kind).toBe('jsonrpc-stdio')
  })

  test('viewer-required missing lease fails loudly with InvalidInvocationState', async () => {
    const { broker, events } = appServerBroker()

    await expect(
      broker.start(
        { spec: scenarioSpec('start-fresh-turn') },
        undefined,
        viewerRuntime(undefined, {
          required: true,
        })
      )
    ).rejects.toMatchObject({ code: BrokerErrorCode.InvalidInvocationState })
    expect(eventTypes(events)).not.toContain('invocation.ready')
    expect(eventTypes(events)).not.toContain('terminal.surface.reported')
  })

  test.each([
    {
      name: 'malformed terminal surface',
      runtime: viewerRuntime({ kind: 'tmux-pane' }, { required: true }),
    },
    {
      name: 'non-hrc ownership',
      runtime: viewerRuntime(paneLease({ ownership: 'driver' as never }), { required: true }),
    },
  ])('viewer-required rejects $name with InvalidInvocationState', async ({ runtime }) => {
    const events = await expectDirectStartRejects(runtime, {
      code: BrokerErrorCode.InvalidInvocationState,
    })
    expect(eventTypes(events)).not.toContain('invocation.ready')
    expect(eventTypes(events)).not.toContain('terminal.surface.reported')
  })

  test('viewer-required inspected id mismatch rejects the broker-window surface', async () => {
    const lease = paneLease()
    let events: InvocationEventEnvelope[] = []

    await withFakeTmux({ sessionId: '$9', windowId: '@4', paneId: '%99' }, async () => {
      events = await expectDirectStartRejects(viewerRuntime(lease, { required: true }), {
        code: BrokerErrorCode.InvalidInvocationState,
      })
    })
    expect(eventTypes(events)).not.toContain('invocation.ready')
    expect(eventTypes(events)).not.toContain('terminal.surface.reported')
  })
})

describe('Codex app-server renderer process red tests (T-04909 Phase B)', () => {
  test('viewer lease launches a driver-owned renderer command into the leased pane while JSON-RPC app-server remains authoritative', async () => {
    const { broker, events } = appServerBroker()
    const lease = paneLease()
    const spec = scenarioSpec('start-fresh-turn')

    await withFakeTmux(
      { sessionId: lease.sessionId, windowId: lease.windowId, paneId: lease.paneId },
      async (logPath) => {
        await broker.start({ spec }, undefined, viewerRuntime(lease, { required: true }))
        await broker.input({
          invocationId: spec.invocationId ?? '',
          input: userInput,
          policy: { whenBusy: 'reject' },
        })

        const lines = await tmuxLines(logPath)
        const launchLines = rendererLaunchLines(lines)

        // T-04909 Phase B: viewer mode needs a driver-owned presentation process
        // launched through TmuxPaneController.sendPastedLine(). The app-server
        // JSON-RPC child remains the harness transport; this forbids satisfying
        // viewer mode by swapping to codex-cli-tmux or only reporting the pane.
        expect(launchLines, `tmux log:\n${lines.join('\n')}`).toHaveLength(1)
        for (const line of launchLines) {
          expect(line).toContain('invocation.eventsSince')
          expect(line).toContain('invocation.event')
          expect(line).not.toContain('codex-cli-tmux')
        }
        expect(
          lines.some(
            (line) =>
              line.includes('-S /tmp/harness-broker/codex-app-server-viewer.sock') &&
              line.includes('load-buffer')
          )
        ).toBe(true)
        expect(
          lines.some(
            (line) =>
              line.includes('-S /tmp/harness-broker/codex-app-server-viewer.sock') &&
              line.includes('paste-buffer') &&
              line.includes('-t %42')
          )
        ).toBe(true)
      }
    )

    expect(eventTypes(events)).toContain('terminal.surface.reported')
    expect(eventTypes(events)).toContain('invocation.started')
    expect(eventTypes(events)).toContain('invocation.ready')
    expect(eventTypes(events)).toContain('turn.started')
    expect(eventTypes(events)).toContain('turn.completed')
    expect(spec.harness.driver).toBe('codex-app-server')
    expect(spec.interaction?.mode).toBe('headless')
    expect(spec.process.harnessTransport.kind).toBe('jsonrpc-stdio')
    expect(JSON.stringify(events)).not.toContain('codex-cli-tmux')
    expect(JSON.stringify(events)).not.toContain('brokerTerminal')
  })
})

describe('Codex app-server renderer /quit lifecycle red tests (T-04910 Phase C)', () => {
  test('fenced renderer /quit clears continuation, pushes summary, then exits the app-server child in order', async () => {
    const events = await withRendererControl(
      'quit_lifecycle',
      async ({ events, invocationId, runtimeId, controlSocket }) => {
        // Phase C contract: /quit is a renderer -> driver control envelope on a
        // fenced per-invocation callback socket, not a local renderer exit and
        // not the read-only observer event feed used for durable rendering.
        await postEnvelope(controlSocket, {
          type: 'app-server-renderer.quit',
          invocationId,
          runtimeId,
          callbackSocket: controlSocket,
          reason: 'prompt_input_exit',
        })

        await waitForEvent(events, (event) => event.type === 'invocation.exited')
      }
    )

    const types = eventTypes(events)
    const clearIdx = types.indexOf('continuation.cleared')
    const summaryIdx = types.indexOf('invocation.summary')
    const exitedIdx = types.indexOf('invocation.exited')

    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(events[clearIdx]?.payload).toMatchObject({ reason: 'prompt_input_exit' })
    expect(summaryIdx).toBeGreaterThan(clearIdx)
    expect(exitedIdx).toBeGreaterThan(summaryIdx)
    expect(types).not.toContain('turn.failed')
  })

  test('renderer /quit control envelopes with wrong invocation, runtime, or callback identity are ignored', async () => {
    const events = await withRendererControl(
      'quit_fencing',
      async ({ broker, invocationId, runtimeId, controlSocket }) => {
        const base = {
          type: 'app-server-renderer.quit',
          invocationId,
          runtimeId,
          callbackSocket: controlSocket,
          reason: 'prompt_input_exit',
        }

        await postEnvelope(controlSocket, { ...base, invocationId: 'inv_other' })
        await postEnvelope(controlSocket, { ...base, runtimeId: 'runtime_other' })
        await postEnvelope(controlSocket, { ...base, callbackSocket: `${controlSocket}.other` })
        await new Promise((resolve) => setTimeout(resolve, 50))

        await broker.stop({
          invocationId,
          reason: 'test cleanup after fenced control envelopes',
          graceMs: 100,
        })
      }
    )

    expect(eventTypes(events)).not.toContain('continuation.cleared')
    expect(eventTypes(events)).not.toContain('invocation.summary')
  })

  test('renderer crash without /quit emits a diagnostic/failure signal and never clears continuation as prompt exit', async () => {
    const events = await withRendererControl(
      'crash',
      async ({ broker, events, invocationId, runtimeId, controlSocket }) => {
        // Negative guard for the /quit path: an unexpected renderer process
        // failure is lifecycle degradation, not user intent. A green driver
        // owns the renderer child and handles this crash envelope without
        // emitting continuation.cleared(prompt_input_exit).
        await postEnvelope(controlSocket, {
          type: 'app-server-renderer.exited',
          invocationId,
          runtimeId,
          callbackSocket: controlSocket,
          exitCode: 42,
          signal: null,
        })

        await waitForEvent(
          events,
          (event) =>
            (event.type === 'diagnostic' || event.type === 'invocation.failed') &&
            JSON.stringify(event.payload).includes('renderer')
        )

        await broker.stop({
          invocationId,
          reason: 'test cleanup after renderer crash signal',
          graceMs: 100,
        })
      }
    )

    const cleared = events.filter((event) => event.type === 'continuation.cleared')
    expect(cleared).toHaveLength(0)
    expect(JSON.stringify(events)).not.toContain('prompt_input_exit')
  })
})
