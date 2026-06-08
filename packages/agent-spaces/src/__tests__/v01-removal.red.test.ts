/**
 * Ph6 RED tests: compileRuntimePlan brokerProtocol v0.1 removal (T-01867)
 *
 * Asserts the TARGET end state where compileRuntimePlan emits
 * BrokerExecutionProfile.brokerProtocol === 'harness-broker/0.2' for all
 * broker profile variants (headless codex, interactive claude-code-tmux).
 *
 * Tests FAIL today because compile-runtime-plan.ts hard-codes
 * `brokerProtocol: 'harness-broker/0.1'` in three places.
 * They pass after Ph6 changes all occurrences to 'harness-broker/0.2'.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import type { AgentSpacesClient } from '../types.js'

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

// ---------------------------------------------------------------------------
// Minimal fixture — codex + claude shims, temp asp-home
// ---------------------------------------------------------------------------

function createCodexShim(dir: string): void {
  const p = join(dir, 'codex')
  writeFileSync(
    p,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "codex 999.0.0"; exit 0; fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then echo "app-server"; exit 0; fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(p, 0o755)
}

function createClaudeShim(dir: string): void {
  const p = join(dir, 'claude')
  writeFileSync(
    p,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "claude 1.0.0"; exit 0; fi
echo "claude shim"
`,
    'utf8'
  )
  chmodSync(p, 0o755)
}

interface Fixture {
  agentRoot: string
  projectRoot: string
  aspHome: string
  cleanup: () => void
}

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'asp-v01-removal-red-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n[spaces]\nbase = []\n[brain]\nenabled = false\n',
    'utf8'
  )
  createClaudeShim(aspHome)
  createCodexShim(aspHome)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let fixture: Fixture
const origCodexPath = process.env['ASP_CODEX_PATH']
const origSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
const origClaudePath = process.env['ASP_CLAUDE_PATH']

beforeAll(() => {
  fixture = createFixture()
  process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
})

afterAll(() => {
  process.env['ASP_CODEX_PATH'] = origCodexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = origSkipCommon
  process.env['ASP_CLAUDE_PATH'] = origClaudePath
  fixture.cleanup()
})

function createClient(): CompileClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
}

function basePlacement(): RuntimeCompileRequest['placement'] {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    lockedEnv: {},
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01867',
        laneRef: 'main',
      },
      hostSessionId: 'host-01867',
    },
  }
}

function headlessCodexRequest(): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_T01867',
      operationId: 'op_T01867',
      hostSessionId: 'host_T01867',
      generation: 1,
      runtimeId: 'runtime_T01867',
      invocationId: 'inv_T01867' as InvocationId,
      initialInputId: 'input_T01867' as InputId,
      runId: 'run_T01867',
      traceId: 'trace_T01867',
      idempotencyKey: 'v01-removal-red',
    },
    placement: basePlacement(),
    requested: {
      modelProvider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: 'Ph6 red test v0.1 removal',
      attachments: [],
      taskContext: {
        taskId: 'T-01867',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test'],
        hintsText: 'broker profile brokerProtocol must be harness-broker/0.2',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: false },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: 'trace_T01867' },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    continuation: {
      schemaVersion: 'runtime-continuation/v1',
      hrc: { provider: 'openai', keyHash: 'thread-hash', key: 'thread_T01867' },
      broker: { provider: 'codex', kind: 'thread', keyHash: 'thread-hash', key: 'thread_T01867' },
      source: 'harness-broker',
      observedAt: '2026-05-24T07:05:32.000Z',
    },
    correlation: {
      requestId: 'request_T01867',
      operationId: 'op_T01867',
      hostSessionId: 'host_T01867',
      generation: 1,
      runtimeId: 'runtime_T01867',
      runId: 'run_T01867',
      invocationId: 'inv_T01867' as InvocationId,
      traceId: 'trace_T01867',
      appId: 'agent-spaces-tests',
      appSessionKey: 'v01-removal-red',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01867',
      laneRef: 'main',
    },
  }
}

function interactiveClaudeRequest(): RuntimeCompileRequest {
  const base = headlessCodexRequest()
  return {
    ...base,
    identity: {
      ...base.identity,
      requestId: 'request_T01867_claude',
      operationId: 'op_T01867_claude',
      invocationId: 'inv_T01867_claude' as InvocationId,
      idempotencyKey: 'v01-removal-red-claude',
    },
    requested: {
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
    },
    hrcPolicy: {
      ...base.hrcPolicy,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
    },
    continuation: undefined,
    correlation: {
      ...base.correlation,
      requestId: 'request_T01867_claude',
      operationId: 'op_T01867_claude',
      invocationId: 'inv_T01867_claude' as InvocationId,
      idempotencyKey: 'v01-removal-red-claude',
    },
  } as RuntimeCompileRequest
}

function extractBrokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(`compile failed: ${JSON.stringify(response.diagnostics)}`)
  const profiles = response.plan.executionProfiles.filter(
    (p): p is BrokerExecutionProfile => p.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

// ---------------------------------------------------------------------------
// RED tests
// ---------------------------------------------------------------------------

describe('Ph6 red: compileRuntimePlan emits brokerProtocol v0.2 (T-01867)', () => {
  test('headless codex broker profile has brokerProtocol harness-broker/0.2', async () => {
    // RED today: compile-runtime-plan.ts emits `brokerProtocol: 'harness-broker/0.1'`
    const response = await createClient().compileRuntimePlan(headlessCodexRequest())
    const profile = extractBrokerProfile(response)
    expect(profile.brokerProtocol).toBe('harness-broker/0.2')
  })

  test('headless codex broker profile does NOT have brokerProtocol harness-broker/0.1', async () => {
    // RED today: confirms the current broken state emits v0.1
    const response = await createClient().compileRuntimePlan(headlessCodexRequest())
    const profile = extractBrokerProfile(response)
    expect(profile.brokerProtocol).not.toBe('harness-broker/0.1')
  })

  test('interactive claude-code-tmux broker profile has brokerProtocol harness-broker/0.2', async () => {
    // RED today: interactive path also emits v0.1
    const response = await createClient().compileRuntimePlan(interactiveClaudeRequest())
    const profile = extractBrokerProfile(response)
    expect(profile.brokerProtocol).toBe('harness-broker/0.2')
  })
})
