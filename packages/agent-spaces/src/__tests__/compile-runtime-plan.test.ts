import { afterAll, beforeAll, test as bunTest, describe, expect } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  EmbeddedSdkExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
  TerminalExecutionProfile,
} from 'spaces-runtime-contracts'
import {
  type CompileDiagnostic,
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  project,
} from 'spaces-runtime-contracts'
import * as RuntimeContracts from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import type {
  AgentSpacesClient,
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
} from '../types.js'

type TestFn = () => unknown | Promise<unknown>
type EachTestFn<T extends readonly unknown[]> = (...args: T) => unknown | Promise<unknown>

const HEAVY_TEST_TIMEOUT_MS = 60000

function test(name: string, fn: TestFn): void {
  bunTest(name, fn, HEAVY_TEST_TIMEOUT_MS)
}

test.each = <T extends readonly unknown[]>(table: readonly T[]) => {
  return (name: string, fn: EachTestFn<T>): void => {
    bunTest.each(table)(name, fn, HEAVY_TEST_TIMEOUT_MS)
  }
}

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

type BrokerClient = AgentSpacesClient & {
  buildHarnessBrokerInvocation(
    req: BuildHarnessBrokerInvocationRequest & { initialInputId?: InputId | undefined }
  ): Promise<BuildHarnessBrokerInvocationResponse>
}

