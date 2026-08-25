import { expect, test } from 'bun:test'
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type { PiSdkSession, PiSdkSessionFactoryInput } from 'spaces-harness-broker-pi-sdk'

import { createResolvedAgentSession, runtimeBackedPiSdkSession } from './invocation-session-factory'

test('forwards all broker-owned inputs into the shared direct runtime without auth fallback', async () => {
  const calls: unknown[] = []
  let resolveDispose: (() => void) | undefined
  const session = sessionStub()
  const created = await createResolvedAgentSession(input(), {
    async loadAgent(options) {
      calls.push(['load', options])
      return {} as never
    },
    async createRuntime(options) {
      calls.push(['runtime', options])
      return {
        session,
        dispose: () =>
          new Promise<void>((resolve) => {
            resolveDispose = resolve
          }),
      } as unknown as AgentSessionRuntime
    },
  })

  expect(calls).toEqual([
    [
      'load',
      expect.objectContaining({
        agentId: 'cody',
        projectId: 'agent-spaces',
        agentRoot: '/agents/cody',
        projectRoot: '/repo',
        cwd: '/repo',
        aspHome: '/asp',
        scopeRef: 'agent:cody',
        laneRef: 'lane:main',
        runId: 'run-1',
        hostSessionId: 'host-1',
        generation: 3,
        model: 'gpt-5.6-sol',
        provider: 'openai',
        reasoningEffort: 'high',
        lockedEnv: { LOCKED: 'yes' },
        dispatchEnv: {
          DISPATCH: 'yes',
          HARNESS_PI_AUTH_STORE: '/foreground/auth.json',
          PI_CODING_AGENT_DIR: '/foreground/pi-agent',
        },
      }),
    ],
    [
      'runtime',
      expect.objectContaining({
        auth: {
          authMode: 'oauth',
          authPath: '/broker/auth.json',
          providerId: 'openai-codex',
          credentialType: 'oauth',
          storeBound: true,
        },
        continuationKey: 'session-key',
      }),
    ],
  ])
  const runtimeOptions = (
    calls[1] as [
      'runtime',
      {
        authStorePath?: string
        extensionFactories: unknown[]
        customTools: unknown[]
      },
    ]
  )[1]
  // T-07552 scope guard: foreground fallback must never replace broker dispatch-auth authority.
  expect(runtimeOptions.authStorePath).toBeUndefined()
  expect(runtimeOptions.extensionFactories).toHaveLength(1)
  expect(runtimeOptions.customTools).toHaveLength(1)

  let disposed = false
  const disposal = created.dispose().then(() => {
    disposed = true
  })
  expect(disposed).toBe(false)
  resolveDispose?.()
  await disposal
  expect(disposed).toBe(true)
})

test('runtime facade disposes the runtime once even when broker cleanup retries', async () => {
  let disposals = 0
  const facade = runtimeBackedPiSdkSession({
    session: sessionStub(),
    async dispose() {
      disposals += 1
    },
  } as unknown as AgentSessionRuntime)
  await Promise.all([facade.dispose(), facade.dispose()])
  expect(disposals).toBe(1)
})

test('requires broker semantic agent inputs', async () => {
  const missing = input()
  missing.spec.agent = undefined
  await expect(createResolvedAgentSession(missing)).rejects.toThrow(
    'requires spec.agent semantic inputs'
  )
})

function input(): PiSdkSessionFactoryInput {
  return {
    spec: {
      specVersion: 'harness-broker.invocation/v1',
      invocationId: 'invocation-1',
      harness: { frontend: 'pi', provider: 'openai', driver: 'agent-harness' },
      driver: { kind: 'agent-harness' },
      sdk: {
        runtime: 'pi-sdk',
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        authMode: 'oauth',
        thinkingLevel: 'high',
      },
      process: {
        command: 'agent-harness',
        args: [],
        cwd: '/repo',
        lockedEnv: { LOCKED: 'yes' },
        harnessTransport: { kind: 'in-process' },
      },
      continuation: { key: 'session-key' },
      agent: {
        agentId: 'cody',
        projectId: 'agent-spaces',
        agentRoot: '/agents/cody',
        projectRoot: '/repo',
        aspHome: '/asp',
        scopeRef: 'agent:cody',
        laneRef: 'lane:main',
        runId: 'run-1',
        hostSessionId: 'host-1',
        generation: 3,
      },
    },
    environment: {
      DISPATCH: 'yes',
      HARNESS_PI_AUTH_STORE: '/foreground/auth.json',
      PI_CODING_AGENT_DIR: '/foreground/pi-agent',
      OMITTED: undefined,
    },
    auth: {
      authMode: 'oauth',
      authPath: '/broker/auth.json',
      providerId: 'openai-codex',
      credentialType: 'oauth',
      storeBound: true,
    },
    permissionExtension: (() => undefined) as never,
    structuredTool: {} as never,
  }
}

function sessionStub(): PiSdkSession {
  return {
    sessionFile: undefined,
    isStreaming: false,
    agent: { state: { tools: [] } },
    subscribe: () => () => undefined,
    async prompt() {},
    async steer() {},
    async abort() {},
    async waitForIdle() {},
    getActiveToolNames: () => [],
    setActiveToolsByName() {},
    dispose() {},
  }
}
