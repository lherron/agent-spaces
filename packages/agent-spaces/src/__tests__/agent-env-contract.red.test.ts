/**
 * T-04218 acceptance bar: every materialized agent env writer must use the
 * canonical AGENT_* session contract, keep reserved identity unspoofable, and
 * preserve compile/hash neutrality for per-launch correlation.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RuntimePlacement } from 'spaces-config'
import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import { preparePlacementCliRuntime } from '../prepare-cli-runtime.js'
import type { AgentSpacesClient } from '../types.js'

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

type Fixture = {
  agentRoot: string
  projectRoot: string
  aspHome: string
  codexShim: string
  imagePath: string
  cleanup: () => void
}

const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

afterEach(() => {
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
})

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'asp-agent-env-contract-'))
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
priming_prompt = "Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}."

[spaces]
base = []

[harnessDefaults.codex]
model = "gpt-5.5"
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
profile = "workbench"
`,
    'utf8'
  )

  const codexShim = join(aspHome, 'codex')
  writeFileSync(
    codexShim,
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
  chmodSync(codexShim, 0o755)

  return {
    agentRoot,
    projectRoot,
    aspHome,
    codexShim,
    imagePath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function placement(fixture: Fixture, overrides: Partial<RuntimePlacement> = {}): RuntimePlacement {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    dryRun: true,
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04218',
        laneRef: 'lane:repair',
      },
      hostSessionId: 'host-session-04218',
      runId: 'run-04218',
    },
    ...overrides,
  }
}

function compileRequest(
  fixture: Fixture,
  overrides: Partial<RuntimeCompileRequest> = {}
): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_T04218',
      operationId: 'runtimeOperation_T04218',
      hostSessionId: 'hostSession_T04218',
      generation: 1,
      runtimeId: 'runtime_T04218',
      invocationId: 'inv_T04218' as InvocationId,
      initialInputId: 'input_T04218' as InputId,
      runId: 'run_T04218',
      traceId: 'trace_T04218',
      idempotencyKey: 'agent-env-contract-red',
    },
    placement: placement(fixture),
    requested: {
      modelProvider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: 'inspect canonical agent env',
      attachments: [{ kind: 'image', path: fixture.imagePath, mimeType: 'image/png' }],
      taskContext: {
        taskId: 'T-04218',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test'],
        hintsText: 'canonical agent env contract must stay hash-neutral',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: 'trace_T04218' },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    correlation: {
      requestId: 'request_T04218',
      operationId: 'runtimeOperation_T04218',
      hostSessionId: 'hostSession_T04218',
      generation: 1,
      runtimeId: 'runtime_T04218',
      runId: 'run_T04218',
      invocationId: 'inv_T04218' as InvocationId,
      traceId: 'trace_T04218',
      appId: 'agent-spaces-tests',
      appSessionKey: 'agent-env-contract',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-04218',
      laneRef: 'lane:repair',
    },
    ...overrides,
  }
}

function brokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error('compileRuntimePlan returned diagnostics instead of a broker profile')
  }
  const profiles = response.plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

async function prepareCodexRuntime(fixture: Fixture, reqDispatchEnv?: Record<string, string>) {
  process.env['ASP_CODEX_PATH'] = fixture.codexShim
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  return await preparePlacementCliRuntime(
    {
      placement: placement(fixture),
      provider: 'openai',
      frontend: 'codex-cli',
      interactionMode: 'headless',
      model: 'gpt-5.5',
      aspHome: fixture.aspHome,
      ...(reqDispatchEnv !== undefined ? { dispatchEnv: reqDispatchEnv } : {}),
    },
    fixture.aspHome
  )
}

describe('T-04218 canonical agent env contract', () => {
  test('prepared agent runtime env exposes canonical AGENT_* contract plus Phase 0/1 aliases outside lockedEnv', async () => {
    const fixture = createFixture()
    try {
      const prepared = await prepareCodexRuntime(fixture)

      expect(prepared.dispatchEnv).toEqual(
        expect.objectContaining({
          AGENT_ID: 'cody',
          AGENT_PROJECT: 'agent-spaces',
          AGENT_TASK: 'T-04218',
          AGENT_LANE: 'repair',
          AGENT_SESSION_REF: 'agent:cody:project:agent-spaces:task:T-04218/lane:repair',
          AGENT_RUN_ID: 'run-04218',
          AGENT_HOST_SESSION_ID: 'host-session-04218',
          AGENT_PROJECT_ROOT: fixture.projectRoot,
          AGENT_ACTOR: 'cody',
          WRKQ_ACTOR: 'cody',
          AGENT_SCOPE_REF: 'agent:cody:project:agent-spaces:task:T-04218',
          AGENT_LANE_REF: 'lane:repair',
          ASP_PROJECT_ROOT: fixture.projectRoot,
          HRC_SESSION_REF: 'agent:cody:project:agent-spaces:task:T-04218/lane:repair',
          HRC_RUN_ID: 'run-04218',
          HRC_HOST_SESSION_ID: 'host-session-04218',
        })
      )
      expect(prepared.lockedEnv).toEqual(
        expect.objectContaining({
          AGENTCHAT_ID: 'cody',
          ASP_PROJECT: 'agent-spaces',
        })
      )
      for (const reservedKey of [
        'AGENT_ID',
        'AGENT_PROJECT',
        'AGENT_TASK',
        'AGENT_LANE',
        'AGENT_SESSION_REF',
        'AGENT_RUN_ID',
        'AGENT_HOST_SESSION_ID',
        'AGENT_PROJECT_ROOT',
        'AGENT_ACTOR',
        'WRKQ_ACTOR',
        'HRC_SESSION_REF',
      ]) {
        expect(prepared.lockedEnv).not.toHaveProperty(reservedKey)
      }
    } finally {
      fixture.cleanup()
    }
  })

  test('caller dispatch env cannot spoof reserved session identity keys', async () => {
    const fixture = createFixture()
    try {
      const prepared = await prepareCodexRuntime(fixture, {
        AGENT_ID: 'attacker',
        AGENT_PROJECT: 'other-project',
        AGENT_SESSION_REF: 'agent:attacker:project:other/lane:main',
        AGENT_HOST_SESSION_ID: 'attacker-host',
        WRKQ_ACTOR: 'attacker',
      })

      expect(prepared.dispatchEnv).toEqual(
        expect.objectContaining({
          AGENT_ID: 'cody',
          AGENT_PROJECT: 'agent-spaces',
          AGENT_SESSION_REF: 'agent:cody:project:agent-spaces:task:T-04218/lane:repair',
          AGENT_HOST_SESSION_ID: 'host-session-04218',
          WRKQ_ACTOR: 'cody',
        })
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('per-launch agent session env is absent from lockedEnv and hash-neutral across compile plans', async () => {
    const fixture = createFixture()
    try {
      process.env['ASP_CODEX_PATH'] = fixture.codexShim
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
      const client = createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
      const first = await client.compileRuntimePlan(compileRequest(fixture))
      const changedCorrelation = await client.compileRuntimePlan(
        compileRequest(fixture, {
          identity: {
            ...compileRequest(fixture).identity,
            requestId: 'request_T04218_changed',
            operationId: 'runtimeOperation_T04218_changed',
            hostSessionId: 'hostSession_T04218_changed',
            invocationId: 'inv_T04218_changed' as InvocationId,
            runId: 'run_T04218_changed',
            traceId: 'trace_T04218_changed',
          },
          placement: placement(fixture, {
            correlation: {
              sessionRef: {
                scopeRef: 'agent:cody:project:agent-spaces:task:T-99999',
                laneRef: 'main',
              },
              hostSessionId: 'host-session-changed',
              runId: 'run-changed',
            },
          }),
          correlation: {
            ...compileRequest(fixture).correlation,
            requestId: 'request_T04218_changed',
            operationId: 'runtimeOperation_T04218_changed',
            hostSessionId: 'hostSession_T04218_changed',
            invocationId: 'inv_T04218_changed' as InvocationId,
            runId: 'run_T04218_changed',
            traceId: 'trace_T04218_changed',
            scopeRef: 'agent:cody:project:agent-spaces:task:T-99999',
            laneRef: 'main',
          },
        })
      )
      const firstProfile = brokerProfile(first)
      const changedProfile = brokerProfile(changedCorrelation)

      expect(changedCorrelation.ok && changedCorrelation.plan.planHash).toBe(
        first.ok && first.plan.planHash
      )
      expect(changedProfile.profileHash).toBe(firstProfile.profileHash)
      expect(changedProfile.compatibilityHash).toBe(firstProfile.compatibilityHash)
      expect(changedProfile.harnessInvocation.specHash).toBe(
        firstProfile.harnessInvocation.specHash
      )
      expect(changedProfile.harnessInvocation.startRequestHash).toBe(
        firstProfile.harnessInvocation.startRequestHash
      )
      for (const reservedKey of [
        'AGENT_SESSION_REF',
        'AGENT_RUN_ID',
        'AGENT_HOST_SESSION_ID',
        'AGENT_PROJECT_ROOT',
        'AGENT_ACTOR',
        'WRKQ_ACTOR',
        'HRC_SESSION_REF',
        'HRC_RUN_ID',
        'HRC_HOST_SESSION_ID',
      ]) {
        expect(
          firstProfile.harnessInvocation.startRequest.spec.process.lockedEnv
        ).not.toHaveProperty(reservedKey)
      }
    } finally {
      fixture.cleanup()
    }
  })

  test('docs/env-contract.md documents the allowed cross-boundary variables and legacy kill list', () => {
    const docPath = join(process.cwd(), 'docs', 'env-contract.md')

    expect(existsSync(docPath)).toBe(true)

    const doc = readFileSync(docPath, 'utf8')
    for (const requiredToken of [
      'AGENT_SESSION_REF',
      'AGENT_ACTOR',
      'WRKQ_ACTOR',
      'ACP_BASE_URL',
      'WRKQ_DB_PATH',
      'TASKBOARD_API_HOST',
      'ASP_PI_PATH',
      'CP_URL',
      'ASP_ROOT_DIR',
      'PI_PATH',
      'WRKQD_URL',
      'WRKQD_ADDR',
    ]) {
      expect(doc).toContain(requiredToken)
    }
  })
})
