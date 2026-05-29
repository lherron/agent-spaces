/**
 * Detailed field-mapping coverage for the compiled harness-broker profile.
 *
 * Migrated from the former client-broker-invocation.test.ts direct-builder
 * suite (C4 / Stream 1). The assertions now run through compileRuntimePlan and
 * inspect the broker execution profile instead of calling
 * buildHarnessBrokerInvocation directly. The broad gate cases (hash presence,
 * id preservation, model-change mechanics) live in the smokey gate suite
 * (compile-runtime-plan.test.ts); this file focuses on the DETAILED process /
 * driver / continuation / correlation mapping the old builder test owned, plus
 * a single legacy delegate-parity anchor.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HarnessInvocationSpec, InputId, InvocationId } from 'spaces-harness-broker-protocol'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import {
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  validateBrokerExecutionProfile,
} from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import type {
  AgentSpacesClient,
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
} from '../types.js'

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
  const base = mkdtempSync(join(tmpdir(), 'asp-compiler-broker-profile-'))
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

[brain]
enabled = false
`,
    'utf8'
  )
  createClaudeShim(aspHome)
  createCodexShim(aspHome)
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
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01610',
        laneRef: 'main',
      },
      hostSessionId: 'host-01610',
    },
    ...overrides,
  }
}

function baseCompileRequest(overrides: Partial<RuntimeCompileRequest> = {}): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_T01610',
      operationId: 'runtimeOperation_T01610',
      hostSessionId: 'hostSession_T01610',
      generation: 1,
      runtimeId: 'runtime_T01610',
      invocationId: 'inv_T01610' as InvocationId,
      initialInputId: 'input_T01610' as InputId,
      runId: 'run_T01610',
      traceId: 'trace_T01610',
      idempotencyKey: 'compiler-broker-profile',
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
        taskId: 'T-01610',
        phase: 'green',
        role: 'curly',
        requiredEvidenceKinds: ['green-test'],
        hintsText: 'detailed broker profile mapping',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: 'trace_T01610' },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    continuation: {
      schemaVersion: 'runtime-continuation/v1',
      hrc: { provider: 'openai', keyHash: 'thread-hash', key: 'thread_T01610' },
      broker: { provider: 'codex', kind: 'thread', keyHash: 'thread-hash', key: 'thread_T01610' },
      source: 'harness-broker',
      observedAt: '2026-05-24T07:05:32.000Z',
    },
    correlation: {
      requestId: 'request_T01610',
      operationId: 'runtimeOperation_T01610',
      hostSessionId: 'hostSession_T01610',
      generation: 1,
      runtimeId: 'runtime_T01610',
      runId: 'run_T01610',
      invocationId: 'inv_T01610' as InvocationId,
      traceId: 'trace_T01610',
      appId: 'agent-spaces-tests',
      appSessionKey: 'compiler-broker-profile',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01610',
      laneRef: 'main',
    },
    ...overrides,
  }
}

function claudeTmuxCompileRequest(
  overrides: Partial<RuntimeCompileRequest> = {}
): RuntimeCompileRequest {
  return baseCompileRequest({
    requested: {
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
    },
    materialization: {
      ...baseCompileRequest().materialization,
      initialPrompt: 'hello interactive claude tmux broker',
      attachments: [],
      taskContext: {
        taskId: 'T-01658',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test'],
        hintsText: 'compileRuntimePlan must emit the interactive claude-code-tmux broker profile',
      },
    },
    hrcPolicy: {
      ...baseCompileRequest().hrcPolicy,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
    },
    continuation: undefined,
    ...overrides,
  })
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

function compiledSpec(profile: BrokerExecutionProfile): HarnessInvocationSpec {
  return profile.harnessInvocation.startRequest.spec
}

function textFromInitialInput(profile: BrokerExecutionProfile): string | undefined {
  const textPart = profile.harnessInvocation.startRequest.initialInput?.content.find(
    (part) => part.type === 'text'
  )
  return textPart?.type === 'text' ? textPart.text : undefined
}

/**
 * Mirrors the brokerReq the compiler derives internally so the legacy
 * delegate's start request can be deep-compared against the compiled one.
 */
