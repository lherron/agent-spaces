/**
 * T-08577 service reds for the four pure preparation operations.
 *
 * The existing ASPC service and transport-injected registration seams are used
 * directly. No broker server is started and no native process is launched. The
 * Desktop success fixture uses real provider-native files so the preparation is
 * validated through the ordinary profile validator rather than a hand-written
 * mock profile.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashNeutralStartRequest,
  neutralSpecHash,
  neutralStartRequestHash,
  validateBrokerExecutionProfile,
} from 'spaces-runtime-contracts'
import { createAspcService, registerAspcCompileMethods } from '../src/index.js'

type UnknownRecord = Record<string, unknown>
type ServiceOperation = (request: UnknownRecord) => unknown | Promise<unknown>
type RecordedHandler = (request: {
  id: string | number | null
  method: string
  params: unknown
}) => Promise<unknown>

const THREAD = '018f0f3e-7d65-7c19-a2bd-5a43c86c72ab'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 't08577-aspc-service-'))
  roots.push(root)
  return root
}

function operation(service: object, name: string): ServiceOperation {
  const candidate = (service as UnknownRecord)[name]
  expect(typeof candidate, `AspcService must expose ${name}`).toBe('function')
  return candidate as ServiceOperation
}

function recordingServer(): {
  handlers: Map<string, RecordedHandler>
  register(method: string, handler: RecordedHandler): void
} {
  const handlers = new Map<string, RecordedHandler>()
  return {
    handlers,
    register(method, handler) {
      if (handlers.has(method)) throw new Error(`duplicate method ${method}`)
      handlers.set(method, handler)
    },
  }
}

function desktopFixture(): {
  root: string
  home: string
  rollout: string
  bundle: string
  executionMarker: string
  request: UnknownRecord
} {
  const root = temporaryRoot()
  const home = join(root, 'codex-home')
  const day = join(home, 'sessions', '2026', '09', '17')
  const rollout = join(day, `rollout-${THREAD}.jsonl`)
  const bundle = join(root, 'ChatGPT.app', 'Contents', 'Resources', 'codex')
  const executionMarker = join(root, 'NATIVE-PROCESS-WAS-STARTED')
  mkdirSync(day, { recursive: true })
  mkdirSync(join(root, 'ChatGPT.app', 'Contents', 'Resources'), { recursive: true })
  writeFileSync(
    rollout,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: THREAD,
        cwd: join(root, 'project'),
        source: 'vscode',
        thread_source: 'user',
        originator: 'Codex Desktop',
      },
    })}\n`,
    'utf8'
  )
  writeFileSync(bundle, `#!/bin/sh\ntouch ${JSON.stringify(executionMarker)}\nexit 99\n`, {
    mode: 0o755,
  })
  mkdirSync(join(root, 'project'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })

  return {
    root,
    home,
    rollout,
    bundle,
    executionMarker,
    request: {
      schemaVersion: 'aspc-prepare-desktop-observer-request/v1',
      registration: {
        registrationKey: 'b'.repeat(64),
        agentId: 'stella',
        projectId: 'agent-spaces',
        projectRoot: join(root, 'project'),
        scopeRef: 'agent:stella:project:agent-spaces',
        laneRef: 'main',
        hostSessionId: 'hsid-t08577',
        generation: 11,
        nativeThreadId: THREAD,
        homeIdentity: home,
        sqliteHome: home,
        rolloutPath: rollout,
        reportedBundleExecutable: bundle,
      },
      hostingIdentity: {
        runtimeId: 'runtime-t08577',
        runId: 'run-t08577',
        hostSessionId: 'hsid-t08577',
        generation: 11,
      },
      recoveryBoundary: {
        sourceKind: 'provider-jsonl',
        sourceEpoch: 'epoch-t08577',
        furthestCommittedRecord: {
          rawRecordId: 'raw-7',
          byteOffset: 700,
          line: 7,
          rawSha256: 'c'.repeat(64),
          nativeType: 'response_item',
        },
        earliestPendingRecord: { rawRecordId: 'raw-8', byteOffset: 800 },
        committedProjections: [
          {
            seq: 7,
            type: 'assistant.message',
            turnId: 'turn-7',
            itemId: 'item-7',
            rawRecordId: 'raw-7',
          },
        ],
        appliedThroughSeq: 7,
        empty: false,
      },
      nativeAttemptStorePath: join(root, 'state', 'native-attempts.db'),
    },
  }
}

describe('ASPC preparation service registration (T-08577)', () => {
  test('control: the existing compile plane still excludes start and broker routes', () => {
    const server = recordingServer()
    registerAspcCompileMethods(server)

    expect(server.handlers.has('aspc.compileRuntimePlan')).toBe(true)
    expect(server.handlers.has('aspc.compileAndStart')).toBe(false)
    expect([...server.handlers.keys()].some((name) => name.startsWith('broker.'))).toBe(false)
    expect([...server.handlers.keys()].some((name) => name.startsWith('invocation.'))).toBe(false)
  })

  test('A2: the service registers exactly four preparation routes without any start/input route', () => {
    const server = recordingServer()
    registerAspcCompileMethods(server)

    const preparation = [...server.handlers.keys()].filter(
      (method) =>
        method.startsWith('aspc.prepare') ||
        method === 'aspc.resolveDesktopIdentity' ||
        method === 'aspc.admitDesktopRegistration'
    )
    expect(preparation.sort()).toEqual([
      'aspc.admitDesktopRegistration',
      'aspc.prepareDesktopObserver',
      'aspc.prepareProcessInvocation',
      'aspc.resolveDesktopIdentity',
    ])
    for (const forbidden of [
      'aspc.compileAndStart',
      'invocation.start',
      'invocation.input',
      'invocation.interrupt',
      'broker.hello',
    ]) {
      expect(server.handlers.has(forbidden), forbidden).toBe(false)
    }
  })

  test('A2/H4: hello advertises all four preparation capabilities as exact booleans', async () => {
    const hello = await createAspcService().hello({
      clientInfo: { name: 't08577-service-red' },
      protocolVersions: ['aspc/0.1'],
    })

    expect(hello.capabilities).toMatchObject({
      prepareProcessInvocation: true,
      resolveDesktopIdentity: true,
      admitDesktopRegistration: true,
      prepareDesktopObserver: true,
    })
  })
})

describe('ASPC Desktop observer preparation (T-08577)', () => {
  test('E1/E4/E5: fresh preparation returns a validated queue-only profile and never starts or applies input', async () => {
    const fixture = desktopFixture()
    const service = createAspcService()
    const prepare = operation(service, 'prepareDesktopObserver')
    const response = (await prepare.call(service, fixture.request)) as UnknownRecord
    const startRequest = response['startRequest'] as Parameters<typeof neutralStartRequestHash>[0]
    const hashValue = (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? 'null')
        .digest('hex')

    expect(response).toMatchObject({
      schemaVersion: 'aspc-prepare-desktop-observer-response/v1',
      ok: true,
      plan: {
        compiler: { name: 'agent-spaces', version: 'codex-desktop-observer/1' },
        harness: { family: 'codex', runtime: 'codex-desktop', provider: 'openai' },
      },
      selectedProfile: {
        kind: 'harness-broker',
        interactionMode: 'headless',
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'codex-desktop',
      },
    })

    const profile = response['selectedProfile'] as Parameters<
      typeof validateBrokerExecutionProfile
    >[0]
    const start = startRequest as unknown as UnknownRecord
    const spec = start['spec'] as UnknownRecord
    expect(validateBrokerExecutionProfile(profile)).toEqual([])
    expect(
      validateBrokerExecutionProfile({
        ...profile,
        brokerProtocol: 'not-a-broker-protocol',
      } as never).length
    ).toBeGreaterThan(0)
    expect(JSON.stringify(response)).not.toContain('initialInput')
    expect(existsSync(fixture.executionMarker)).toBe(false)

    expect(profile.profileId).toBe(
      `profile_${hashValue({
        driver: 'codex-desktop',
        startRequest: hashNeutralStartRequest(startRequest),
      }).slice(0, 32)}`
    )
    expect(profile.compatibilityHash).toBe(
      hashValue({ driver: 'codex-desktop', threadId: THREAD, codexHome: fixture.home })
    )
    expect(profile.expectedCapabilities).toEqual({
      input: {
        user: 'required',
        steer: 'forbidden',
        appendContext: 'forbidden',
        localImages: 'forbidden',
        fileRefs: 'forbidden',
        queue: 'required',
      },
      turns: { concurrency: 'single', interrupt: 'forbidden' },
      continuation: 'optional',
      permissions: 'none',
      events: {
        assistantDeltas: 'optional',
        toolCalls: 'required',
        usage: 'optional',
        diagnostics: 'optional',
      },
      control: {
        stop: 'optional',
        dispose: 'optional',
        reconcile: 'optional',
        attachReplay: 'optional',
      },
      lifecycle: {
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: 'forbidden',
        permissionCancellation: 'forbidden',
      },
    })
    expect(profile.harnessInvocation).toEqual({
      startRequest,
      specHash: neutralSpecHash(startRequest.spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    })
    expect(profile.policy).toEqual({
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'reject' },
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' },
    })
    expect(profile.observability.correlation).toEqual({
      requestId: expect.any(String),
      operationId: expect.any(String),
      hostSessionId: 'hsid-t08577',
      generation: 11,
      runtimeId: 'runtime-t08577',
      runId: 'run-t08577',
      invocationId: startRequest.spec.invocationId,
      traceId: expect.any(String),
    })
    expect(spec['driver']).toMatchObject({
      kind: 'codex-desktop',
      bundleExecutable: fixture.bundle,
      codexHome: fixture.home,
      sqliteHome: fixture.home,
      threadId: THREAD,
      rolloutPath: fixture.rollout,
      nativeAttemptStorePath: join(fixture.root, 'state', 'native-attempts.db'),
      recoveryBoundary: fixture.request['recoveryBoundary'] as UnknownRecord,
    })
    expect(spec['process']).toMatchObject({
      command: 'external-codex-desktop',
      args: [],
      harnessTransport: { kind: 'pipes' },
    })
  })

  test('E3: refreshed rollout outside the registered home is not prepared and leaves no partial plan', async () => {
    const fixture = desktopFixture()
    const outside = join(fixture.root, 'other-home', 'sessions', '2026', '09', '17')
    mkdirSync(outside, { recursive: true })
    const rollout = join(outside, 'rollout.jsonl')
    writeFileSync(
      rollout,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: THREAD,
          source: 'vscode',
          thread_source: 'user',
          originator: 'Codex Desktop',
        },
      })}\n`
    )
    const service = createAspcService()
    const prepare = operation(service, 'prepareDesktopObserver')
    const registration = {
      ...(fixture.request['registration'] as UnknownRecord),
      rolloutPath: rollout,
    }
    const response = (await prepare.call(service, {
      ...fixture.request,
      registration,
    })) as UnknownRecord

    expect(response).toMatchObject({
      schemaVersion: 'aspc-prepare-desktop-observer-response/v1',
      ok: false,
      notPrepared: { code: 'rollout_home_mismatch' },
    })
    expect(Object.hasOwn(response, 'plan')).toBe(false)
    expect(existsSync(fixture.executionMarker)).toBe(false)
  })

  test('E3: refreshed thread mismatch is a typed not-prepared result, not an exception', async () => {
    const fixture = desktopFixture()
    writeFileSync(
      fixture.rollout,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: '018f0f3e-7d65-7c19-a2bd-5a43c86c72ac',
          source: 'vscode',
          thread_source: 'user',
          originator: 'Codex Desktop',
        },
      })}\n`
    )
    const service = createAspcService()
    const prepare = operation(service, 'prepareDesktopObserver')
    const response = (await prepare.call(service, fixture.request)) as UnknownRecord

    expect(response).toMatchObject({
      schemaVersion: 'aspc-prepare-desktop-observer-response/v1',
      ok: false,
      notPrepared: { code: 'native_thread_mismatch' },
    })
    expect(Object.hasOwn(response, 'plan')).toBe(false)
    expect(existsSync(fixture.executionMarker)).toBe(false)
  })
})
