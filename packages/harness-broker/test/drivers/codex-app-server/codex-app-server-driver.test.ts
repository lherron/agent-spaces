import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationRuntimeContext,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import {
  buildThreadStartParams,
  createCodexAppServerDriver,
  validateInitializeHandshake,
} from '../../../src/drivers/codex-app-server/driver'

const root = new URL('../../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const goldenDir = join(root, 'testdata/codex-app-server/v0')

const now = () => new Date('2026-05-20T18:00:00.000Z')

const scenarioSpec = (
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: `inv_${scenario.replaceAll('-', '_')}`,
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, `${scenario}.ts`), '--literal', '$NO_EXPAND', '*.ts'],
    cwd: process.cwd(),
    lockedEnv: {
      CODEX_HOME: '/tmp/harness-broker-codex-home',
      ASP_RED_TEST_VALUE: 'red-test-secret-value',
    },
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: {
      startupTimeoutMs: 5000,
      turnTimeoutMs: 5000,
      stopGraceMs: 500,
    },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'codex-app-server',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
  ...overrides,
})

const userInput = {
  inputId: 'input_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Please respond.' }],
}

type TerminalSurfaceLease = NonNullable<InvocationRuntimeContext['terminalSurface']>
type ViewerRuntime = InvocationRuntimeContext & {
  terminalSurfaceRequired?: true | undefined
}

const paneLease = (overrides: Partial<TerminalSurfaceLease> = {}): TerminalSurfaceLease => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/harness-broker/codex-app-server-viewer.sock',
  sessionId: '$9',
  windowId: '@4',
  paneId: '%42',
  sessionName: 'hrc-owned-codex-app-server',
  windowName: 'tui',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true },
  ...overrides,
})

const viewerRuntime = (
  terminalSurface?: unknown,
  options: { required?: boolean } = {}
): ViewerRuntime =>
  ({
    ...(terminalSurface !== undefined ? { terminalSurface } : {}),
    ...(options.required === true ? { terminalSurfaceRequired: true } : {}),
  }) as ViewerRuntime

async function withFakeTmux<T>(
  inspected: { sessionId: string; windowId: string; paneId: string },
  fn: (logPath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-tmux-'))
  const tmuxPath = join(dir, 'tmux')
  const logPath = join(dir, 'tmux.log')
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "-S" ]]; then
  shift 2
fi
if [[ "$1" == "display-message" ]]; then
  printf '${inspected.sessionId}\\t${inspected.windowId}\\t${inspected.paneId}\\n'
  exit 0