function legacyBrokerRequest(
  req: RuntimeCompileRequest
): BuildHarnessBrokerInvocationRequest & { initialInputId?: InputId | undefined } {
  return {
    placement: req.placement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    model: req.requested.model,
    continuation: { provider: 'openai', key: req.continuation?.hrc.key },
    prompt: req.materialization.initialPrompt,
    attachments: [{ kind: 'file', path: fixture.imagePath, contentType: 'image/png' }],
    lockedEnv: { EXTRA_FLAG: '1' },
    invocationId: req.identity.invocationId,
    initialInputId: req.identity.initialInputId,
    labels: { task: 'T-01610' },
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

describe('compiled broker profile field mapping', () => {
  beforeAll(() => {
    fixture = createFixture()
    process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
    process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
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
    if (originalSkipCommon === undefined) {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    } else {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
    }
    fixture.cleanup()
  })

  test('compiles a single harness-broker profile with a validating start request', async () => {
    const req = baseCompileRequest()
    const profile = brokerProfile(await createClient().compileRuntimePlan(req))

    expect(profile.kind).toBe('harness-broker')
    expect(profile.brokerDriver).toBe('codex-app-server')
    expect(validateInvocationStartRequest(profile.harnessInvocation.startRequest)).toEqual(
      profile.harnessInvocation.startRequest
    )
    expect(compiledSpec(profile).invocationId).toBe(req.identity.invocationId)
  })

  test('omits HRC and ACP launch metadata from the compiled broker spec', async () => {
    const profile = brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
    const serialized = JSON.stringify(compiledSpec(profile))

    // runtimeId/runId are intentionally present as flat broker correlation
    // strings; the launch-orchestration metadata below must never leak into
    // the broker-owned process spec.
    for (const forbidden of [
      'launchId',
      'tmuxId',
      'callbackSocket',
      'spoolPath',
      'persistence',
      'hrc',
      'acp',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test('maps prepared Codex process fields with jsonrpc stdio transport', async () => {
    const spec = compiledSpec(
      brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
    )

    expect(spec.process.command).toBeTruthy()
    expect(spec.process.args).toContain('app-server')
    expect(spec.process.cwd).toBe(fixture.projectRoot)
    expect(spec.process.lockedEnv).toEqual(expect.objectContaining({ EXTRA_FLAG: '1' }))
    expect(spec.process.harnessTransport).toEqual({ kind: 'jsonrpc-stdio' })
    expect(spec.process.limits).toEqual({ startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 })
  })

  test('maps the Codex app-server driver and harness identity fields', async () => {
    const spec = compiledSpec(
      brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
    )

    expect(spec.harness).toEqual({
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    })
    expect(spec.interaction).toEqual({
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'fifo',
    })
    expect(spec.driver).toEqual(
      expect.objectContaining({
        kind: 'codex-app-server',
        resumeThreadId: 'thread_T01610',
        approvalPolicy: 'never',
        permissionPolicy: { mode: 'deny' },
        resumeFallback: 'fail',
      })
    )
  })

  test('emits a validating interactive claude-code-tmux harness-broker profile', async () => {
    const req = claudeTmuxCompileRequest()
    const profile = brokerProfile(await createClient().compileRuntimePlan(req))
    const spec = compiledSpec(profile)

    expect(profile.kind).toBe('harness-broker')
    expect(profile.interactionMode).toBe('interactive')
    expect(profile.brokerDriver).toBe('claude-code-tmux')
    expect(profile.brokerProtocol).toBe('harness-broker/0.1')
    expect(profile.brokerTerminal).toEqual({
      host: 'tmux',
      startupMethod: 'create-terminal',
      turnDelivery: 'terminal-literal-input',
      operatorAttach: true,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
    })
    expect(profile.policy.exposurePolicy).toEqual(profile.brokerTerminal?.exposurePolicy)
    expect(spec.harness).toEqual({
      frontend: 'claude-code',
      provider: 'anthropic',
      driver: 'claude-code-tmux',
    })
    expect(spec.interaction).toEqual(
      expect.objectContaining({
        mode: 'interactive',
        turnConcurrency: 'single',
      })
    )
    expect(spec.driver).toEqual(
      expect.objectContaining({
        kind: 'claude-code-tmux',
        terminalHost: 'tmux',
      })
    )
    expect(spec.process.harnessTransport).toEqual({ kind: 'pty' })
    expect(validateBrokerExecutionProfile(profile)).toEqual([])
  })

  test('passes the interactive claude-code-tmux prompt through process argv', async () => {
    const req = claudeTmuxCompileRequest()
    const profile = brokerProfile(await createClient().compileRuntimePlan(req))
    const spec = compiledSpec(profile)

    const separatorIndex = spec.process.args.indexOf('--')
    expect(separatorIndex).toBeGreaterThanOrEqual(0)
    expect(spec.process.args.slice(separatorIndex)).toEqual([
      '--',
      'hello interactive claude tmux broker',
    ])
    expect(textFromInitialInput(profile)).toBeUndefined()
    expect(profile.harnessInvocation.initialInputHash).toBeUndefined()
  })

  test('translates the OpenAI continuation into a broker Codex thread continuation', async () => {
    const spec = compiledSpec(
      brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
    )

    expect(spec.continuation).toEqual({
      provider: 'codex',
      kind: 'thread',
      key: 'thread_T01610',
    })
  })

  test('compiles correlation into a flat broker-safe string map without a nested sessionRef', async () => {
    const req = baseCompileRequest()
    const spec = compiledSpec(brokerProfile(await createClient().compileRuntimePlan(req)))

    expect(spec.correlation).toBeDefined()
    expect(spec.correlation?.['sessionRef']).toBeUndefined()
    for (const value of Object.values(spec.correlation ?? {})) {
      expect(typeof value).toBe('string')
    }
    expect(spec.correlation).toEqual(
      expect.objectContaining({
        requestId: req.correlation.requestId,
        hostSessionId: req.correlation.hostSessionId,
        scopeRef: req.correlation.scopeRef,
        laneRef: req.correlation.laneRef,
      })
    )
  })

  test('does not duplicate the one-turn prompt or images into driver defaults', async () => {
    const spec = compiledSpec(
      brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
    )

    expect(spec.driver).toEqual(
      expect.not.objectContaining({
        prompt: expect.any(String),
        defaultImageAttachments: expect.any(Array),
      })
    )
  })

  test('changes the spec and start request hashes when a process mechanic changes', async () => {
    const client = createClient()
    const base = brokerProfile(await client.compileRuntimePlan(baseCompileRequest()))
    const limitsChanged = brokerProfile(
      await client.compileRuntimePlan(
        baseCompileRequest({
          hrcPolicy: {
            ...baseCompileRequest().hrcPolicy,
            resourceLimits: { startupTimeoutMs: 11_000, turnTimeoutMs: 21_000 },
          },
        })
      )
    )

    expect(limitsChanged.harnessInvocation.specHash).not.toBe(base.harnessInvocation.specHash)
    expect(limitsChanged.harnessInvocation.startRequestHash).not.toBe(
      base.harnessInvocation.startRequestHash
    )
  })

  test('keeps dispatch correlation out of locked broker env', async () => {
    const profile = brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))

    expect(profile.harnessInvocation.startRequest.spec.process.lockedEnv).not.toEqual(
      expect.objectContaining({
        AGENT_SCOPE_REF: expect.any(String),
        AGENT_LANE_REF: expect.any(String),
        AGENT_HOST_SESSION_ID: expect.any(String),
      })
    )
  })

  // The headless broker route still hard-rejects non-codex / non-headless
  // pairings before any materialization. Note: interactionMode 'interactive' is
  // NO LONGER an unsupported route — it compiles to a foreground terminal
  // profile (T-01638 Phase 2), so it is intentionally absent from this table.
  test.each([
    ['provider', { modelProvider: 'anthropic' as const }, 'unsupported_provider'],
    ['harness family', { harnessFamily: 'claude-code' as const }, 'unsupported_harness'],
    ['runtime', { preferredHarnessRuntime: 'claude-code-cli' as const }, 'unsupported_runtime'],
    [
      'non-headless mode',
      { interactionMode: 'nonInteractive' as const },
      'unsupported_interaction_mode',
    ],
  ])(
    'returns compiler diagnostics for an unsupported %s before materialization',
    async (_name, override, expectedCode) => {
      const base = baseCompileRequest()
      const response = await createClient().compileRuntimePlan({
        ...base,
        // A non-existent agentRoot proves the route was rejected before any
        // bundle materialization was attempted.
        placement: placement({ agentRoot: '/path/that/must/not/be/materialized' }),
        requested: { ...base.requested, ...override },
      })

      expect(response.ok).toBe(false)
      expect('plan' in response).toBe(false)
      expect(response.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'error', plane: 'asp-compiler', code: expectedCode })
      )
    }
  )

  test('emits tool-bin pathPrepend as a typed PATH mutation and keeps PATH out of lockedEnv', async () => {
    // Agent-local tools surface a tools/bin directory; its PATH-prepend must be
    // emitted as the typed HarnessProcessSpec.pathPrepend, never via lockedEnv.
    const toolsBinDir = join(fixture.agentRoot, 'tools', 'bin')
    mkdirSync(toolsBinDir, { recursive: true })
    try {
      const spec = compiledSpec(
        brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
      )
      expect(spec.process.pathPrepend).toEqual([toolsBinDir])
      expect(spec.process.lockedEnv).not.toHaveProperty('PATH')
    } finally {
      rmSync(join(fixture.agentRoot, 'tools'), { recursive: true, force: true })
    }
  })

  test('omits pathPrepend from the broker spec when the agent has no tools', async () => {
    const spec = compiledSpec(
      brokerProfile(await createClient().compileRuntimePlan(baseCompileRequest()))
    )
    expect(spec.process.pathPrepend).toBeUndefined()
    expect(spec.process.lockedEnv).not.toHaveProperty('PATH')
  })

  test('legacy buildHarnessBrokerInvocation delegates to the compiled broker start request', async () => {
    const req = baseCompileRequest()
    const profile = brokerProfile(await createClient().compileRuntimePlan(req))
    const legacy = await createBrokerClient().buildHarnessBrokerInvocation(legacyBrokerRequest(req))

    expect(legacy.startRequest).toEqual(profile.harnessInvocation.startRequest)
  })
})
