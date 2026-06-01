import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSpacesClient } from 'agent-spaces'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { BrokerHelloResponse } from 'spaces-harness-broker-protocol'
import { conservativeDefaultLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../../agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import { AspcClient } from '../src/index.js'

type Fixture = {
  base: string
  agentRoot: string
  projectRoot: string
  aspHome: string
  codexPath: string
}

const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

let fixture: Fixture

beforeEach(() => {
  fixture = createFixture()
  process.env['ASP_CODEX_PATH'] = fixture.codexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
})

afterEach(() => {
  process.env['ASP_CODEX_PATH'] = originalCodexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
  rmSync(fixture.base, { recursive: true, force: true })
})

describe('ASPC combined facade', () => {
  test('co-hosts ASPC and broker hello methods', async () => {
    const client = await startFacadeClient()
    try {
      const aspcHello = await client.hello()
      expect(aspcHello.protocolVersion).toBe(ASPC_PROTOCOL_VERSION)
      expect(aspcHello.capabilities.cohostedBroker).toBe(true)

      const brokerHello = await client.request<BrokerHelloResponse>('broker.hello', {
        clientInfo: { name: 'aspc-facade-test' },
        protocolVersions: ['harness-broker/0.1'],
      })
      expect(brokerHello.protocolVersion).toBe('harness-broker/0.1')
      expect(brokerHello.drivers.length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  })

  test('ASPC compileRuntimePlan is equivalent to SDK compileRuntimePlan', async () => {
    const compileRequest = buildCompileRequest('equivalence')
    const sdk = createAgentSpacesClient({ aspHome: fixture.aspHome })
    const sdkResponse = await sdk.compileRuntimePlan(compileRequest)
    expect(sdkResponse.ok).toBe(true)

    const client = await startFacadeClient()
    try {
      const rpcResponse = await client.compileRuntimePlan({
        compileRequest,
        aspHome: fixture.aspHome,
      })
      expect(rpcResponse.ok).toBe(true)
      if (!sdkResponse.ok || !rpcResponse.ok) return

      const sdkProfile = sdkResponse.plan.executionProfiles[0] as BrokerExecutionProfile
      const rpcProfile = rpcResponse.plan.executionProfiles[0] as BrokerExecutionProfile
      expect(rpcResponse.plan.compileId).toBe(sdkResponse.plan.compileId)
      expect(rpcResponse.plan.planHash).toBe(sdkResponse.plan.planHash)
      expect(rpcProfile.profileHash).toBe(sdkProfile.profileHash)
      expect(rpcProfile.harnessInvocation.startRequestHash).toBe(
        sdkProfile.harnessInvocation.startRequestHash
      )
      expect(rpcProfile.harnessInvocation.startRequest).toEqual(
        sdkProfile.harnessInvocation.startRequest
      )
    } finally {
      await client.close()
    }
  })

  test('compileHarnessInvocation returns selected profile and exact dispatch start request', async () => {
    const client = await startFacadeClient()
    try {
      const response = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest('harness_invocation'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
        dispatchEnv: { EXTRA_FLAG: 'aspc' },
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.selectedProfile.brokerDriver).toBe('codex-app-server')
      expect(response.startRequest).toEqual(response.selectedProfile.harnessInvocation.startRequest)
      expect(response.dispatchRequest.startRequest).toEqual(response.startRequest)
      expect(response.dispatchRequest.dispatchEnv).toEqual({ EXTRA_FLAG: 'aspc' })
    } finally {
      await client.close()
    }
  })

  test('compileHarnessInvocation carries lifecycle policy only on dispatch envelope', async () => {
    const client = await startFacadeClient()
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_aspc_default')
    try {
      const response = await client.compileHarnessInvocation({
        compileRequest: buildCompileRequest('harness_invocation_lifecycle'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
        lifecyclePolicy,
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.dispatchRequest.lifecyclePolicy).toEqual(lifecyclePolicy)
      expect(response.dispatchRequest.startRequest).toEqual(response.startRequest)
      expect(JSON.stringify(response.startRequest)).not.toContain('lifecyclePolicy')
    } finally {
      await client.close()
    }
  })

  test('compileAndStart compiles through ASPC and starts through the co-hosted broker', async () => {
    const client = await startFacadeClient()
    try {
      const response = await client.compileAndStart({
        compileRequest: buildCompileRequest('compile_and_start'),
        aspHome: fixture.aspHome,
        profileSelector: { brokerDriver: 'codex-app-server' },
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return

      expect(response.compile.dispatchRequest.startRequest).toEqual(response.compile.startRequest)
      expect(response.startResponse.invocationId).toBe(
        response.compile.startRequest.spec.invocationId
      )

      await client.request('invocation.stop', {
        invocationId: response.startResponse.invocationId,
        reason: 'test cleanup',
        graceMs: 100,
      })
      await client.request('invocation.dispose', {
        invocationId: response.startResponse.invocationId,
      })
    } finally {
      await client.close()
    }
  })
})

function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'aspc-facade-test-'))
  const agentRoot = join(base, 'agents', 'sparky')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
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
  return {
    base,
    agentRoot,
    projectRoot,
    aspHome,
    codexPath: createCodexShim(aspHome),
  }
}

function createCodexShim(dir: string): string {
  const shimPath = join(dir, 'codex')
  const fixturePath = new URL(
    '../../harness-broker/test/fixtures/fake-codex/start-fresh-turn.ts',
    import.meta.url
  ).pathname
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$*" == *"app-server"* && "$*" == *"--help"* ]]; then
  echo "app-server"
  exit 0
fi
if [[ "$*" == *"app-server"* ]]; then
  exec bun "${fixturePath}"
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function buildCompileRequest(namespace: string): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: `aspc_${namespace}`,
    invocationId: `inv_aspc_${namespace}`,
    initialInputId: `input_aspc_${namespace}`,
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: 'sparky@agent-spaces',
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: `Say ${namespace}`,
      taskContext: {
        taskId: 'T-01747',
        phase: 'aspc-test',
        role: 'smoke',
        requiredEvidenceKinds: ['contract-artifacts'],
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 10_000 },
      observability: { traceId: identity.traceId },
      capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      appId: 'agent-spaces',
      appSessionKey: `aspc-${namespace}`,
      scopeRef: 'sparky@agent-spaces',
      laneRef: 'main',
    },
  }
}

async function startFacadeClient(): Promise<AspcClient> {
  return AspcClient.start({
    command: process.execPath,
    args: ['packages/aspc/bin/aspc-facade.js', 'run', '--transport', 'stdio'],
    cwd: new URL('../../..', import.meta.url).pathname,
    env: {
      ASP_CODEX_PATH: fixture.codexPath,
      ASP_CODEX_SKIP_COMMON_PATHS: '1',
    },
  })
}