function createCodexShim(dir: string): string {
  const shimPath = join(dir, 'codex')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then
  echo "app-server"
  exit 0
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createPiShim(dir: string): string {
  const shimPath = join(dir, 'pi')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "pi 999.0.0"
  exit 0
fi
if [[ "$1" == "--help" ]]; then
  echo "--extension --skill --no-skills --no-context-files --model --provider"
  exit 0
fi
echo "pi shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createClaudeShim(dir: string): string {
  const shimPath = join(dir, 'claude')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "claude 1.0.0"
  exit 0
fi
echo "claude shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createFixture(): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  imagePath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-compile-runtime-plan-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const imagePath = join(base, 'diagram.png')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(imagePath, 'not-really-a-png', 'utf8')
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

[spaces]
base = []
`,
    'utf8'
  )
  createClaudeShim(aspHome)
  createCodexShim(aspHome)
  createPiShim(aspHome)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    imagePath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let fixture: ReturnType<typeof createFixture>
const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalPiPath = process.env['ASP_PI_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
const originalClaudePath = process.env['ASP_CLAUDE_PATH']

function createClient(): CompileClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
}

function createBrokerClient(): BrokerClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as BrokerClient
}

function placement(overrides: Record<string, unknown> = {}): RuntimeCompileRequest['placement'] {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    lockedEnv: { EXTRA_FLAG: '1' },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01609',
        laneRef: 'main',
      },
      hostSessionId: 'host-01609',
    },
    ...overrides,
  }
}

function baseCompileRequest(overrides: Partial<RuntimeCompileRequest> = {}): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_T01609',
      operationId: 'runtimeOperation_T01609',
      hostSessionId: 'hostSession_T01609',
      generation: 1,
      runtimeId: 'runtime_T01609',
      invocationId: 'inv_T01609' as InvocationId,
      initialInputId: 'input_T01609' as InputId,
      runId: 'run_T01609',
      traceId: 'trace_T01609',
      idempotencyKey: 'compile-runtime-plan-red',
    },
    placement: placement(),
    requested: {
      modelProvider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: 'hello compiled broker',
      attachments: [{ kind: 'image', path: fixture.imagePath, mimeType: 'image/png' }],
      taskContext: {
        taskId: 'T-01609',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test'],
        hintsText: 'compileRuntimePlan should wrap the broker invocation builder',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: 'trace_T01609' },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    continuation: {
      schemaVersion: 'runtime-continuation/v1',
      hrc: { provider: 'openai', keyHash: 'thread-hash', key: 'thread_T01609' },
      broker: { provider: 'codex', kind: 'thread', keyHash: 'thread-hash', key: 'thread_T01609' },
      source: 'harness-broker',
      observedAt: '2026-05-24T07:05:32.000Z',
    },
    correlation: {
      requestId: 'request_T01609',
      operationId: 'runtimeOperation_T01609',
      hostSessionId: 'hostSession_T01609',
      generation: 1,
      runtimeId: 'runtime_T01609',
      runId: 'run_T01609',
      invocationId: 'inv_T01609' as InvocationId,
      traceId: 'trace_T01609',
      appId: 'agent-spaces-tests',
      appSessionKey: 'compile-runtime-plan',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01609',
      laneRef: 'main',
    },
    ...overrides,
  }
}

function brokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error('compileRuntimePlan returned diagnostics instead of a plan')
  }
  const profiles = response.plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

type EmbeddedSdkProfileValidator = (profile: EmbeddedSdkExecutionProfile) => CompileDiagnostic[]
type BrokerProfileValidator = (profile: BrokerExecutionProfile) => CompileDiagnostic[]

function validateBrokerExecutionProfile(profile: BrokerExecutionProfile): CompileDiagnostic[] {
  const validator = (
    RuntimeContracts as typeof RuntimeContracts & {
      validateBrokerExecutionProfile?: BrokerProfileValidator | undefined
    }
  ).validateBrokerExecutionProfile

  expect(validator).toBeFunction()
  return validator(profile)
}

function validateEmbeddedSdkExecutionProfile(
  profile: EmbeddedSdkExecutionProfile
): CompileDiagnostic[] {
  const validator = (
    RuntimeContracts as typeof RuntimeContracts & {
      validateEmbeddedSdkExecutionProfile?: EmbeddedSdkProfileValidator | undefined
    }
  ).validateEmbeddedSdkExecutionProfile

  expect(validator).toBeFunction()
  return validator(profile)
}

function embeddedSdkProfile(response: RuntimeCompileResponse): EmbeddedSdkExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan returned diagnostics instead of an embedded-sdk plan: ${response.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(', ')}`
    )
  }
  const profiles = response.plan.executionProfiles.filter(
    (profile): profile is EmbeddedSdkExecutionProfile => profile.kind === 'embedded-sdk'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

function rejectedWithoutEmbeddedSdkProfile(response: RuntimeCompileResponse): CompileDiagnostic[] {
  expect(response.ok).toBe(false)
  expect(JSON.stringify(response)).not.toContain('"kind":"embedded-sdk"')
  if (response.ok) {
    throw new Error('compileRuntimePlan returned an embedded-sdk plan for an invalid route')
  }
  return response.diagnostics
}

function terminalProfile(response: RuntimeCompileResponse): TerminalExecutionProfile {
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan failed: ${response.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`
    )
  }
  const profiles = response.plan.executionProfiles.filter(
    (profile): profile is TerminalExecutionProfile => profile.kind === 'terminal'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

function interactiveCompileRequest(
  requested: RuntimeCompileRequest['requested']
): RuntimeCompileRequest {
  return baseCompileRequest({
    requested,
    materialization: {
      ...baseCompileRequest().materialization,
      initialPrompt: 'hello foreground terminal',
      attachments: [],
      taskContext: {
        taskId: 'T-01651',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test'],
        hintsText: 'compileRuntimePlan should emit a foreground terminal profile',
      },
    },
    continuation: undefined,
  })
}

function explicitTerminalCompileRequest(
  requested: RuntimeCompileRequest['requested']
): RuntimeCompileRequest {
  return interactiveCompileRequest({
    ...requested,
    // Target Phase 1 discriminator API: the pre-HRC default selects the broker;
    // foreground terminal remains available only when compiler intent says so.
    controllerIntent: 'foreground-terminal',
  } as unknown as RuntimeCompileRequest['requested'])
}

function withDisallowedTools(req: RuntimeCompileRequest): RuntimeCompileRequest {
  return {
    ...req,
    hrcPolicy: {
      ...req.hrcPolicy,
      disallowedTools: ['AskUserQuestion'],
    },
  }
}

function legacyBrokerRequest(
  req: RuntimeCompileRequest
): BuildHarnessBrokerInvocationRequest & { initialInputId?: InputId | undefined } {
  return {
    placement: req.placement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    model: req.requested.model,
    modelReasoningEffort: req.requested.reasoningEffort,
    continuation: { provider: 'openai', key: req.continuation?.hrc.key },
    prompt: req.materialization.initialPrompt,
    attachments: [{ kind: 'file', path: fixture.imagePath, contentType: 'image/png' }],
    lockedEnv: { EXTRA_FLAG: '1' },
    invocationId: req.identity.invocationId,
    initialInputId: req.identity.initialInputId,
    labels: { task: 'T-01609' },
    correlation: {
      requestId: req.correlation.requestId,
      operationId: req.correlation.operationId ?? '',
      hostSessionId: req.correlation.hostSessionId,
      runtimeId: req.correlation.runtimeId ?? '',
      runId: req.correlation.runId ?? '',
      traceId: req.correlation.traceId ?? '',
      scopeRef: req.correlation.scopeRef ?? '',
      laneRef: req.correlation.laneRef ?? '',
    },
    permissionPolicy: { mode: 'deny' },
    limits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
    resumeFallback: 'fail',
  }
}

describe('compileRuntimePlan broker profile contract', () => {
  beforeAll(() => {
    fixture = createFixture()
    process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
    process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
    process.env['ASP_PI_PATH'] = join(fixture.aspHome, 'pi')
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  })

  afterAll(() => {
    if (originalClaudePath === undefined) {
      process.env['ASP_CLAUDE_PATH'] = undefined
    } else {
      process.env['ASP_CLAUDE_PATH'] = originalClaudePath
    }
    if (originalCodexPath === undefined) {
      process.env['ASP_CODEX_PATH'] = undefined
    } else {
      process.env['ASP_CODEX_PATH'] = originalCodexPath
    }
    if (originalPiPath === undefined) {
      process.env['ASP_PI_PATH'] = undefined
    } else {
      process.env['ASP_PI_PATH'] = originalPiPath
    }
    if (originalSkipCommon === undefined) {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    } else {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
    }
    fixture.cleanup()
  })

  test('compiles openai codex headless to a validating harness-broker profile preserving caller ids', async () => {
    const req = baseCompileRequest()
    const response = await createClient().compileRuntimePlan(req)
    const profile = brokerProfile(response)

    expect(profile.kind).toBe('harness-broker')
    expect(profile.interactionMode).toBe('headless')
    expect(profile.brokerProtocol).toBe('harness-broker/0.2')
    expect(profile.brokerDriver).toBe('codex-app-server')
    expect(profile.expectedCapabilities.input.queue).toBe('required')
    expect(validateInvocationStartRequest(profile.harnessInvocation.startRequest)).toEqual(
      profile.harnessInvocation.startRequest
    )
    expect(profile.harnessInvocation.startRequest.spec.invocationId).toBe(req.identity.invocationId)
    expect(profile.harnessInvocation.startRequest.initialInput?.inputId).toBe(
      req.identity.initialInputId
    )
    expect(profile.harnessInvocation.startRequest.spec.interaction).toEqual({
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'fifo',
    })
  })

  test('keeps headless codex on the harness-broker execution profile path', async () => {
    const response = await createClient().compileRuntimePlan(baseCompileRequest())
    const profile = brokerProfile(response)

    expect(profile.kind).toBe('harness-broker')
    expect(profile.interactionMode).toBe('headless')
    expect(profile.brokerDriver).toBe('codex-app-server')
  })

  test('compiles openai pi-sdk nonInteractive to a validator-legal embedded-sdk profile', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-sdk',
          interactionMode: 'nonInteractive',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
          taskContext: {
            taskId: 'T-01670',
            phase: 'red',
            role: 'smokey',
            requiredEvidenceKinds: ['red-test'],
            hintsText: 'pi-sdk nonInteractive must compile to embedded-sdk',
          },
        },
        continuation: undefined,
      })
    )
    const profile = embeddedSdkProfile(response)

    expect(profile).toEqual(
      expect.objectContaining({
        kind: 'embedded-sdk',
        interactionMode: 'nonInteractive',
        sdk: expect.objectContaining({
          runtime: 'pi-sdk',
          startupMethod: 'create-sdk-session',
          turnDelivery: 'sdk-turn',
        }),
        session: expect.objectContaining({
          provider: 'openai',
          modelId: expect.any(String),
          cwd: fixture.projectRoot,
          lockedEnv: expect.not.objectContaining({ PATH: expect.any(String) }),
        }),
      })
    )
    expect(validateEmbeddedSdkExecutionProfile(profile)).toEqual([])
  })

  test('compiles pi-cli interactive requests to the pi-tui-tmux broker profile', async () => {
    const response = await createClient().compileRuntimePlan(
      interactiveCompileRequest({
        modelProvider: 'openai',
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
        harnessFamily: 'pi',
        preferredHarnessRuntime: 'pi-cli',
        interactionMode: 'interactive',
      })
    )
    const profile = brokerProfile(response)

    expect(response.ok).toBe(true)
    expect(profile.kind).toBe('harness-broker')
    expect(profile.interactionMode).toBe('interactive')
    expect(profile.brokerDriver).toBe('pi-tui-tmux')
    expect(profile.brokerTerminal).toMatchObject({
      host: 'tmux',
      turnDelivery: 'terminal-literal-input',
      operatorAttach: true,
    })
    expect(profile.harnessInvocation.startRequest.spec.harness).toEqual({
      frontend: 'pi-cli',
      provider: 'openai',
      driver: 'pi-tui-tmux',
    })
    expect(profile.harnessInvocation.startRequest.spec.process.harnessTransport.kind).toBe('pty')
    expect(profile.harnessInvocation.startRequest.spec.driver).toMatchObject({
      kind: 'pi-tui-tmux',
      terminalHost: 'tmux',
      hookBridge: 'pi-hrc-events/v1',
    })
    expect(profile.harnessInvocation.startRequest.spec.process.args).toEqual(
      expect.arrayContaining([
        '--no-context-files',
        '--no-skills',
        '--model',
        'gpt-5.5',
        '--provider',
        'openai-codex',
      ])
    )
    expect(profile.harnessInvocation.startRequest.spec.process.args).toContain(
      'hello foreground terminal'
    )
    expect(profile.harnessInvocation.startRequest.initialInput).toBeUndefined()
    expect(profile.harnessInvocation.initialInputHash).toBeUndefined()
  })

  test('T-01817 emits durable-aware attach replay requirements only for interactive tmux broker profiles', async () => {
    const interactiveRoutes = [
      {
        brokerDriver: 'claude-code-tmux',
        requested: {
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-code-cli',
          interactionMode: 'interactive',
        },
      },
      {
        brokerDriver: 'codex-cli-tmux',
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'codex',
          preferredHarnessRuntime: 'codex-cli',
          interactionMode: 'interactive',
        },
      },
      {
        brokerDriver: 'pi-tui-tmux',
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-cli',
          interactionMode: 'interactive',
        },
      },
    ] as const

    for (const route of interactiveRoutes) {
      const profile = brokerProfile(
        await createClient().compileRuntimePlan(interactiveCompileRequest(route.requested))
      )

      // T-01817 acceptance: v0.2 interactive tmux broker profiles must not
      // contradict durable Unix broker hellos that advertise attachReplay:true.
      expect(profile.kind).toBe('harness-broker')
      expect(profile.interactionMode).toBe('interactive')
      expect(profile.brokerDriver).toBe(route.brokerDriver)
      expect(profile.brokerProtocol).toBe('harness-broker/0.2')
      expect(profile.expectedCapabilities.control.attachReplay).toBe('optional')
      expect(profile.expectedCapabilities.input.queue).toBe('required')
      expect(profile.harnessInvocation.startRequest.spec.process.harnessTransport.kind).toBe('pty')
      expect(validateBrokerExecutionProfile(profile)).toEqual([])
    }

    const headlessCodex = brokerProfile(
      await createClient().compileRuntimePlan(baseCompileRequest())
    )
    expect(headlessCodex.brokerDriver).toBe('codex-app-server')
    expect(headlessCodex.expectedCapabilities.control.attachReplay).toBe('optional')

    const foreground = terminalProfile(
      await createClient().compileRuntimePlan(
        explicitTerminalCompileRequest({
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-code-cli',
          interactionMode: 'interactive',
        })
      )
    )
    expect(foreground.expectedCapabilities.control.attachReplay).toBe('forbidden')

    const embedded = embeddedSdkProfile(
      await createClient().compileRuntimePlan(
        baseCompileRequest({
          requested: {
            modelProvider: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            harnessFamily: 'pi',
            preferredHarnessRuntime: 'pi-sdk',
            interactionMode: 'nonInteractive',
          },
          materialization: {
            ...baseCompileRequest().materialization,
            attachments: [],
          },
          continuation: undefined,
        })
      )
    )
    expect(embedded.expectedCapabilities.control.attachReplay).toBe('forbidden')
  })

  test('rejects pi-sdk headless requests instead of rewriting them to nonInteractive embedded-sdk', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-sdk',
          interactionMode: 'headless',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
        },
        continuation: undefined,
      })
    )

    const diagnostics = rejectedWithoutEmbeddedSdkProfile(response)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'error',
        plane: 'asp-compiler',
        message: expect.stringContaining('nonInteractive'),
      })
    )
  })

  test('rejects pi-sdk requests when nonInteractive interaction mode is omitted', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-sdk',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
        },
        continuation: undefined,
      })
    )

    const diagnostics = rejectedWithoutEmbeddedSdkProfile(response)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'error',
        plane: 'asp-compiler',
        message: expect.stringContaining('explicit'),
      })
    )
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
      'nonInteractive'
    )
  })

  test('rejects pi-sdk requests when the harness family is not pi', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          harnessFamily: 'codex',
          preferredHarnessRuntime: 'pi-sdk',
          interactionMode: 'nonInteractive',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
        },
        continuation: undefined,
      })
    )

    const diagnostics = rejectedWithoutEmbeddedSdkProfile(response)
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'error',
        plane: 'asp-compiler',
        message: expect.stringContaining('harnessFamily'),
      })
    )
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('pi')
  })

  test('selects the claude-code-tmux harness-broker for the pre-HRC interactive default', async () => {
    const response = await createClient().compileRuntimePlan(
      interactiveCompileRequest({
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4-5',
        harnessFamily: 'claude-code',
        preferredHarnessRuntime: 'claude-code-cli',
        interactionMode: 'interactive',
      })
    )
    const profile = brokerProfile(response)

    expect(response.ok).toBe(true)
    expect(profile.kind).toBe('harness-broker')
    expect(profile.interactionMode).toBe('interactive')
    expect(profile.brokerDriver).toBe('claude-code-tmux')
    expect(profile.brokerTerminal?.host).toBe('tmux')
    expect(profile.harnessInvocation.startRequest.spec.driver.kind).toBe('claude-code-tmux')
    expect(profile.harnessInvocation.startRequest.spec.process.args).toEqual(
      expect.arrayContaining(['--', 'hello foreground terminal'])
    )
    expect(profile.harnessInvocation.startRequest.spec.process.args).not.toContain(
      '--disallowedTools'
    )
    expect(profile.policy.disallowedTools).toBeUndefined()
    expect(profile.harnessInvocation.startRequest.initialInput).toBeUndefined()
    expect(profile.harnessInvocation.initialInputHash).toBeUndefined()
  })

  test('applies hrcPolicy.disallowedTools to claude-code-tmux argv and profile policy', async () => {
    const response = await createClient().compileRuntimePlan(
      withDisallowedTools(
        interactiveCompileRequest({
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-code-cli',
          interactionMode: 'interactive',
        })
      )
    )
    const profile = brokerProfile(response)
    const args = profile.harnessInvocation.startRequest.spec.process.args
    const flagIndex = args.indexOf('--disallowedTools')

    expect(response.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'disallowed_tools_unsupported_driver' })
    )
    expect(flagIndex).toBeGreaterThan(-1)
    expect(args[flagIndex + 1]).toBe('AskUserQuestion')
    expect(profile.policy.disallowedTools).toEqual(['AskUserQuestion'])
  })

  test('selects the foreground terminal only when compiler intent explicitly requests it', async () => {
    const response = await createClient().compileRuntimePlan(
      explicitTerminalCompileRequest({
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4-5',
        harnessFamily: 'claude-code',
        preferredHarnessRuntime: 'claude-code-cli',
        interactionMode: 'interactive',
      })
    )
    const profile = terminalProfile(response)

    expect(response.ok).toBe(true)
    expect(profile.kind).toBe('terminal')
    expect(profile.interactionMode).toBe('interactive')
    expect(profile.terminal.host).toBe('foreground')
    expect(profile.terminal.startupMethod).toBe('inherit-current-terminal')
    expect(profile.terminal.turnDelivery).toBe('terminal-launch-input')
    expect(profile.process.io.kind).toBe('inherit')
    expect(profile.policy.exposurePolicy.mode).toBe('none')
  })

  test.each([
    ['codex-app-server', () => withDisallowedTools(baseCompileRequest()), 'codex-app-server'],
    [
      'codex-cli-tmux',
      () =>
        withDisallowedTools(
          interactiveCompileRequest({
            modelProvider: 'openai',
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            harnessFamily: 'codex',
            preferredHarnessRuntime: 'codex-cli',
            interactionMode: 'interactive',
          })
        ),
      'codex-cli-tmux',
    ],
    [
      'foreground terminal',
      () =>
        withDisallowedTools(
          explicitTerminalCompileRequest({
            modelProvider: 'anthropic',
            model: 'claude-sonnet-4-5',
            harnessFamily: 'claude-code',
            preferredHarnessRuntime: 'claude-code-cli',
            interactionMode: 'interactive',
          })
        ),
      'claude-code:foreground-terminal',
    ],
  ])(
    'warns and leaves disallowedTools unapplied for %s',
    async (_name, buildReq, selectedDriver) => {
      const response = await createClient().compileRuntimePlan(buildReq())
      expect(response.ok).toBe(true)
      if (!response.ok) throw new Error('unreachable')

      const profile = response.plan.executionProfiles[0]
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({
          level: 'warning',
          code: 'disallowed_tools_unsupported_driver',
          plane: 'asp-compiler',
          details: expect.objectContaining({
            selectedDriver,
            disallowedTools: ['AskUserQuestion'],
            applied: false,
          }),
        })
      )

      if (profile.kind === 'harness-broker') {
        expect(profile.harnessInvocation.startRequest.spec.process.args).not.toContain(
          '--disallowedTools'
        )
        expect(profile.policy.disallowedTools).toBeUndefined()
      } else if (profile.kind === 'terminal') {
        expect(profile.process.args).not.toContain('--disallowedTools')
        expect(JSON.stringify(profile.policy)).not.toContain('disallowedTools')
      } else {
        throw new Error(`unexpected profile kind ${profile.kind}`)
      }
    }
  )

  test('dry compile of claude-code-tmux creates no tmux session and emits no synthetic terminal ids', async () => {
    const marker = join(fixture.aspHome, 'tmux-was-invoked')
    const tmuxShim = join(fixture.aspHome, 'tmux')
    writeFileSync(
      tmuxShim,
      `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(marker)}
exit 0
`,
      'utf8'
    )
    chmodSync(tmuxShim, 0o755)

    const originalPath = process.env['PATH']
    process.env['PATH'] =
      originalPath === undefined ? fixture.aspHome : `${fixture.aspHome}${delimiter}${originalPath}`
    try {
      const response = await createClient().compileRuntimePlan(
        interactiveCompileRequest({
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-code-cli',
          interactionMode: 'interactive',
        })
      )
      const profile = brokerProfile(response)
      const serializedTerminal = JSON.stringify(profile.brokerTerminal ?? {})
      const serializedStartRequest = JSON.stringify(profile.harnessInvocation.startRequest)

      expect(response.ok).toBe(true)
      expect(profile.brokerTerminal).toEqual(
        expect.not.objectContaining({
          socketPath: expect.any(String),
          sessionName: expect.any(String),
          paneId: expect.any(String),
        })
      )
      expect(serializedStartRequest).not.toMatch(/socketPath|sessionName|paneId/)
      expect(serializedTerminal).not.toMatch(/synthetic|placeholder|fake|todo/i)
      await expect(Bun.file(marker).exists()).resolves.toBe(false)
    } finally {
      if (originalPath === undefined) {
        process.env['PATH'] = undefined
      } else {
        process.env['PATH'] = originalPath
      }
      rmSync(tmuxShim, { force: true })
      rmSync(marker, { force: true })
    }
  })

  test('compiles codex-cli interactive requests to the codex-cli-tmux broker profile', async () => {
    const response = await createClient().compileRuntimePlan(
      interactiveCompileRequest({
        modelProvider: 'openai',
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
        harnessFamily: 'codex',
        preferredHarnessRuntime: 'codex-cli',
        interactionMode: 'interactive',
      })
    )
    const profile = brokerProfile(response)

    expect(response.ok).toBe(true)
    expect(profile.kind).toBe('harness-broker')
    expect(profile.interactionMode).toBe('interactive')
    expect(profile.brokerDriver).toBe('codex-cli-tmux')
    expect(profile.brokerTerminal).toMatchObject({
      host: 'tmux',
      turnDelivery: 'terminal-literal-input',
      operatorAttach: true,
    })
    expect(profile.harnessInvocation.startRequest.spec.process.harnessTransport.kind).toBe('pty')
    expect(profile.harnessInvocation.startRequest.spec.driver).toMatchObject({
      kind: 'codex-cli-tmux',
      terminalHost: 'tmux',
      hookBridge: 'codex-hooks/v1',
    })
    expect(profile.harnessInvocation.startRequest.spec.process.args).toContain(
      'hello foreground terminal'
    )
    expect(profile.harnessInvocation.startRequest.initialInput).toBeUndefined()
    expect(profile.harnessInvocation.initialInputHash).toBeUndefined()
  })

  test('compiled prompt paths use durable artifacts instead of launch overlays', async () => {
    const soulPath = join(fixture.agentRoot, 'SOUL.md')
    writeFileSync(soulPath, '# Cody\n\nSTABLE-PROMPT-PATH-REGRESSION\n', 'utf8')
    try {
      const response = await createClient().compileRuntimePlan(
        interactiveCompileRequest({
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-code-cli',
          interactionMode: 'interactive',
        })
      )
      const profile = brokerProfile(response)
      if (!response.ok) throw new Error('unreachable')

      const artifactPath = response.plan.artifacts.systemPromptFile
      const launchPath = profile.harnessInvocation.startRequest.spec.launch?.systemPromptFile

      expect(artifactPath).toBeDefined()
      expect(launchPath).toBe(artifactPath)
      expect(artifactPath).toContain('.asp-runtime-artifacts')
      expect(artifactPath).toContain(join('system-prompts'))
      expect(artifactPath).not.toContain(join('tmp', 'launch-overlays'))
      expect(readFileSync(artifactPath as string, 'utf8')).toContain(
        'STABLE-PROMPT-PATH-REGRESSION'
      )

      const overlayRoot = join(fixture.aspHome, 'tmp', 'launch-overlays')
      expect(existsSync(overlayRoot) ? readdirSync(overlayRoot) : []).toEqual([])
    } finally {
      rmSync(soulPath, { force: true })
    }
  })

  test('emits all required plan, profile, spec, and start request hashes', async () => {
    const response = await createClient().compileRuntimePlan(baseCompileRequest())
    const profile = brokerProfile(response)
    if (!response.ok) throw new Error('unreachable')

    for (const hash of [
      response.plan.planHash,
      profile.profileHash,
      profile.compatibilityHash,
      profile.harnessInvocation.specHash,
      profile.harnessInvocation.startRequestHash,
    ]) {
      expect(hash).toEqual(expect.any(String))
      expect(hash.length).toBeGreaterThan(0)
    }
  })

  test('keeps hashes stable for identical recompiles and changes mechanics hashes when the model changes', async () => {
    const client = createClient()
    const first = await client.compileRuntimePlan(baseCompileRequest())
    const second = await client.compileRuntimePlan(baseCompileRequest())
    const modelChanged = await client.compileRuntimePlan(
      baseCompileRequest({ requested: { ...baseCompileRequest().requested, model: 'gpt-5.3' } })
    )
    const firstProfile = brokerProfile(first)
    const secondProfile = brokerProfile(second)
    const modelChangedProfile = brokerProfile(modelChanged)
    if (!first.ok || !second.ok || !modelChanged.ok) throw new Error('unreachable')

    expect(second.plan.planHash).toBe(first.plan.planHash)
    expect(secondProfile.harnessInvocation.startRequestHash).toBe(
      firstProfile.harnessInvocation.startRequestHash
    )
    expect(secondProfile.compatibilityHash).toBe(firstProfile.compatibilityHash)
    expect(modelChanged.plan.planHash).not.toBe(first.plan.planHash)
    expect(modelChangedProfile.harnessInvocation.startRequestHash).not.toBe(
      firstProfile.harnessInvocation.startRequestHash
    )
    expect(modelChangedProfile.compatibilityHash).not.toBe(firstProfile.compatibilityHash)
  })

  test('changes compatibilityHash when process.pathPrepend changes', async () => {
    const toolsBinDir = join(fixture.agentRoot, 'tools', 'bin')
    const originalPath = process.env['PATH']
    mkdirSync(toolsBinDir, { recursive: true })

    try {
      process.env['PATH'] = originalPath
      const withPathPrepend = await createClient().compileRuntimePlan(baseCompileRequest())

      process.env['PATH'] =
        originalPath === undefined ? toolsBinDir : `${toolsBinDir}${delimiter}${originalPath}`
      const withoutPathPrepend = await createClient().compileRuntimePlan(baseCompileRequest())

      const withProfile = brokerProfile(withPathPrepend)
      const withoutProfile = brokerProfile(withoutPathPrepend)

      expect(withProfile.harnessInvocation.startRequest.spec.process.pathPrepend).toEqual([
        toolsBinDir,
      ])
      expect(withoutProfile.harnessInvocation.startRequest.spec.process.pathPrepend).toBeUndefined()
      expect(withoutProfile.compatibilityHash).not.toBe(withProfile.compatibilityHash)
    } finally {
      if (originalPath === undefined) {
        process.env['PATH'] = undefined
      } else {
        process.env['PATH'] = originalPath
      }
      rmSync(join(fixture.agentRoot, 'tools'), { recursive: true, force: true })
    }
  })

  test('leaves compatibilityHash unchanged when only ids, correlation, or initial prompt text changes', async () => {
    const client = createClient()
    const first = await client.compileRuntimePlan(baseCompileRequest())
    const idsAndPromptChanged = await client.compileRuntimePlan(
      baseCompileRequest({
        identity: {
          ...baseCompileRequest().identity,
          requestId: 'request_T01609_changed',
          operationId: 'runtimeOperation_T01609_changed',
          invocationId: 'inv_T01609_changed' as InvocationId,
          initialInputId: 'input_T01609_changed' as InputId,
          traceId: 'trace_T01609_changed',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          initialPrompt: 'same mechanics, different first turn text',
        },
        correlation: {
          ...baseCompileRequest().correlation,
          requestId: 'request_T01609_changed',
          operationId: 'runtimeOperation_T01609_changed',
          invocationId: 'inv_T01609_changed' as InvocationId,
          traceId: 'trace_T01609_changed',
          appSessionKey: 'compile-runtime-plan-changed',
        },
      })
    )
    const firstProfile = brokerProfile(first)
    const changedProfile = brokerProfile(idsAndPromptChanged)

    expect(changedProfile.compatibilityHash).toBe(firstProfile.compatibilityHash)
  })

  test('summarizes locked env keys and keeps placement correlation out of the spec env', async () => {
    const req = baseCompileRequest()
    const response = await createClient().compileRuntimePlan(baseCompileRequest())
    const profile = brokerProfile(response)
    if (!response.ok) throw new Error('unreachable')

    expect(response.plan.lockedEnv.lockedEnvKeys).toEqual(
      expect.arrayContaining(['ASP_HOME', 'CODEX_HOME', 'EXTRA_FLAG'])
    )
    expect(profile.harnessInvocation.startRequest.spec.process.lockedEnv).toEqual(
      expect.objectContaining({ EXTRA_FLAG: '1' })
    )
    expect(profile.harnessInvocation.startRequest.spec.process.lockedEnv).not.toHaveProperty(
      'AGENT_SCOPE_REF'
    )
    expect(profile.harnessInvocation.startRequest.spec.process.lockedEnv).not.toHaveProperty(
      'AGENT_LANE_REF'
    )
    expect(profile.harnessInvocation.startRequest.spec.process.lockedEnv).not.toHaveProperty(
      'AGENT_HOST_SESSION_ID'
    )
    expect(req.placement).toEqual(
      expect.objectContaining({
        correlation: expect.objectContaining({
          sessionRef: expect.objectContaining({ scopeRef: expect.any(String) }),
        }),
      })
    )
  })

  test('keeps dispatchEnv out of compiled projections and hash material', async () => {
    const client = createClient()
    const withDispatchA = baseCompileRequest({
      placement: placement({
        dispatchEnv: { AGENT_HOST_SESSION_ID: 'dispatch-host-a', AGENT_LANE_REF: 'main' },
      }),
    })
    const withDispatchB = baseCompileRequest({
      placement: placement({
        dispatchEnv: { AGENT_HOST_SESSION_ID: 'dispatch-host-b', AGENT_LANE_REF: 'repair' },
      }),
    })

    const first = await client.compileRuntimePlan(withDispatchA)
    const second = await client.compileRuntimePlan(withDispatchB)
    const firstProfile = brokerProfile(first)
    const secondProfile = brokerProfile(second)
    if (!first.ok || !second.ok) throw new Error('unreachable')

    expect(second.plan.planHash).toBe(first.plan.planHash)
    expect(second.plan.compileId).toBe(first.plan.compileId)
    expect(secondProfile.profileHash).toBe(firstProfile.profileHash)
    expect(secondProfile.compatibilityHash).toBe(firstProfile.compatibilityHash)
    expect(secondProfile.harnessInvocation.specHash).toBe(firstProfile.harnessInvocation.specHash)
    expect(secondProfile.harnessInvocation.startRequestHash).toBe(
      firstProfile.harnessInvocation.startRequestHash
    )
    expect(secondProfile.harnessInvocation.initialInputHash).toBe(
      firstProfile.harnessInvocation.initialInputHash
    )

    const projectionPairs = [
      [project(first.plan, 'plan'), project(second.plan, 'plan')],
      [project(firstProfile, 'profile'), project(secondProfile, 'profile')],
      [
        project(firstProfile.harnessInvocation.startRequest.spec, 'spec'),
        project(secondProfile.harnessInvocation.startRequest.spec, 'spec'),
      ],
      [
        project(firstProfile.harnessInvocation.startRequest, 'start-request'),
        project(secondProfile.harnessInvocation.startRequest, 'start-request'),
      ],
    ] as const

    for (const [firstProjection, secondProjection] of projectionPairs) {
      const serialized = JSON.stringify(firstProjection)
      expect(JSON.stringify(secondProjection)).toBe(serialized)
      expect(serialized).not.toContain('dispatchEnv')
      expect(serialized).not.toContain('dispatch-host-a')
      expect(serialized).not.toContain('dispatch-host-b')
    }
    expect(JSON.stringify(first.plan)).not.toContain('dispatchEnv')
    expect(JSON.stringify(second.plan)).not.toContain('dispatchEnv')
  })

  test('returns diagnostics instead of a profile for unsupported provider/runtime pairings', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'anthropic',
          model: 'gpt-5.5',
          harnessFamily: 'codex',
          preferredHarnessRuntime: 'codex-cli',
          interactionMode: 'headless',
        },
      })
    )

    expect(response.ok).toBe(false)
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'error', plane: 'asp-compiler' })
    )
    expect('plan' in response).toBe(false)
  })

  test('does not emit claude-agent-sdk embedded profiles while implementation is deferred', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'claude-code',
          preferredHarnessRuntime: 'claude-agent-sdk',
          interactionMode: 'nonInteractive',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
        },
        continuation: undefined,
      })
    )

    expect(response.ok).toBe(false)
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'error',
        plane: 'asp-compiler',
      })
    )
    expect(JSON.stringify(response)).not.toContain('"runtime":"claude-agent-sdk"')
    expect(JSON.stringify(response)).not.toContain('"kind":"embedded-sdk"')
  })

  test('rejects pi-sdk embedded compile requests for non-openai providers', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'anthropic',
          model: 'claude-sonnet-4-5',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-sdk',
          interactionMode: 'nonInteractive',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
        },
        continuation: undefined,
      })
    )

    expect(response.ok).toBe(false)
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_provider',
        level: 'error',
        plane: 'asp-compiler',
      })
    )
    expect(JSON.stringify(response)).not.toContain('"kind":"embedded-sdk"')
  })

  test('rejects pi-sdk interactive requests instead of routing them to embedded-sdk', async () => {
    const response = await createClient().compileRuntimePlan(
      baseCompileRequest({
        requested: {
          modelProvider: 'openai',
          model: 'gpt-5.5',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-sdk',
          interactionMode: 'interactive',
        },
        materialization: {
          ...baseCompileRequest().materialization,
          attachments: [],
        },
        continuation: undefined,
      })
    )

    expect(response.ok).toBe(false)
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_runtime',
        level: 'error',
        plane: 'asp-compiler',
      })
    )
    expect(JSON.stringify(response)).not.toContain('"kind":"embedded-sdk"')
  })

  test('legacy buildHarnessBrokerInvocation delegates to the same compiled broker start request', async () => {
    const req = baseCompileRequest()
    const compiled = await createClient().compileRuntimePlan(req)
    const profile = brokerProfile(compiled)
    const legacy = await createBrokerClient().buildHarnessBrokerInvocation(legacyBrokerRequest(req))

    expect(legacy.startRequest).toEqual(profile.harnessInvocation.startRequest)
  })
})
