import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { type DriverContext, createBroker, defaultPiAuthStorePath } from 'spaces-harness-broker'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import {
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
  createPiSdkDriver,
  resolvePiSdkModelReference,
} from '../src/driver'
import { inputIdFrom, invocationIdFrom } from './ids'

type CapturedEvent = Pick<InvocationEventEnvelope, 'seq' | 'type' | 'payload'>

test('broker hello declares Pi SDK ack-backed interrupt landing evidence', async () => {
  const broker = createBroker({ drivers: [createPiSdkDriver()] })
  const hello = await broker.hello({
    clientInfo: { name: 'pi-sdk-capabilities' },
    protocolVersions: ['harness-broker/0.2'],
  })
  expect(hello.drivers[0]?.capabilities?.interrupt.landingEvidence).toBe('ack')
})

describe('native release-worker Pi composition', () => {
  test('requires both native-worker execution and native-worker transport', async () => {
    const events: CapturedEvent[] = []
    let constructed = false
    const driver = createPiSdkDriver({
      driverKind: 'agent-harness',
      requiredHarnessTransport: 'native-worker',
      async createSession() {
        constructed = true
        return idleSession()
      },
    })

    await expect(
      driver.start(nativeWorkerSpec({ execution: undefined }), createContext(events))
    ).rejects.toThrow('agent-harness requires native-worker process execution')
    await expect(
      driver.start(nativeWorkerSpec({ transport: 'in-process' }), createContext(events))
    ).rejects.toThrow('agent-harness requires native-worker harness transport')
    expect(constructed).toBe(false)

    await driver.start(nativeWorkerSpec(), createContext(events))
    expect(constructed).toBe(true)
    expect(events[0]?.payload).toMatchObject({ command: process.execPath, args: [] })
  })

  test('mints one operator turn when the TUI user message precedes agent_start', async () => {
    const events: CapturedEvent[] = []
    let listener: ((event: AgentSessionEvent) => void) | undefined
    const session = idleSession()
    session.subscribe = (nextListener) => {
      listener = nextListener
      return () => {
        listener = undefined
      }
    }
    const driver = createPiSdkDriver({
      driverKind: 'agent-harness',
      requiredHarnessTransport: 'native-worker',
      observeOperatorTurns: true,
      async createSession() {
        return session
      },
    })

    await driver.start(nativeWorkerSpec(), createContext(events))
    listener?.(
      piEvent({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: 'typed in the TUI' }] },
      })
    )
    listener?.(piEvent({ type: 'agent_start' }))

    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'user.message')).toHaveLength(1)
    expect(events.find((event) => event.type === 'user.message')?.payload).toMatchObject({
      content: 'typed in the TUI',
      role: 'user',
    })
  })
})

describe('pi SDK driver structured output', () => {
  test('re-validates tool args and synthesizes canonical JSON after one retry', async () => {
    const events: CapturedEvent[] = []
    let scheduled: (() => void) | undefined
    let factoryInput: PiSdkSessionFactoryInput | undefined
    let listener: ((event: AgentSessionEvent) => void) | undefined
    let promptCount = 0

    const session: PiSdkSession = {
      sessionFile: '/tmp/pi-driver-test.jsonl',
      isStreaming: false,
      agent: { state: { tools: [{ name: 'bash', parameters: {} }] } },
      subscribe(nextListener) {
        listener = nextListener
        return () => {
          listener = undefined
        }
      },
      async prompt() {
        promptCount += 1
        const params = promptCount === 1 ? { count: 'wrong' } : { count: 2, answer: 'ok' }
        listener?.(piEvent({ type: 'agent_start' }))
        listener?.(
          piEvent({
            type: 'tool_execution_start',
            toolCallId: `structured-${promptCount}`,
            toolName: 'respond_structured',
            args: params,
          })
        )
        const tool = requireFactoryInput(factoryInput).structuredTool
        const result = await executeTool(tool, params)
        listener?.(
          piEvent({
            type: 'tool_execution_end',
            toolCallId: `structured-${promptCount}`,
            toolName: 'respond_structured',
            result,
            isError: false,
          })
        )
        listener?.(piEvent({ type: 'agent_settled' }))
      },
      async steer() {},
      getSteeringMessages() {
        return []
      },
      clearQueue() {
        return { steering: [], followUp: [] }
      },
      async abort() {},
      async waitForIdle() {},
      getActiveToolNames() {
        return this.agent.state.tools.map((tool) => tool.name)
      },
      setActiveToolsByName(names) {
        this.agent.state.tools.splice(
          0,
          this.agent.state.tools.length,
          ...names.map((name) => ({ name, parameters: {} }))
        )
      },
      dispose() {},
    }
    const driver = createPiSdkDriver({
      schedule(task) {
        scheduled = task
      },
      async createSession(input) {
        factoryInput = input
        session.agent.state.tools.push({ name: 'respond_structured', parameters: {} })
        return session
      },
    })
    await driver.start(spec(), createContext(events))
    await driver.applyInputNow(structuredInput())
    const activeStructuredTool = session.agent.state.tools.find(
      (tool) => tool.name === 'respond_structured'
    )
    expect(activeStructuredTool?.parameters).toEqual(STRUCTURED_SCHEMA)

    scheduled?.()
    await waitForEvent(events, 'turn.completed')

    expect(promptCount).toBe(2)
    const final = events.find(
      (event) =>
        event.type === 'assistant.message.completed' &&
        (event.payload as { final?: boolean }).final === true
    )
    expect(final?.payload).toMatchObject({
      content: [{ type: 'text', text: '{"answer":"ok","count":2}' }],
      final: true,
    })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(0)
  })
})

