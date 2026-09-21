import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'
import type {
  HarnessId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

export type V2CompileFixture = {
  base: string
  agentId: string
  agentRoot: string
  projectRoot: string
  aspHome: string
  cleanup: () => void
}

export type V2CompileOptions = {
  namespace: string
  harness: HarnessId
  modelProvider: string
  model: string
  presentation?: boolean | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  prompt?: string | undefined
  continuation?: RuntimeCompileRequest['continuation'] | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  attachments?: RuntimeCompileRequest['materialization']['attachments'] | undefined
  omitPriming?: boolean | undefined
  responseFormat?: RuntimeCompileRequest['materialization']['responseFormat'] | undefined
  taskContext?: RuntimeCompileRequest['materialization']['taskContext'] | undefined
  permissionPolicy?: RuntimeCompileRequest['hrcPolicy']['permissionPolicy'] | undefined
  inputPolicy?: RuntimeCompileRequest['hrcPolicy']['inputPolicy'] | undefined
  exposurePolicy?: RuntimeCompileRequest['hrcPolicy']['exposurePolicy'] | undefined
  resourceLimits?: RuntimeCompileRequest['hrcPolicy']['resourceLimits'] | undefined
  capabilityPolicy?: RuntimeCompileRequest['hrcPolicy']['capabilityPolicy'] | undefined
  disallowedTools?: string[] | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runMode?: 'query' | 'heartbeat' | 'task' | 'maintenance' | undefined
}

function identity(namespace: string): RuntimeCompileRequest['identity'] {
  const suffix = namespace.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
  return {
    requestId: `request_${suffix}`,
    operationId: `operation_${suffix}`,
    hostSessionId: `host_${suffix}`,
    generation: 1,
    runtimeId: `runtime_${suffix}`,
    invocationId: `inv_${suffix}`,
    initialInputId: `input_${suffix}`,
    runId: `run_${suffix}`,
    traceId: `trace_${suffix}`,
    idempotencyKey: suffix,
  } as RuntimeCompileRequest['identity']
}

function writeShim(path: string, body: string): void {
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
}

export function createV2CompileFixture(agentId = 'cody'): V2CompileFixture {
  const base = mkdtempSync(join(tmpdir(), 'asp-v2-compile-'))
  const agentRoot = join(base, 'agents', agentId)
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'version = 4\n\n[spaces]\nbase = []\n',
    'utf8'
  )
  writeShim(
    join(aspHome, 'codex'),
    '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "codex 999.0.0"; exit 0; fi\nif [[ "$1" == "app-server" && "$2" == "--help" ]]; then echo "app-server"; exit 0; fi\necho "codex shim"\n'
  )
  writeShim(
    join(aspHome, 'claude'),
    '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "claude 1.0.0"; exit 0; fi\necho "claude shim"\n'
  )
  writeShim(
    join(aspHome, 'muse'),
    '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "Muse Code 1.3.0"; exit 0; fi\necho "muse shim"\n'
  )
  return {
    base,
    agentId,
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

export function buildV2CompileRequest(
  fixture: V2CompileFixture,
  options: V2CompileOptions
): RuntimeCompileRequest {
  const allocated = identity(options.namespace)
  const scopeRef = options.scopeRef ?? `agent:${fixture.agentId}:project:agent-spaces`
  const laneRef = options.laneRef ?? 'main'
  const placement = {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: options.runMode ?? 'task',
    bundle: { kind: 'agent-project', agentName: fixture.agentId, projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: { scopeRef, laneRef },
      hostSessionId: allocated.hostSessionId,
    },
    ...(options.lockedEnv === undefined ? {} : { lockedEnv: options.lockedEnv }),
    ...(options.dispatchEnv === undefined ? {} : { dispatchEnv: options.dispatchEnv }),
  } as RuntimeCompileRequest['placement']
  return {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: fixture.agentId },
    identity: allocated,
    placement,
    requested: {
      harness: options.harness,
      modelProvider: options.modelProvider,
      model: options.model,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
      ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
    },
    materialization: {
      ...(options.prompt === undefined ? {} : { initialPrompt: options.prompt }),
      ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      ...(options.omitPriming === undefined ? {} : { omitPriming: options.omitPriming }),
      ...(options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat }),
      taskContext: options.taskContext ?? {
        taskId: 'T-08704',
        phase: 'v2-integration',
        role: 'test',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'v2 compile integration fixture',
      },
    },
    hrcPolicy: {
      permissionPolicy: options.permissionPolicy ?? { mode: 'deny', audit: true },
      inputPolicy: options.inputPolicy ?? DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: options.exposurePolicy ?? { mode: 'none' },
      resourceLimits: options.resourceLimits ?? { startupTimeoutMs: 10_000, turnTimeoutMs: 10_000 },
      observability: { traceId: allocated.traceId },
      capabilityPolicy: options.capabilityPolicy ?? {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
      ...(options.disallowedTools === undefined
        ? {}
        : { disallowedTools: options.disallowedTools }),
    },
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
    correlation: {
      requestId: allocated.requestId,
      operationId: allocated.operationId,
      hostSessionId: allocated.hostSessionId,
      generation: allocated.generation,
      runtimeId: allocated.runtimeId,
      runId: allocated.runId,
      invocationId: allocated.invocationId,
      traceId: allocated.traceId,
      appId: 'agent-spaces-integration-tests',
      appSessionKey: options.namespace,
      scopeRef,
      laneRef,
    },
  }
}

export async function compileV2(
  fixture: V2CompileFixture,
  options: V2CompileOptions
): Promise<RuntimeCompileResponse> {
  return compileV2Request(fixture, buildV2CompileRequest(fixture, options))
}

export async function compileV2Request(
  fixture: V2CompileFixture,
  request: RuntimeCompileRequest
): Promise<RuntimeCompileResponse> {
  const originalCodexPath = process.env['ASP_CODEX_PATH']
  const originalClaudePath = process.env['ASP_CLAUDE_PATH']
  const originalMusePath = process.env['ASP_MUSE_PATH']
  const originalSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
  process.env['ASP_CLAUDE_PATH'] = join(fixture.aspHome, 'claude')
  process.env['ASP_MUSE_PATH'] = join(fixture.aspHome, 'muse')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  try {
    const { compilerRuntime } = await import('./compiler-runtime.js')
    const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
    const client = createAgentSpacesClient({ aspHome: fixture.aspHome, runtime: compilerRuntime })
    return await client.compileRuntimePlan(request)
  } finally {
    if (originalCodexPath === undefined) process.env['ASP_CODEX_PATH'] = undefined
    else process.env['ASP_CODEX_PATH'] = originalCodexPath
    if (originalClaudePath === undefined) process.env['ASP_CLAUDE_PATH'] = undefined
    else process.env['ASP_CLAUDE_PATH'] = originalClaudePath
    if (originalMusePath === undefined) process.env['ASP_MUSE_PATH'] = undefined
    else process.env['ASP_MUSE_PATH'] = originalMusePath
    if (originalSkipCommonPaths === undefined)
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    else process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommonPaths
  }
}
