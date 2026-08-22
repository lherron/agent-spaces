/**
 * Shared fixture + drive helpers for the `spaces-aspc-facade` composition
 * package tests. Everything here drives the REAL bin
 * (`packages/aspc-facade/bin/aspc-facade.js`) over stdio JSON-RPC — no
 * hand-constructed server objects.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AspcClient } from 'spaces-aspc'
import type { JsonRpcNotification } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../../agent-spaces/src/testing/pre-hrc-broker-helpers.js'

/** JSON-RPC "method not found" — the code that proves a route is NOT served. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

export const repoRoot = new URL('../../..', import.meta.url).pathname

/** The preserved global-bin contract: the real file, spawned as taskboard spawns it. */
export const FACADE_BIN = 'packages/aspc-facade/bin/aspc-facade.js'

export type Fixture = {
  base: string
  agentRoot: string
  projectRoot: string
  aspHome: string
  codexPath: string
}

export function createFixture(codexFixture = 'start-fresh-turn.ts'): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'aspc-facade-test-'))
  const agentRoot = join(base, 'agents', 'sparky')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `version = 3

[spaces]
base = []
`,
    'utf8'
  )
  return {
    base,
    agentRoot,
    projectRoot,
    aspHome,
    codexPath: createCodexShim(aspHome, codexFixture),
  }
}

export function removeFixture(fixture: Fixture): void {
  rmSync(fixture.base, { recursive: true, force: true })
}

function createCodexShim(dir: string, codexFixture: string): string {
  const shimPath = join(dir, 'codex')
  const fixturePath = new URL(
    `../../harness-broker/test/fixtures/fake-codex/${codexFixture}`,
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

export async function startFacadeClient(fixture: Fixture): Promise<AspcClient> {
  return AspcClient.start({
    command: process.execPath,
    args: [FACADE_BIN, 'run', '--transport', 'stdio'],
    cwd: repoRoot,
    env: {
      ASP_CODEX_PATH: fixture.codexPath,
      ASP_CODEX_SKIP_COMMON_PATHS: '1',
    },
  })
}

export type AskClientPermissionPolicy = {
  mode: 'ask-client'
  timeoutMs: number
  defaultDecision: 'deny'
  surface: 'api'
  audit: true
}

export const ASK_CLIENT_PERMISSION_POLICY: AskClientPermissionPolicy = {
  mode: 'ask-client',
  timeoutMs: 5_000,
  defaultDecision: 'deny',
  surface: 'api',
  audit: true,
}

export function buildCompileRequest(
  fixture: Fixture,
  namespace: string,
  permissionPolicy: RuntimeCompileRequest['hrcPolicy']['permissionPolicy'] = {
    mode: 'deny',
    audit: true,
  }
): RuntimeCompileRequest {
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
      permissionPolicy,
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

export type ObservedPlane = {
  /** Methods that answered at all (result OR a non "method not found" error). */
  served: Set<string>
  notifications: JsonRpcNotification[]
  permissionRequestMethods: string[]
}

/**
 * A route is "served" when the facade answers it — either with a result or with
 * a typed error other than JSON-RPC `-32601`. Params validity is deliberately
 * not the subject here: the subject is whether the composition facade exposes
 * the route at all.
 */
export async function probeServed(
  client: AspcClient,
  method: string,
  params: unknown
): Promise<boolean> {
  try {
    await client.request(method, params)
    return true
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return code !== JSON_RPC_METHOD_NOT_FOUND
  }
}