describe('pi SDK model resolution', () => {
  const registry = {
    getProvider(providerId: string): unknown | undefined {
      return ['anthropic', 'openai', 'openai-codex'].includes(providerId) ? {} : undefined
    },
  }

  test.each([
    {
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-5',
      expected: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    },
    {
      provider: 'openai',
      model: 'openai-codex/gpt-5.5',
      expected: { providerId: 'openai-codex', modelId: 'gpt-5.5' },
    },
    {
      provider: 'openai',
      model: 'gpt-4.1-nano',
      expected: { providerId: 'openai', modelId: 'gpt-4.1-nano' },
    },
  ])('model $model resolves to its Pi provider and model id', ({ provider, model, expected }) => {
    expect(resolvePiSdkModelReference(registry, provider, model)).toEqual(expected)
  })
})

describe('pi SDK authentication modes', () => {
  test('api-key mode keeps the fresh store path and emits its resolved attestation', async () => {
    const events: CapturedEvent[] = []
    let factoryInput: PiSdkSessionFactoryInput | undefined
    const driver = createPiSdkDriver({
      async createSession(input) {
        factoryInput = input
        return idleSession()
      },
    })

    await driver.start(spec('api-key'), createContext(events))

    expect(requireFactoryInput(factoryInput).auth).toMatchObject({
      authMode: 'api-key',
      providerId: 'openai',
      credentialType: 'api-key',
      storeBound: false,
    })
    expect(requireFactoryInput(factoryInput).auth.authPath).toContain(
      'harness-broker-pi-sdk/invocation-driver-test/auth.json'
    )
    expect(authNotice(events)).toMatchObject({
      kind: 'auth-resolved',
      providerId: 'openai',
      credentialType: 'api-key',
      storeBound: false,
    })
    expectStartupSequence(events)
  })

  test('oauth mode binds an OAuth-typed store, starves credential env, and attests before input', async () => {
    const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-oauth-test-'))
    const authPath = join(temporaryDir, 'auth.json')
    await writeFile(
      authPath,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: 'test-access',
          refresh: 'test-refresh',
          expires: Date.now() + 3_600_000,
        },
      })
    )
    const priorKey = process.env['OPENAI_API_KEY']
    const priorAnthropicToken = process.env['ANTHROPIC_AUTH_TOKEN']
    process.env['OPENAI_API_KEY'] = 'must-not-reach-oauth'
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'must-not-reach-oauth'
    const originalEnvironment = { ...process.env }

    try {
      const events: CapturedEvent[] = []
      let factoryInput: PiSdkSessionFactoryInput | undefined
      const driver = createPiSdkDriver({
        schedule() {},
        async createSession(input) {
          factoryInput = input
          return idleSession()
        },
      })
      const oauthSpec = spec('oauth', 'openai-codex', 'openai-codex/gpt-5.5')
      await driver.start(oauthSpec, createContext(events, { HARNESS_PI_AUTH_STORE: authPath }))

      expect(requireFactoryInput(factoryInput).auth).toEqual({
        authMode: 'oauth',
        authPath,
        providerId: 'openai-codex',
        credentialType: 'oauth',
        storeBound: true,
      })
      expect(requireFactoryInput(factoryInput).environment['OPENAI_API_KEY']).toBeUndefined()
      expect(requireFactoryInput(factoryInput).environment['ANTHROPIC_AUTH_TOKEN']).toBeUndefined()
      expect(requireFactoryInput(factoryInput).environment['HARNESS_PI_AUTH_STORE']).toBe(authPath)
      expect(process.env).toEqual(originalEnvironment)
      expect(authNotice(events)).toMatchObject({
        kind: 'auth-resolved',
        providerId: 'openai-codex',
        credentialType: 'oauth',
        storeBound: true,
      })
      expectStartupSequence(events)

      const startupCount = events.length
      const authNoticeIndex = events.findIndex((event) => event.type === 'driver.notice')
      expect(authNoticeIndex).toBeGreaterThanOrEqual(0)
      await driver.applyInputNow(userInput())
      expect(events.slice(startupCount).filter((event) => event.type === 'driver.notice')).toEqual(
        []
      )
    } finally {
      if (priorKey === undefined) process.env['OPENAI_API_KEY'] = undefined
      else process.env['OPENAI_API_KEY'] = priorKey
      if (priorAnthropicToken === undefined)
        Reflect.deleteProperty(process.env, 'ANTHROPIC_AUTH_TOKEN')
      else process.env['ANTHROPIC_AUTH_TOKEN'] = priorAnthropicToken
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  test.each(['missing default store', 'malformed explicit store'])(
    'oauth mode refuses a %s before session construction',
    async (row) => {
      const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-auth-missing-test-'))
      const defaultAuthStorePath = join(temporaryDir, '.pi', 'agent', 'auth.json')
      const explicitPath = join(temporaryDir, 'malformed.json')
      if (row === 'malformed explicit store') await writeFile(explicitPath, '{not-json')
      try {
        const events: CapturedEvent[] = []
        let factoryCalled = false
        const driver = createPiSdkDriver({
          defaultAuthStorePath,
          async createSession() {
            factoryCalled = true
            return idleSession()
          },
        })
        const env =
          row === 'malformed explicit store' ? { HARNESS_PI_AUTH_STORE: explicitPath } : {}
        const expectedPath =
          row === 'malformed explicit store' ? explicitPath : defaultAuthStorePath
        await expect(driver.start(spec('oauth'), createContext(events, env))).rejects.toThrow(
          `missing or unreadable: ${expectedPath}`
        )
        expect(factoryCalled).toBe(false)
        expect(failure(events)).toMatchObject({ code: 'missing_auth_store' })
      } finally {
        await rm(temporaryDir, { recursive: true, force: true })
      }
    }
  )

  test('oauth mode without HARNESS_PI_AUTH_STORE binds the account default Pi store', async () => {
    const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-auth-default-test-'))
    const defaultAuthStorePath = join(temporaryDir, '.pi', 'agent', 'auth.json')
    await mkdir(join(temporaryDir, '.pi', 'agent'), { recursive: true })
    await writeFile(
      defaultAuthStorePath,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: 'test-access',
          refresh: 'test-refresh',
          expires: Date.now() + 3_600_000,
        },
      })
    )
    try {
      const events: CapturedEvent[] = []
      let factoryInput: PiSdkSessionFactoryInput | undefined
      const driver = createPiSdkDriver({
        defaultAuthStorePath,
        schedule() {},
        async createSession(input) {
          factoryInput = input
          return idleSession()
        },
      })
      await driver.start(
        spec('oauth', 'openai-codex', 'openai-codex/gpt-5.5'),
        createContext(events)
      )

      expect(requireFactoryInput(factoryInput).auth).toEqual({
        authMode: 'oauth',
        authPath: defaultAuthStorePath,
        providerId: 'openai-codex',
        credentialType: 'oauth',
        storeBound: true,
      })
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  test('the account default Pi store comes from the account home, not $HOME', () => {
    const priorHome = process.env['HOME']
    process.env['HOME'] = '/nonexistent-home-override'
    try {
      expect(defaultPiAuthStorePath()).toBe(join(userInfo().homedir, '.pi', 'agent', 'auth.json'))
    } finally {
      process.env['HOME'] = priorHome
    }
  })

  test.each([
    { row: 'api_key-typed provider', store: { openai: { type: 'api_key', key: 'test-key' } } },
    { row: 'absent provider', store: { anthropic: { type: 'api_key', key: 'unused' } } },
  ])('oauth mode rejects an $row entry before session construction', async ({ store }) => {
    const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-auth-mismatch-test-'))
    const authPath = join(temporaryDir, 'auth.json')
    await writeFile(authPath, JSON.stringify(store))
    try {
      const events: CapturedEvent[] = []
      let factoryCalled = false
      const driver = createPiSdkDriver({
        async createSession() {
          factoryCalled = true
          return idleSession()
        },
      })

      await expect(
        driver.start(spec('oauth'), createContext(events, { HARNESS_PI_AUTH_STORE: authPath }))
      ).rejects.toThrow('not OAuth-typed')
      expect(factoryCalled).toBe(false)
      expect(failure(events)).toMatchObject({ code: 'auth_mode_mismatch' })
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })
})

async function executeTool(tool: ToolDefinition, params: unknown): Promise<unknown> {
  return tool.execute('structured', params, undefined, undefined, {} as never)
}

function requireFactoryInput(
  input: PiSdkSessionFactoryInput | undefined
): PiSdkSessionFactoryInput {
  if (input === undefined) throw new Error('session factory input missing')
  return input
}

const STRUCTURED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'count'],
  properties: {
    answer: { type: 'string' },
    count: { type: 'integer' },
  },
}

