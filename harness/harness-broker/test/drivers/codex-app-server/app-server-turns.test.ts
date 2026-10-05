import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createEventLedger } from '../../../src/event-ledger'
import {
  appServerBroker,
  eventTypes,
  fixtureDir,
  goldenDir,
  repoRoot,
  runScenario,
  scenarioSpec,
  userInput,
  waitForEvent,
} from './fake-codex-scenario'
import { expectGolden } from './golden-events'

describe('Codex app-server golden scenarios', () => {
  test('golden fixtures stay independent of the checkout path used by drain worktrees', async () => {
    // T-05831: drain-depth worktrees live under under-construction, so app-server
    // golden expectations must not bake in the canonical repo checkout path.
    const files = (await readdir(goldenDir)).filter((file) => file.endsWith('.golden.jsonl'))
    const checkoutSpecificFixtures: string[] = []

    for (const file of files) {
      const contents = await readFile(join(goldenDir, file), 'utf8')
      if (
        contents.includes('/Users/lherron/praesidium/agent-spaces/') ||
        contents.includes('/under-construction/')
      ) {
        checkoutSpecificFixtures.push(file)
      }
    }

    expect(checkoutSpecificFixtures).toEqual([])
  })

  test.each([
    ['starts a fresh thread and completes a turn', 'start-fresh-turn'],
    ['maps assistant message deltas and final message content', 'assistant-deltas'],
    [
      'maps command, file change, MCP tool, web search, and image view items to tool events',
      'tool-calls',
    ],
    ['maps token usage updates', 'usage-update'],
    [
      'maps child exit during an active turn to turn.failed and invocation.exited',
      'exit-during-turn',
    ],
  ])('%s', async (_name, scenario) => {
    const events = await runScenario(scenario)
    await expectGolden(scenario, events)
  })

  test('resumes an existing thread and completes a turn', async () => {
    const events = await runScenario('resume-existing-turn', {
      continuation: { provider: 'codex', kind: 'thread', key: 'thread_existing' },
      driver: {
        kind: 'codex-app-server',
        resumeThreadId: 'thread_existing',
        resumeFallback: 'fail',
      },
    })
    await expectGolden('resume-existing-turn', events)
  })

  test('falls back to a fresh thread when resume target is missing and fallback is start-fresh', async () => {
    const events = await runScenario('resume-missing-start-fresh', {
      driver: {
        kind: 'codex-app-server',
        resumeThreadId: 'thread_missing',
        resumeFallback: 'start-fresh',
      },
    })
    await expectGolden('resume-missing-start-fresh', events)
  })

  test('fails startup when resume target is missing and fallback is fail', async () => {
    const { broker, events } = appServerBroker()
    await expect(
      broker.start({
        spec: scenarioSpec('resume-missing-fail', {
          driver: {
            kind: 'codex-app-server',
            resumeThreadId: 'thread_missing',
            resumeFallback: 'fail',
          },
        }),
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.HarnessError })
    await expectGolden('resume-missing-fail', events)
  })

  test('surfaces an unknown native notification as a trace diagnostic without leaking the native type', async () => {
    const events = await runScenario('unknown-notification')
    const types = events.map((event) => event.type)
    // The unknown native method must never appear as a normalized event type.
    expect(types).not.toContain('thread/experimentalSignal')
    const diagnostic = events.find(
      (event) =>
        event.type === 'diagnostic' &&
        (event.payload as { message?: string }).message?.includes('thread/experimentalSignal')
    )
    expect(diagnostic).toBeDefined()
    expect((diagnostic?.payload as { level: string }).level).toBe('debug')
    expect(diagnostic?.driver).toEqual({
      kind: 'codex-app-server',
      rawType: 'thread/experimentalSignal',
    })
    // Native params ride verbatim on payload.data.params through the full driver
    // pipeline, not just the mapper unit (T-05219).
    expect((diagnostic?.payload as { data?: unknown }).data).toEqual({
      params: { detail: 'not-in-the-contract', nested: { count: 3, items: ['a', 'b'] } },
    })
    await expectGolden('unknown-notification', events)
  })

  test('stops an active invocation with graceful child termination', async () => {
    const { broker, events } = appServerBroker()
    await broker.start({ spec: scenarioSpec('stop-active') })
    await broker.input({ invocationId: 'inv_stop_active', input: userInput })
    await broker.stop({
      invocationId: 'inv_stop_active',
      reason: 'operator stop',
      graceMs: 500,
    })
    await expectGolden('stop-active', events)
  })

  test('rejects unsupported legacy steer and append_context operations', async () => {
    const { broker, events } = appServerBroker()
    await broker.start({ spec: scenarioSpec('unsupported-controls') })

    await expect(
      broker.input({
        invocationId: 'inv_unsupported_controls',
        input: { ...userInput, inputId: 'steer_1', kind: 'steer' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })

    await expect(
      broker.input({
        invocationId: 'inv_unsupported_controls',
        input: { ...userInput, inputId: 'append_1', kind: 'append_context' },
        policy: { whenBusy: 'reject' },
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.UnsupportedCapability })

    await expect(
      broker.interrupt({
        invocationId: 'inv_unsupported_controls',
        scope: 'turn',
        reason: 'red test',
      })
    ).resolves.toEqual({
      accepted: false,
      effect: 'no_active_turn',
    })

    await expectGolden('unsupported-controls', events)
  })
})

describe('Codex app-server turn brackets and input', () => {
  test('returns the turn/start response id and brackets that id on first and same-thread second turns', async () => {
    const { broker, events } = appServerBroker()
    const spec = scenarioSpec('three-turns')
    await broker.start({ spec })

    const first = await broker.input({
      invocationId: spec.invocationId ?? '',
      input: userInput,
      policy: { whenBusy: 'reject' },
    })
    await waitForEvent(
      events,
      (event) => event.type === 'turn.completed' && event.turnId === 'turn_1'
    )
    const second = await broker.input({
      invocationId: spec.invocationId ?? '',
      input: { ...userInput, inputId: 'input_2' },
      policy: { whenBusy: 'reject' },
    })

    expect(first.turnId).toBe('turn_1')
    expect(second.turnId).toBe('turn_2')
    expect(
      events.filter((event) => event.type === 'turn.started').map((event) => event.turnId)
    ).toEqual(['turn_1', 'turn_2'])
    expect(events.filter((event) => event.type === 'capture.warning')).toHaveLength(0)
  })

  test('reports a turn/started record whose id differs from the turn/start response id', async () => {
    const { broker, events } = appServerBroker()
    const spec = scenarioSpec('turn-start-id-mismatch')
    await broker.start({ spec })

    const response = await broker.input({
      invocationId: spec.invocationId ?? '',
      input: userInput,
      policy: { whenBusy: 'reject' },
    })
    await waitForEvent(events, (event) => event.type === 'capture.warning')

    expect(response.turnId).toBe('turn_acknowledged')
    expect(
      events.some((event) => event.type === 'turn.started' && event.turnId === 'turn_different')
    ).toBe(false)
    const warning = events.find((event) => event.type === 'capture.warning')
    expect(warning?.payload).toMatchObject({
      kind: 'blocked_unknown',
      message:
        'Codex turn/start response id turn_acknowledged does not match turn/started id turn_different',
      raw: {
        nativeType: 'turn/started',
        family: 'turn-bracket',
        // The loudest class — a bracket the broker cannot attribute — but the
        // cursor advances past it (T-07883).
        loadBearing: true,
        cursorHalted: false,
      },
    })
  })

  test('legacy no-lease start stays pure headless with no reported terminal surface', async () => {
    const { broker, events } = appServerBroker()
    const spec = scenarioSpec('start-fresh-turn')

    await broker.start({ spec })
    await broker.input({
      invocationId: spec.invocationId ?? '',
      input: userInput,
      policy: { whenBusy: 'reject' },
    })

    expect(spec.harness.driver).toBe('codex-app-server')
    expect(spec.interaction?.mode).toBe('headless')
    expect(spec.process.harnessTransport.kind).toBe('jsonrpc-stdio')
    expect(eventTypes(events)).toContain('invocation.started')
    expect(eventTypes(events)).toContain('invocation.ready')
    expect(eventTypes(events)).toContain('turn.started')
    expect(eventTypes(events)).not.toContain('terminal.surface.reported')
    expect(JSON.stringify(events)).not.toContain('codex-cli-tmux')
    expect(JSON.stringify(events)).not.toContain('brokerTerminal')
  })

  test('applied app-server input emits durable user.message with input id and text', async () => {
    const events = await runScenario('start-fresh-turn')

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user.message',
        inputId: userInput.inputId,
        payload: {
          content: 'Please respond.',
          inputId: userInput.inputId,
          role: 'user',
        },
        driver: { kind: 'codex-app-server', rawType: 'broker.input' },
      })
    )
    expect(eventTypes(events)).toContain('input.accepted')
  })

  test('reports provider transcript provenance through live and durable broker streams', async () => {
    const { broker, events } = appServerBroker({ eventLedger: createEventLedger() })
    const spec = scenarioSpec('start-fresh-turn')

    await broker.start({ spec })
    await broker.input({
      invocationId: spec.invocationId ?? '',
      input: userInput,
      policy: { whenBusy: 'reject' },
    })
    await waitForEvent(events, (event) => (event.type as string) === 'provider.transcript.reported')

    const replay = await broker.eventsSince({
      invocationId: spec.invocationId ?? '',
      afterSeq: 0,
    })
    const liveReports = events.filter(
      (event) => (event.type as string) === 'provider.transcript.reported'
    )
    const replayReports = replay.events.filter(
      (event) => (event.type as string) === 'provider.transcript.reported'
    )

    // T-05374: the driver must emit through DriverContext.emit so both the live
    // listener and durable EventLedger replay observe the same provenance event.
    expect(liveReports).toHaveLength(1)
    expect(replayReports).toHaveLength(1)
    expect(replayReports[0]).toEqual(liveReports[0])

    const report = liveReports[0] as InvocationEventEnvelope<{
      kind?: unknown
      artifactPath?: unknown
      provider?: unknown
    }>
    expect(report.payload).toMatchObject({
      kind: 'provider-transcript-jsonl',
      provider: 'codex',
    })
    expect(report.driver).toEqual({
      kind: 'codex-app-server',
      rawType: expect.stringMatching(/provider-transcript|transcript/),
    })
    expect(typeof report.payload.artifactPath).toBe('string')
    expect(isAbsolute(report.payload.artifactPath as string)).toBe(true)

    const rawJsonl = await readFile(report.payload.artifactPath as string, 'utf8')
    const rows = rawJsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { jsonrpc?: unknown; method?: unknown; params?: unknown })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toContainEqual(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: expect.objectContaining({ turnId: 'turn_1' }),
      })
    )
    expect(rows.every((row) => row.jsonrpc === '2.0' && typeof row.method === 'string')).toBe(true)
    expect(rows.some((row) => row.method === 'turn.completed')).toBe(false)
  })

  test.todo('permission request policies are Phase 3 scope per T-01544')

  test('encodes sandboxMode as Codex internally tagged sandboxPolicy', async () => {
    const { broker, events } = appServerBroker()
    const spec = scenarioSpec('sandbox-policy-encoding', {
      driver: {
        kind: 'codex-app-server',
        sandboxMode: 'workspace-write',
        resumeFallback: 'start-fresh',
        permissionPolicy: { mode: 'deny' },
      },
    })

    await broker.start({ spec })
    await expect(
      broker.input({
        invocationId: spec.invocationId ?? '',
        input: userInput,
        policy: { whenBusy: 'reject' },
      })
    ).resolves.toMatchObject({ accepted: true })

    expect(events.map((event) => event.type)).toContain('turn.started')
  })

  test('interrupts the active Codex turn with exact thread and turn ids', async () => {
    const { broker } = appServerBroker()
    await broker.start({ spec: scenarioSpec('interrupt-active') })
    await broker.input({ invocationId: 'inv_interrupt_active', input: userInput })

    await expect(
      broker.interrupt({
        invocationId: 'inv_interrupt_active',
        scope: 'turn',
        reason: 'unit test',
      })
    ).resolves.toEqual({ accepted: true, effect: 'turn_interrupted' })

    await broker.stop({ invocationId: 'inv_interrupt_active', reason: 'test done' })
  })
})

describe('Codex app-server process behavior', () => {
  test('spawns exact argv without shell expansion', async () => {
    const events = await runScenario('argv-exact')
    const started = events.find((event) => event.type === 'invocation.started')
    expect(started?.payload).toMatchObject({
      command: process.execPath,
      args: [join(fixtureDir, 'argv-exact.ts'), '--literal', '$NO_EXPAND', '*.ts'],
      cwd: repoRoot,
    })
  })

  test('missing cwd fails with ResourceError before spawning', async () => {
    const { broker } = appServerBroker()
    await expect(
      broker.start({
        spec: scenarioSpec('start-fresh-turn', {
          process: {
            ...scenarioSpec('start-fresh-turn').process,
            cwd: join(repoRoot, 'does-not-exist-for-harness-broker-red-test'),
          },
        }),
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.ResourceError })
  })

  test('does not leak env values into invocation.started or other event payloads', async () => {
    const events = await runScenario('start-fresh-turn')
    const eventJson = JSON.stringify(events)
    expect(eventJson).not.toContain('red-test-secret-value')
    expect(eventJson).not.toContain('/tmp/harness-broker-codex-home')
  })
})
