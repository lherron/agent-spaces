import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import {
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
  applyPiSdkAuthentication,
  createPiSdkDriver,
  resolvePiSdkModelReference,
} from '../src/driver'

type CapturedEvent = Pick<InvocationEventEnvelope, 'type' | 'payload'>

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
    expect(activeStructuredTool?.parameters).toEqual(structuredInput().responseFormat?.schema)

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

  test('resolves an Anthropic-qualified model through its pi provider namespace', () => {
    expect(
      resolvePiSdkModelReference(registry, 'anthropic', 'anthropic/claude-sonnet-4-5')
    ).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    })
  })

  test('resolves an OpenAI-qualified model through the openai-codex pi provider', () => {
    expect(resolvePiSdkModelReference(registry, 'openai', 'openai-codex/gpt-5.5')).toEqual({
      providerId: 'openai-codex',
      modelId: 'gpt-5.5',
    })
  })

  test('keeps the ASP provider for an unqualified model id', () => {
    expect(resolvePiSdkModelReference(registry, 'openai', 'gpt-4.1-nano')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1-nano',
    })
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
    const priorKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'must-not-reach-oauth'

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
      expect(requireFactoryInput(factoryInput).environment.OPENAI_API_KEY).toBeUndefined()
      expect(authNotice(events)).toMatchObject({
        kind: 'auth-resolved',
        providerId: 'openai-codex',
        credentialType: 'oauth',
        storeBound: true,
      })

      await driver.applyInputNow(userInput())
      events.push({ type: 'turn.started', payload: { turnId: 'synthetic' } } as CapturedEvent)
      expect(events.findIndex((event) => event.type === 'driver.notice')).toBeLessThan(
        events.findIndex((event) => event.type === 'turn.started')
      )
    } finally {
      if (priorKey === undefined) process.env.OPENAI_API_KEY = undefined
      else process.env.OPENAI_API_KEY = priorKey
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  test('oauth mode fails missing or unreadable stores before session construction', async () => {
    const events: CapturedEvent[] = []
    let factoryCalled = false
    const driver = createPiSdkDriver({
      async createSession() {
        factoryCalled = true
        return idleSession()
      },
    })

    await expect(driver.start(spec('oauth'), createContext(events))).rejects.toThrow(
      'HARNESS_PI_AUTH_STORE'
    )
    expect(factoryCalled).toBe(false)
    expect(failure(events)).toMatchObject({ code: 'missing_auth_store' })
  })

  test('oauth mode classifies a malformed store as unreadable', async () => {
    const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-auth-malformed-test-'))
    const authPath = join(temporaryDir, 'auth.json')
    await writeFile(authPath, '{not-json')
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
      ).rejects.toThrow('missing or unreadable')
      expect(factoryCalled).toBe(false)
      expect(failure(events)).toMatchObject({ code: 'missing_auth_store' })
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  test('oauth mode rejects an api_key-typed provider entry', async () => {
    const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-auth-mismatch-test-'))
    const authPath = join(temporaryDir, 'auth.json')
    await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'test-key' } }))
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

  test('oauth mode rejects an absent provider entry', async () => {
    const temporaryDir = await mkdtemp(join(tmpdir(), 'pi-sdk-auth-absent-test-'))
    const authPath = join(temporaryDir, 'auth.json')
    await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: 'unused' } }))
    try {
      const events: CapturedEvent[] = []
      const driver = createPiSdkDriver({ createSession: async () => idleSession() })

      await expect(
        driver.start(spec('oauth'), createContext(events, { HARNESS_PI_AUTH_STORE: authPath }))
      ).rejects.toThrow('not OAuth-typed')
      expect(failure(events)).toMatchObject({ code: 'auth_mode_mismatch' })
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  test('oauth authentication never applies a runtime API key', async () => {
    const calls: Array<[string, string]> = []
    const runtime = {
      async setRuntimeApiKey(providerId: string, key: string) {
        calls.push([providerId, key])
      },
    }
    await applyPiSdkAuthentication(
      runtime,
      {
        authMode: 'oauth',
        authPath: '/managed/auth.json',
        providerId: 'anthropic',
        credentialType: 'oauth',
        storeBound: true,
      },
      { ANTHROPIC_API_KEY: 'must-not-apply' }
    )
    expect(calls).toEqual([])

    await applyPiSdkAuthentication(
      runtime,
      {
        authMode: 'api-key',
        authPath: '/fresh/auth.json',
        providerId: 'anthropic',
        credentialType: 'api-key',
        storeBound: false,
      },
      { ANTHROPIC_API_KEY: 'expected-key' }
    )
    expect(calls).toEqual([['anthropic', 'expected-key']])
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

function structuredInput(): InvocationInput {
  return {
    inputId: 'input-1',
    kind: 'user',
    content: [{ type: 'text', text: 'answer' }],
    responseFormat: {
      kind: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'count'],
        properties: {
          answer: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    },
  }
}

function spec(
  authMode: 'api-key' | 'oauth' = 'api-key',
  provider = 'openai',
  modelId = 'gpt-4.1-nano'
): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: 'invocation-driver-test',
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

function createContext(
  events: CapturedEvent[],
  dispatchEnv?: Record<string, string>
): DriverContext {
  const emit = ((type: string, payload: unknown) => {
    const event = { type, payload } as CapturedEvent
    events.push(event)
    return event
  }) as DriverContext['emit']
  return {
    invocationId: 'invocation-driver-test',
    clientCapabilities: {},
    ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
    emit,
    emitEvent: (() => {
      throw new Error('unused')
    }) as DriverContext['emitEvent'],
  } as DriverContext
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
    inputId: 'input-auth-test',
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