function structuredInput(): InvocationInput {
  return {
    inputId: inputIdFrom('input-1'),
    kind: 'user',
    content: [{ type: 'text', text: 'answer' }],
    responseFormat: { kind: 'json_schema', schema: STRUCTURED_SCHEMA },
  }
}

function spec(
  authMode: 'api-key' | 'oauth' = 'api-key',
  provider = 'openai',
  modelId = 'gpt-4.1-nano'
): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: invocationIdFrom('invocation-driver-test'),
    harness: { frontend: 'pi', provider: 'openai', driver: 'pi-sdk' },
    driver: { kind: 'pi-sdk', permissionPolicy: { mode: 'deny' } },
    sdk: { runtime: 'pi-sdk', provider, modelId, authMode },
    process: {
      command: 'in-process',
      args: [],
      cwd: '/tmp',
      harnessTransport: { kind: 'in-process' },
    },
  }
}

function nativeWorkerSpec(
  options: { execution?: unknown; transport?: string } = {}
): HarnessInvocationSpec {
  const execution = Object.hasOwn(options, 'execution') ? options.execution : 'native-worker'
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: 'native-worker-driver-test',
    harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness' },
    driver: { kind: 'agent-harness' },
    sdk: { runtime: 'pi-sdk', provider: 'openai', modelId: 'gpt-4.1-nano', authMode: 'api-key' },
    process: {
      execution,
      cwd: '/tmp',
      harnessTransport: { kind: options.transport ?? 'native-worker' },
    },
  } as unknown as HarnessInvocationSpec
}