fi
printf 'unexpected fake tmux argv: %s\\n' "$*" >&2
exit 64
`
  )
  await chmod(tmuxPath, 0o755)

  const previousPath = process.env['PATH']
  process.env['PATH'] =
    previousPath === undefined || previousPath.length === 0 ? dir : `${dir}:${previousPath}`
  try {
    return await fn(logPath)
  } finally {
    if (previousPath === undefined) {
      process.env['PATH'] = undefined
    } else {
      process.env['PATH'] = previousPath
    }
    await rm(dir, { recursive: true, force: true })
  }
}

const eventTypes = (events: InvocationEventEnvelope[]) => events.map((event) => event.type)

const createDriverCtx = (events: InvocationEventEnvelope[], runtime: ViewerRuntime) =>
  ({
    invocationId: 'inv_direct_viewer_required',
    clientCapabilities: {},
    runtime,
    emit(type: InvocationEventEnvelope['type'], payload: unknown, extra?: Record<string, unknown>) {
      const event = {
        invocationId: 'inv_direct_viewer_required',
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  }) as Parameters<ReturnType<typeof createCodexAppServerDriver>['start']>[1]

async function expectDirectStartRejects(
  runtime: ViewerRuntime,
  expected: { code: BrokerErrorCode }
): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const driver = createCodexAppServerDriver()
  try {
    await expect(
      driver.start(scenarioSpec('start-fresh-turn'), createDriverCtx(events, runtime))
    ).rejects.toMatchObject(expected)
  } finally {
    await driver.dispose()
  }
  return events
}

function normalizeEvent(event: InvocationEventEnvelope): InvocationEventEnvelope {
  return JSON.parse(
    JSON.stringify(event, (key, value) => {
      if (key === 'time') return '<time>'
      if (key === 'pid') return '<pid>'
      if (key === 'durationMs') return '<durationMs>'
      if (key === 'command' && value === Bun.execPath) return '<bun>'
      if (key === 'cwd' && value === process.cwd()) return '<cwd>'
      return value
    })
  ) as InvocationEventEnvelope
}

async function expectGolden(scenario: string, events: InvocationEventEnvelope[]): Promise<void> {
  const actual = `${events.map((event) => JSON.stringify(normalizeEvent(event))).join('\n')}\n`
  const goldenPath = join(goldenDir, `${scenario}.golden.jsonl`)
  // Set UPDATE_GOLDEN=1 to regenerate fixtures after a deliberate contract change.
  if (process.env['UPDATE_GOLDEN'] === '1') {
    await writeFile(goldenPath, actual)
    return
  }
  const expected = await readFile(goldenPath, 'utf8')
  expect(actual).toBe(expected)
}

async function runScenario(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [createCodexAppServerDriver()],
    onEvent: (event) => events.push(event),
    now,
  })
  const spec = scenarioSpec(scenario, overrides)

  await broker.start({ spec })
  await broker.input({
    invocationId: spec.invocationId ?? '',
    input: userInput,
    policy: { whenBusy: 'reject' },
  })

  return events
}

describe('Codex app-server driver red scenarios', () => {
  test('legacy no-lease start stays pure headless with no reported terminal surface', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
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

  test('starts a fresh thread and completes a turn', async () => {
    const events = await runScenario('start-fresh-turn')
    await expectGolden('start-fresh-turn', events)
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
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
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

  test('maps assistant message deltas and final message content', async () => {
    const events = await runScenario('assistant-deltas')
    await expectGolden('assistant-deltas', events)
  })

  test('maps command, file change, MCP tool, web search, and image view items to tool events', async () => {
    const events = await runScenario('tool-calls')
    await expectGolden('tool-calls', events)
  })

  test('maps token usage updates', async () => {
    const events = await runScenario('usage-update')
    await expectGolden('usage-update', events)
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
    await expectGolden('unknown-notification', events)
  })

  test.todo('permission request policies are Phase 3 scope per T-01544')

  test('maps startup error notification to diagnostic and terminal invocation.failed', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    await expect(broker.start({ spec: scenarioSpec('startup-error') })).rejects.toMatchObject({
      code: BrokerErrorCode.HarnessError,
    })
    await expectGolden('startup-error', events)
  })

  test('rejects an unsupported initialize protocol version with a terminal invocation.failed', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    await expect(
      broker.start({ spec: scenarioSpec('handshake-unsupported') })
    ).rejects.toMatchObject({ code: BrokerErrorCode.HarnessError })
    // No invocation.started / ready: handshake validation fails before they emit.
    expect(events.map((event) => event.type)).toEqual(['invocation.failed'])
    expect(events[0]?.payload).toMatchObject({
      message: expect.stringContaining('Unsupported Codex app-server protocol version'),
    })
  })

  test('maps a process exit during startup to a terminal invocation.failed', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    await expect(broker.start({ spec: scenarioSpec('exit-during-startup') })).rejects.toMatchObject(
      { code: BrokerErrorCode.HarnessError }
    )
    expect(events.map((event) => event.type)).toEqual(['invocation.failed'])
    expect(events.some((event) => event.type === 'invocation.started')).toBe(false)
  })

  test('encodes sandboxMode as Codex internally tagged sandboxPolicy', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
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

  test('maps child exit during an active turn to turn.failed and invocation.exited', async () => {
    const events = await runScenario('exit-during-turn')
    await expectGolden('exit-during-turn', events)
  })

  test('stops an active invocation with graceful child termination', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('stop-active')
    await broker.start({ spec })
    await broker.input({ invocationId: 'inv_stop_active', input: userInput })
    await broker.stop({
      invocationId: 'inv_stop_active',
      reason: 'operator stop',
      graceMs: 500,
    })
    await expectGolden('stop-active', events)
  })

  test('rejects unsupported steer, append_context, and turn interrupt operations', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
    const spec = scenarioSpec('unsupported-controls')
    await broker.start({ spec })

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
      effect: 'unsupported',
      reason: 'Codex app-server v0 does not support turn interrupt',
    })

    await expectGolden('unsupported-controls', events)
  })
})

describe('Codex app-server viewer contract red tests (T-04908 Phase A)', () => {
  test('valid HRC tmux-pane lease is consumed and reported with exact inspected pane ids', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })
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
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

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
})

describe('Codex app-server process behavior red tests', () => {
  test('spawns exact argv without shell expansion', async () => {
    const events = await runScenario('argv-exact')
    const started = events.find((event) => event.type === 'invocation.started')
    expect(started?.payload).toMatchObject({
      command: Bun.execPath,
      args: [join(fixtureDir, 'argv-exact.ts'), '--literal', '$NO_EXPAND', '*.ts'],
      cwd: process.cwd(),
    })
  })

  test('missing cwd fails with ResourceError before spawning', async () => {
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      now,
    })
    await expect(
      broker.start({
        spec: scenarioSpec('start-fresh-turn', {
          process: {
            ...scenarioSpec('start-fresh-turn').process,
            cwd: join(process.cwd(), 'does-not-exist-for-harness-broker-red-test'),
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

describe('buildThreadStartParams driver-spec field handling (H6)', () => {
  const baseSpec = scenarioSpec('start-fresh-turn')

  test('forwards model, approvalPolicy, sandboxMode and profile', () => {
    const params = buildThreadStartParams(baseSpec, {
      kind: 'codex-app-server',
      model: 'gpt-5-codex',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      profile: 'review',
    })
    expect(params).toMatchObject({
      model: 'gpt-5-codex',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      profile: 'review',
      cwd: baseSpec.process.cwd,
    })
  })

  test('forwards modelReasoningEffort as a thread-scope config override', () => {
    const params = buildThreadStartParams(baseSpec, {
      kind: 'codex-app-server',
      modelReasoningEffort: 'high',
    })
    expect(params['config']).toEqual({ model_reasoning_effort: 'high' })
  })

  test('defaults to safe nulls and never-approve when fields are absent', () => {
    const params = buildThreadStartParams(baseSpec, { kind: 'codex-app-server' })
    expect(params).toMatchObject({
      model: null,
      profile: null,
      sandbox: null,
      config: null,
      approvalPolicy: 'never',
    })
  })
})

describe('validateInitializeHandshake tolerance (H6)', () => {
  function collectDiagnostics() {
    const diagnostics: Array<{ level: string; message: string }> = []
    const emit = (level: string, message: string) => {
      diagnostics.push({ level, message })
    }
    return { diagnostics, emit: emit as Parameters<typeof validateInitializeHandshake>[1] }
  }

  test('accepts a namespaced protocolVersion with no diagnostics', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() =>
      validateInitializeHandshake({ protocolVersion: 'codex-app-server/v0' }, emit)
    ).not.toThrow()
    expect(diagnostics).toHaveLength(0)
  })

  test('throws on a clearly-unsupported protocolVersion', () => {
    const { emit } = collectDiagnostics()
    expect(() =>
      validateInitializeHandshake({ protocolVersion: 'acp-incompatible/v1' }, emit)
    ).toThrow(/Unsupported Codex app-server protocol version/)
  })

  test('tolerates a missing protocolVersion with a debug diagnostic', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() => validateInitializeHandshake({ capabilities: {} }, emit)).not.toThrow()
    expect(diagnostics).toEqual([
      { level: 'debug', message: 'Codex initialize response omitted protocolVersion' },
    ])
  })

  test('tolerates a non-object response with a warn diagnostic', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() => validateInitializeHandshake(null, emit)).not.toThrow()
    expect(diagnostics[0]?.level).toBe('warn')
  })

  test('tolerates a non-string protocolVersion with a warn diagnostic', () => {
    const { diagnostics, emit } = collectDiagnostics()
    expect(() => validateInitializeHandshake({ protocolVersion: 42 }, emit)).not.toThrow()
    expect(diagnostics[0]?.level).toBe('warn')
  })
})
