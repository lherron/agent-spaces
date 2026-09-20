/**
 * muse-serve driver tests (T-08589, campaign P-00522).
 *
 * Broker-level lifecycle against the fake MSP peer
 * (test/fixtures/fake-muse/serve.ts) plus the narrow applySteerNow contract
 * at driver level. No binary, no credentials: the fake speaks the
 * spike-probed surface (initialize fingerprint, session/start, turn/start
 * ack, turn/completed, commandRejected/missing_run).
 */
import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationRuntimeContext,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import type { Driver } from '../../../src/drivers/driver'
import { deliveryEvidenceOf } from '../../../src/drivers/driver'
import { MUSE_CAPABILITIES } from '../../../src/drivers/muse-serve/capabilities'
import { createMuseServeDriver } from '../../../src/drivers/muse-serve/driver'

const root = new URL('../../..', import.meta.url).pathname
const fixture = join(root, 'test/fixtures/fake-muse/serve.ts')
const now = () => new Date('2026-09-17T19:00:00.000Z')

const scenarioSpec = (
  scenario: string,
  invocationId: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'muse-cli', provider: 'meta', driver: 'muse-serve' },
  process: {
    command: process.execPath,
    args: [fixture, scenario],
    cwd: process.cwd(),
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 5000, turnTimeoutMs: 10000, stopGraceMs: 500 },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
  driver: {
    kind: 'muse-serve',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
  ...overrides,
})

const userInput = (inputId: string, text: string) => ({
  inputId,
  kind: 'user' as const,
  content: [{ type: 'text' as const, text }],
})

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

type TerminalSurfaceLease = NonNullable<InvocationRuntimeContext['terminalSurface']>

const rendererLease = (): TerminalSurfaceLease => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/harness-broker/muse-renderer.sock',
  sessionId: '$8',
  windowId: '@3',
  paneId: '%41',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true, capture: true },
})

async function withSwallowedRendererTmux<T>(
  lease: TerminalSurfaceLease,
  fn: () => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'muse-serve-tmux-'))
  const tmuxPath = join(dir, 'tmux')
  const commandPath = join(dir, 'command')
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
if [[ "$1" == "-S" ]]; then shift 2; fi
if [[ "$1" == "display-message" ]]; then
  printf '%s\\t%s\\t%s\\n' '${lease.sessionId}' '${lease.windowId}' '${lease.paneId}'
  exit 0
fi
if [[ "$1" == "load-buffer" ]]; then
  cat "${'${@: -1}'}" > ${JSON.stringify(commandPath)}
  exit 0
fi
if [[ "$1" == "capture-pane" ]]; then
  cat ${JSON.stringify(commandPath)} 2>/dev/null || true
  exit 0