function createContext(
  events: CapturedEvent[],
  dispatchEnv?: Record<string, string>
): DriverContext {
  let seq = 0
  const emit = ((type: string, payload: unknown) => {
    seq += 1
    const event = { seq, type, payload } as CapturedEvent
    events.push(event)
    return event
  }) as DriverContext['emit']
  return {
    invocationId: invocationIdFrom('invocation-driver-test'),
    clientCapabilities: {},
    ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
    emit,
    emitEvent: (() => {
      throw new Error('unused')
    }) as DriverContext['emitEvent'],
  } as DriverContext
}

function expectStartupSequence(events: CapturedEvent[]): void {
  const startup = events.slice(0, 3)
  expect(startup.map((event) => event.type)).toEqual([
    'invocation.started',
    'driver.notice',
    'invocation.ready',
  ])
  expect(startup.map((event) => event.seq)).toEqual([1, 2, 3])
}

function idleSession(): PiSdkSession {
  return {
    sessionFile: '/tmp/pi-driver-auth-test.jsonl',
    isStreaming: false,
    agent: { state: { tools: [{ name: 'bash', parameters: {} }] } },
    subscribe() {
      return () => undefined
    },
    async prompt() {},
    async steer() {},
    getSteeringMessages() {
      return []
    },
    clearQueue() {
      return { steering: [], followUp: [] }
    },
    async abort() {},
    async waitForIdle() {},
    getActiveToolNames() {
      return this.agent.state.tools.map((tool) => tool.name)
    },
    setActiveToolsByName() {},
    dispose() {},
  }
}

function authNotice(events: CapturedEvent[]): Record<string, unknown> | undefined {
  return events.find((event) => event.type === 'driver.notice')?.payload as
    | Record<string, unknown>
    | undefined
}

function failure(events: CapturedEvent[]): Record<string, unknown> | undefined {
  return events.find((event) => event.type === 'invocation.failed')?.payload as
    | Record<string, unknown>
    | undefined
}

function userInput(): InvocationInput {
  return {
    inputId: inputIdFrom('input-auth-test'),
    kind: 'user',
    content: [{ type: 'text', text: 'hello' }],
  }
}

function piEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent
}

async function waitForEvent(events: CapturedEvent[], type: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!events.some((event) => event.type === type)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`)
    await Bun.sleep(1)
  }
}