fi
if [[ "$1" == "delete-buffer" || "$1" == "paste-buffer" || "$1" == "send-keys" ]]; then exit 0; fi
exit 64
`
  )
  await chmod(tmuxPath, 0o755)
  const previousPath = process.env['PATH']
  process.env['PATH'] = previousPath === undefined ? dir : `${dir}:${previousPath}`
  try {
    return await fn()
  } finally {
    if (previousPath === undefined) process.env['PATH'] = undefined
    else process.env['PATH'] = previousPath
    await rm(dir, { recursive: true, force: true })
  }
}

describe('muse-serve driver', () => {
  test('advertises the muse-serve capability surface', async () => {
    const broker = createBroker({ drivers: [createMuseServeDriver()], now })
    const spec = scenarioSpec('ok', 'inv_muse_caps')
    const started = await broker.start({ spec })
    expect(started.capabilities.admission.classes).toEqual([
      'steer',
      'queue',
      'exclusive',
      'preempt',
    ])
    expect(started.capabilities.bracketMintingMode).toBe('delivery-acknowledged')
    expect(started.capabilities.continuation).toMatchObject({
      provider: 'muse',
      keyKind: 'session',
    })
    expect(started.capabilities.turns).toMatchObject({
      concurrency: 'single',
      interrupt: 'protocol',
    })
    await broker.stop({ invocationId: spec.invocationId! })
  })

  test('runs an input to turn.completed with usage', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('ok', 'inv_muse_ok')
    await broker.start({ spec })
    const result = await broker.input({
      invocationId: 'inv_muse_ok',
      input: userInput('input_ok', 'say ECHO'),
    })
    expect(result.turnId).toBeString()
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.payload.turnId === result.turnId
      )
    )
    expect(events.some((event) => event.type === 'usage.updated')).toBe(true)
    await broker.stop({ invocationId: 'inv_muse_ok' })
  })

  test('holds assistant completions: intermediate final:false, last final:true before turn.completed', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('multi', 'inv_muse_multi')
    await broker.start({ spec })
    await broker.input({
      invocationId: 'inv_muse_multi',
      input: userInput('input_multi', 'two messages'),
    })
    await waitFor(() =>
      events.some((event) => event.type === 'turn.completed' && event.payload.turnId !== undefined)
    )
    const completions = events.filter((event) => event.type === 'assistant.message.completed')
    expect(completions.map((event) => event.payload.final)).toEqual([false, false, true])
    expect(JSON.stringify(completions[0]?.payload)).toContain('streamed run')
    expect(JSON.stringify(completions[1]?.payload)).toContain('first message')
    expect(JSON.stringify(completions[2]?.payload)).toContain('second message')
    const terminalIndex = events.findIndex((event) => event.type === 'turn.completed')
    const finalIndex = events.findIndex(
      (event) => event.type === 'assistant.message.completed' && event.payload.final === true
    )
    expect(finalIndex).toBeGreaterThanOrEqual(0)
    expect(finalIndex).toBeLessThan(terminalIndex)
    await broker.stop({ invocationId: 'inv_muse_multi' })
  })

  test('steers the active turn and observes the steered text', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('long', 'inv_muse_steer')
    await broker.start({ spec })
    await broker.input({
      invocationId: 'inv_muse_steer',
      input: userInput('input_long', 'long task'),
    })
    await waitFor(() => events.some((event) => event.type === 'turn.started'))

    const response = await broker.steer({
      invocationId: 'inv_muse_steer',
      origin: { principalRef: 'agent:muse-steer-test', scopeRef: 'muse-steer-test@agent-spaces' },
      body: 'STOP - do not push',
    })
    expect(response.admission).toBe('admitted')
    await waitFor(() =>
      events.some(
        (event) => event.type === 'assistant.message.delta' && event.payload.text === 'steered'
      )
    )
    await broker.stop({ invocationId: 'inv_muse_steer' })
  })

  test('steer absorbed after a native turn roll re-arms instead of failing', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('steer-roll', 'inv_muse_steer_roll')
    await broker.start({ spec })
    await broker.input({
      invocationId: 'inv_muse_steer_roll',
      input: userInput('input_roll', 'long task'),
    })
    await waitFor(() => events.some((event) => event.type === 'turn.started'))

    const response = await broker.steer({
      invocationId: 'inv_muse_steer_roll',
      origin: { principalRef: 'agent:muse-steer-test', scopeRef: 'muse-steer-test@agent-spaces' },
      body: 'STOP - do not push',
    })
    expect(response.admission).toBe('admitted')
    // The roll is absorbed, not failed: an info diagnostic names the
    // absorbing turn, and no armed-identity error is emitted.
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'diagnostic' &&
          event.payload.message === 'muse turn/steer absorbed after native turn roll'
      )
    )
    expect(
      events.some(
        (event) =>
          event.type === 'diagnostic' &&
          typeof event.payload.message === 'string' &&
          event.payload.message.includes('armed turn identity')
      )
    ).toBe(false)
    await waitFor(() =>
      events.some(
        (event) => event.type === 'assistant.message.delta' && event.payload.text === 'steered'
      )
    )
    await broker.stop({ invocationId: 'inv_muse_steer_roll' })
  })

  test('interrupts the running turn via turn/interrupt', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('long', 'inv_muse_interrupt')
    await broker.start({ spec })
    await broker.input({
      invocationId: 'inv_muse_interrupt',
      input: userInput('input_i', 'long task'),
    })
    await waitFor(() => events.some((event) => event.type === 'turn.started'))

    await expect(
      broker.interrupt({ invocationId: 'inv_muse_interrupt', scope: 'turn', reason: 'unit test' })
    ).resolves.toEqual({ accepted: true, effect: 'turn_interrupted' })
    await waitFor(() => events.some((event) => event.type === 'turn.interrupted'))
    await broker.stop({ invocationId: 'inv_muse_interrupt' })
  })

  test('rejects startup on schema fingerprint mismatch', async () => {
    const broker = createBroker({ drivers: [createMuseServeDriver()], now })
    const spec = scenarioSpec('bad-fingerprint', 'inv_muse_badfp')
    await expect(broker.start({ spec })).rejects.toThrow('fingerprint mismatch')
  })

  test('fails closed before invocation readiness when the observer submit is swallowed', async () => {
    const invocationId = 'inv_muse_renderer_submit_lost'
    const events: InvocationEventEnvelope[] = []
    const lease = rendererLease()
    const driver = createMuseServeDriver()
    const ctx = {
      invocationId,
      clientCapabilities: {},
      runtime: { terminalSurface: lease },
      emit(
        type: InvocationEventEnvelope['type'],
        payload: unknown,
        extra?: Record<string, unknown>
      ) {
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
    } as Parameters<ReturnType<typeof createMuseServeDriver>['start']>[1]
    const originalNow = Date.now
    let syntheticNow = originalNow()
    Date.now = () => syntheticNow
    const clock = setInterval(() => {
      syntheticNow += 3_000
    }, 10)
    try {
      await withSwallowedRendererTmux(lease, async () => {
        const start = driver.start(scenarioSpec('ok', invocationId), ctx)
        // The first capture confirms the paste; the synthetic monotonic wall
        // clock then makes each swallowed-submit confirmation expire without
        // spending the production 1.5s per retry in this test.
        await expect(start).rejects.toThrow('submit_not_confirmed')
      })
    } finally {
      clearInterval(clock)
      Date.now = originalNow
      await driver.dispose()
    }
    expect(events.map((event) => event.type)).not.toContain('invocation.started')
    expect(events.map((event) => event.type)).not.toContain('invocation.ready')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'diagnostic',
        payload: expect.objectContaining({
          message: 'muse renderer launch not confirmed; refusing invocation readiness',
          data: expect.objectContaining({
            confirmation: expect.objectContaining({ phase: 'submit_not_confirmed' }),
          }),
        }),
      })
    )
  })

  test('decides approval by policy allow with the approved choice', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('approve', 'inv_muse_allow', {
      driver: {
        kind: 'muse-serve',
        resumeFallback: 'start-fresh',
        permissionPolicy: { mode: 'allow' },
      },
    })
    await broker.start({ spec })
    await broker.input({
      invocationId: 'inv_muse_allow',
      input: userInput('input_a', 'list files'),
    })
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'assistant.message.completed' &&
          JSON.stringify(event.payload).includes('decided:allow-once')
      )
    )
    expect(
      events.some(
        (event) =>
          event.type === 'permission.requested' &&
          event.payload.permissionRequestId.startsWith('perm_inv_muse_allow')
      )
    ).toBe(true)
    await broker.stop({ invocationId: 'inv_muse_allow' })
  })

  test('decides approval by policy deny with the denied choice', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('approve', 'inv_muse_deny')
    await broker.start({ spec })
    await broker.input({ invocationId: 'inv_muse_deny', input: userInput('input_d', 'list files') })
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'assistant.message.completed' &&
          JSON.stringify(event.payload).includes('decided:deny-once')
      )
    )
    await broker.stop({ invocationId: 'inv_muse_deny' })
  })

  test('resumes a known session id', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createMuseServeDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('ok', 'inv_muse_resume', {
      continuation: { provider: 'muse', kind: 'session', key: 'sess_known' },
      driver: { kind: 'muse-serve', resumeFallback: 'fail', resumeSessionId: 'sess_known' },
    })
    await broker.start({ spec })
    expect(
      events.some(
        (event) =>
          event.type === 'continuation.updated' &&
          event.payload.key === 'sess_known' &&
          event.payload.provider === 'muse'
      )
    ).toBe(true)
    await broker.stop({ invocationId: 'inv_muse_resume' })
  })

  test('applySteerNow before start throws not_written', async () => {
    const driver: Driver = createMuseServeDriver()
    const error = await driver.applySteerNow!({
      kind: 'user',
      content: [{ type: 'text', text: 'x' }],
    }).then(
      () => null,
      (failure: unknown) => failure
    )
    expect(error).toSatisfy((failure: unknown) => deliveryEvidenceOf(failure) === 'not_written')
    expect(driver.capabilities()).toEqual(MUSE_CAPABILITIES)
  })
})
