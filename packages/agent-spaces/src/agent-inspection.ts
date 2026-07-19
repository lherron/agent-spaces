import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildRuntimeBundleRef, parseAgentProfile } from 'spaces-config'
import {
  type ResolvedContextSection,
  inspectAgentSystemPrompt,
  normalizeAgentInspectionEvaluationContext,
} from 'spaces-runtime'
import {
  type AgentInspectionDiagnostic,
  type AgentInspectionEvaluationContext,
  type AgentInspectionFreshness,
  type AgentInspectionIdentity,
  type AgentInspectionJsonValue,
  type AgentInspectionPart,
  type AgentInspectionProvenance,
  type AgentInspectionRequest,
  type AgentInspectionResult,
  type CompileDiagnostic,
  type RuntimeCompileRequest,
  type RuntimeCompileResponse,
  validateAgentInspectionRequest,
  validateAgentInspectionResult,
} from 'spaces-runtime-contracts'

import { compileRuntimePlan } from './compile-runtime-plan.js'

export type AgentCatalogDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export type AgentCatalogRow = {
  agentId: string
  displayName: string
  role: string | null
  sourceAvailability: {
    profile: boolean
    soul: boolean
    contextTemplate: boolean
  }
  defaultContextSummary: {
    projectId: string
    mode: string
    lane: string
    harness: string
    frontend: string
    interaction: string
  }
  diagnostics: AgentCatalogDiagnostic[]
  warningCount: number
  errorCount: number
}

export type AgentCatalogResult = { agents: AgentCatalogRow[] }

export type AgentInspectionOperationOutcome =
  | { ok: true; inspection: AgentInspectionResult }
  | { ok: false; diagnostics: AgentCatalogDiagnostic[] }

type CompileRuntimePlan = (
  request: RuntimeCompileRequest,
  options?: { compileContext?: AgentInspectionEvaluationContext['compileContext'] | undefined }
) => Promise<RuntimeCompileResponse>

export type InspectAgentForContextOptions = {
  compileRuntimePlan?: CompileRuntimePlan | undefined
}

const RUNTIME_PLAN_PROVENANCE: AgentInspectionProvenance = {
  contributions: [
    {
      kind: 'runtime-plan',
      sourceId: 'canonical-compile',
      sourceRef: 'agent-runtime-plan/v1',
    },
  ],
}

/**
 * Enumerate every source directory under the explicit agents root. Cataloging
 * parses profiles for metadata and diagnostics but deliberately performs no
 * runtime compile; contextual inspection owns that cost.
 */
export async function catalogAgentsForContext(input: {
  evaluationContext: unknown
}): Promise<AgentCatalogResult> {
  const { evaluationContext } = normalizeAgentInspectionEvaluationContext(input.evaluationContext)
  const entries = listAgentDirectories(evaluationContext.paths.agentsRoot)
  return {
    agents: entries.map((agentId) => catalogRow(agentId, evaluationContext)),
  }
}

/**
 * Produce one consumer-independent inspection from one prompt-resolution report
 * and exactly one canonical runtime compile.
 */
export async function inspectAgentForContext(
  input: { request: unknown; evaluationContext: unknown },
  options: InspectAgentForContextOptions = {}
): Promise<AgentInspectionOperationOutcome> {
  const request = validateAgentInspectionRequest(input.request)
  const normalized = normalizeAgentInspectionEvaluationContext(input.evaluationContext)
  assertMatchingIdentity(request, normalized.evaluationContext)

  const resolutionDiagnostics: AgentInspectionDiagnostic[] = []
  let promptSections: ResolvedContextSection[] = []
  let initialPrompt = ''
  try {
    const inspected = await inspectAgentSystemPrompt({
      agentRoot: normalized.evaluationContext.paths.agentRoot,
      agentsRoot: normalized.evaluationContext.paths.agentsRoot,
      aspHome: dirname(normalized.evaluationContext.paths.agentsRoot),
      projectRoot: normalized.evaluationContext.paths.projectRoot,
      projectId: request.identifiers.projectId,
      agentId: request.identifiers.agentId,
      taskId: request.identifiers.taskId,
      lane: request.identifiers.lane,
      runMode: asRunMode(request.identifiers.mode),
      scaffoldPackets: normalized.evaluationContext.scaffoldPackets,
      env: normalized.evaluationContext.environment,
      agentRootSearchPath: [
        normalized.evaluationContext.paths.agentRoot,
        normalized.evaluationContext.paths.agentsRoot,
      ],
      resolverContext: normalized.resolverContext,
    })
    if (inspected !== undefined) {
      promptSections = [...inspected.prompt.sections, ...inspected.reminder.sections]
      initialPrompt = inspected.prompt.content
    }
  } catch (error) {
    resolutionDiagnostics.push({
      kind: 'resolution',
      severity: 'error',
      code: 'prompt_resolution_failed',
      message: formatError(error),
      partId: 'prompt:template:resolution',
    })
  }

  const compiler = options.compileRuntimePlan ?? compileRuntimePlan
  let response: RuntimeCompileResponse
  try {
    response = await compiler(
      buildInspectionCompileRequest(request, normalized.evaluationContext, initialPrompt),
      {
        compileContext: normalized.compileContext,
      }
    )
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        ...operationDiagnostics(resolutionDiagnostics),
        { severity: 'error', code: 'compiler_exception', message: formatError(error) },
      ],
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      diagnostics: [
        ...operationDiagnostics(resolutionDiagnostics),
        ...response.diagnostics.map(operationCompileDiagnostic),
      ],
    }
  }

  const promptParts = promptSections.map(promptPart)
  if (resolutionDiagnostics.length > 0 && promptParts.length === 0) {
    promptParts.push({
      kind: 'prompt',
      partId: 'prompt:template:resolution',
      disposition: {
        kind: 'failed',
        source: { kind: 'compiler', stage: 'context-resolution' },
        reason: resolutionDiagnostics[0]?.message ?? 'Prompt resolution failed',
      },
      provenance: { contributions: [] },
      value: { zone: 'prompt', name: 'template:resolution', sourceType: 'inline', order: 0 },
    })
  }

  const parts = [...promptParts, ...runtimePlanParts(response.plan)]
  const failedPartIds = parts
    .filter((part) => part.disposition.kind === 'failed')
    .map((part) => part.partId)
  const diagnostics = [
    ...response.diagnostics.map(inspectionCompileDiagnostic),
    ...resolutionDiagnostics,
    ...parts.flatMap(failedResolutionDiagnostic),
  ]
  const inspection: AgentInspectionResult = {
    schemaVersion: 'agent-inspection/v1',
    identity: request.identifiers,
    parts,
    completeness:
      failedPartIds.length > 0
        ? { kind: 'partial', missingPartIds: failedPartIds }
        : { kind: 'complete' },
    freshness: inspectionFreshness(response.plan, request, normalized.evaluationContext),
    diagnostics: deduplicateDiagnostics(diagnostics),
  }
  return { ok: true, inspection: validateAgentInspectionResult(inspection) }
}

function catalogRow(agentId: string, context: AgentInspectionEvaluationContext): AgentCatalogRow {
  const root = join(context.paths.agentsRoot, agentId)
  const profilePath = join(root, 'agent-profile.toml')
  const diagnostics: AgentCatalogDiagnostic[] = []
  let displayName = agentId
  let role: string | null = null
  if (!existsSync(profilePath)) {
    diagnostics.push({
      severity: 'error',
      code: 'missing_agent_profile',
      message: `agent-profile.toml is missing for ${agentId}`,
    })
  } else {
    try {
      const profile = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
      displayName = profile.identity?.display ?? agentId
      role = profile.identity?.role ?? null
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid_agent_profile',
        message: formatError(error),
      })
    }
  }
  return {
    agentId,
    displayName,
    role,
    sourceAvailability: {
      profile: existsSync(profilePath),
      soul: existsSync(join(root, 'SOUL.md')),
      contextTemplate: existsSync(join(root, 'context-template.toml')),
    },
    defaultContextSummary: {
      projectId: context.identifiers.projectId,
      mode: context.identifiers.mode,
      lane: context.identifiers.lane,
      harness: context.identifiers.harness,
      frontend: context.identifiers.frontend,
      interaction: context.identifiers.interaction,
    },
    diagnostics,
    warningCount: diagnostics.filter(({ severity }) => severity === 'warning').length,
    errorCount: diagnostics.filter(({ severity }) => severity === 'error').length,
  }
}

function listAgentDirectories(agentsRoot: string): string[] {
  try {
    return readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(
        (agentId) =>
          existsSync(join(agentsRoot, agentId, 'agent-profile.toml')) ||
          existsSync(join(agentsRoot, agentId, 'SOUL.md'))
      )
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

function assertMatchingIdentity(
  request: AgentInspectionRequest,
  context: AgentInspectionEvaluationContext
): void {
  const issues = Object.entries(request.identifiers)
    .filter(([key, value]) => context.identifiers[key as keyof AgentInspectionIdentity] !== value)
    .map(([key]) => ({
      path: `identifiers.${key}`,
      code: 'identity_mismatch',
      message: `request identifiers.${key} must match evaluationContext identifiers.${key}`,
    }))
  if (issues.length === 0) return
  const error = new Error(
    'Inspection request and evaluation context identities do not match'
  ) as Error & {
    issues: typeof issues
  }
  error.issues = issues
  throw error
}

function buildInspectionCompileRequest(
  request: AgentInspectionRequest,
  context: AgentInspectionEvaluationContext,
  initialPrompt: string
): RuntimeCompileRequest {
  const seed = stableHash({ request, context })
  const identity = {
    requestId: `request_${seed}`,
    operationId: `runtimeOperation_${seed}`,
    hostSessionId: `hostSession_${seed}`,
    generation: 1,
    runtimeId: `runtime_${seed}`,
    invocationId: `inv_${seed}`,
    initialInputId: `input_${seed}`,
    runId: `run_${seed}`,
    traceId: `trace_${seed}`,
    idempotencyKey: `agent-inspection:${seed}`,
  } as RuntimeCompileRequest['identity']
  const harness = requestedHarness(request.identifiers.harness)
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement: {
      kind: 'agent-inspection',
      root: context.paths.projectRoot,
      targetDir: context.paths.cwd,
      agentRoot: context.paths.agentRoot,
      bundle: buildRuntimeBundleRef({
        agentName: request.identifiers.agentId,
        agentRoot: context.paths.agentRoot,
        projectRoot: context.paths.projectRoot,
      }),
      correlation: {
        sessionRef: {
          scopeRef: request.identifiers.scope,
          laneRef: request.identifiers.lane,
        },
        hostSessionId: identity.hostSessionId,
      },
    },
    requested: {
      modelProvider: harness.provider,
      model: request.declaredOverrides.modelId,
      reasoningEffort: request.declaredOverrides.reasoningEffort,
      harnessFamily: harness.family,
      preferredHarnessRuntime: harness.runtime,
      interactionMode: asInteractionMode(request.identifiers.interaction),
    },
    materialization: {
      initialPrompt,
      ...(request.identifiers.taskId !== undefined
        ? {
            taskContext: {
              taskId: request.identifiers.taskId,
              phase: null,
              role: 'agent-inspection',
              requiredEvidenceKinds: [],
              hintsText: '',
            },
          }
        : {}),
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      exposurePolicy: { mode: 'none' },
      observability: { traceId: identity.traceId },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      invocationId: identity.invocationId,
      runId: identity.runId,
      traceId: identity.traceId,
      appId: 'agent-spaces-inspection',
      appSessionKey: request.identifiers.scope,
      scopeRef: request.identifiers.scope,
      laneRef: request.identifiers.lane,
    },
  }
}

function promptPart(section: ResolvedContextSection): AgentInspectionPart {
  return {
    kind: 'prompt',
    partId: promptPartId(section),
    disposition: section.disposition,
    provenance: section.provenance,
    value: {
      zone: section.zone,
      name: section.name,
      sourceType: section.type,
      order: section.order,
      ...(section.included && section.content !== undefined ? { content: section.content } : {}),
    },
  }
}

function promptPartId(section: ResolvedContextSection): string {
  return `prompt:${section.zone}:${section.name}`
}

function runtimePlanParts(
  plan: Extract<RuntimeCompileResponse, { ok: true }>['plan']
): AgentInspectionPart[] {
  const parts: AgentInspectionPart[] = [
    {
      kind: 'capability',
      partId: 'capability:runtime-plan',
      disposition: { kind: 'effective' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: { capabilityId: 'runtime-plan', enabled: true },
    },
    {
      kind: 'runtime-setting',
      partId: 'runtime-setting:locked-env-keys',
      disposition: { kind: 'effective' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: { settingId: 'locked-env-keys', value: plan.lockedEnv.lockedEnvKeys },
    },
    {
      kind: 'harness',
      partId: 'harness:selected',
      disposition: { kind: 'effective' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: plan.harness,
    },
    {
      kind: 'model',
      partId: 'model:selected',
      disposition: { kind: 'effective' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: {
        provider: plan.model.provider,
        modelId: plan.model.modelId,
        ...(plan.model.reasoningEffort !== undefined
          ? { reasoningEffort: plan.model.reasoningEffort }
          : {}),
      },
    },
    {
      kind: 'artifact',
      partId: 'artifact:bundle',
      disposition: { kind: 'effective' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: {
        artifactKind: 'bundle',
        bundleIdentity: plan.artifacts.bundleIdentity,
        ...(plan.artifacts.lockHash !== undefined ? { identity: plan.artifacts.lockHash } : {}),
      },
    },
  ]
  for (const profile of plan.executionProfiles) {
    parts.push({
      kind: 'execution-profile',
      partId: `execution-profile:${profile.profileId}`,
      disposition: { kind: 'effective' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: {
        profileId: profile.profileId,
        controllerKind: profile.kind,
      },
    })
  }
  if (plan.executionProfiles.length === 0) {
    parts.push({
      kind: 'execution-profile',
      partId: 'execution-profile:none',
      disposition: { kind: 'skipped', reason: 'empty' },
      provenance: RUNTIME_PLAN_PROVENANCE,
      value: { profileId: 'none', controllerKind: 'none' },
    })
  }
  return parts
}

function inspectionFreshness(
  plan: Extract<RuntimeCompileResponse, { ok: true }>['plan'],
  request: AgentInspectionRequest,
  context: AgentInspectionEvaluationContext
): AgentInspectionFreshness {
  const expectedLockHash = plan.resolvedBundle.lockHash
  const actualLockHash = plan.artifacts.lockHash
  if (
    expectedLockHash !== undefined &&
    actualLockHash !== undefined &&
    expectedLockHash !== actualLockHash
  ) {
    return {
      kind: 'stale',
      evaluatedAt: context.nowIso,
      reason: 'Compiled artifact lock hash differs from the resolved bundle lock hash',
      expectedLockHash,
      actualLockHash,
    }
  }
  const lockHash = actualLockHash ?? expectedLockHash
  if (lockHash === undefined) {
    return { kind: 'unknown', reason: 'The canonical compile produced no lock hash' }
  }
  return {
    kind: 'fresh',
    evaluatedAt: context.nowIso,
    compileId: plan.compileId,
    planHash: plan.planHash,
    lockHash,
    bundleIdentity: plan.artifacts.bundleIdentity,
    contextHash: stableHash({ request, context }),
  }
}

function inspectionCompileDiagnostic(diagnostic: CompileDiagnostic): AgentInspectionDiagnostic {
  return {
    kind: 'compile',
    severity: diagnostic.level,
    code: diagnostic.code,
    message: diagnostic.message,
  }
}

function operationCompileDiagnostic(diagnostic: CompileDiagnostic): AgentCatalogDiagnostic {
  return { severity: diagnostic.level, code: diagnostic.code, message: diagnostic.message }
}

function operationDiagnostics(diagnostics: AgentInspectionDiagnostic[]): AgentCatalogDiagnostic[] {
  return diagnostics.map(({ severity, code, message }) => ({ severity, code, message }))
}

function failedResolutionDiagnostic(part: AgentInspectionPart): AgentInspectionDiagnostic[] {
  if (part.disposition.kind !== 'failed') return []
  return [
    {
      kind: 'resolution',
      severity: 'error',
      code: 'part_resolution_failed',
      message: part.disposition.reason,
      partId: part.partId,
    },
  ]
}

function deduplicateDiagnostics(
  diagnostics: AgentInspectionDiagnostic[]
): AgentInspectionDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.kind}:${diagnostic.code}:${diagnostic.message}:${'partId' in diagnostic ? (diagnostic.partId ?? '') : ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stableHash(value: AgentInspectionJsonValue | object): string {
  return createHash('sha256')
    .update(JSON.stringify(sortJson(value)))
    .digest('hex')
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  )
}

function asRunMode(value: string): 'query' | 'heartbeat' | 'task' | 'maintenance' {
  if (value === 'heartbeat' || value === 'task' || value === 'maintenance') return value
  return 'query'
}

function asInteractionMode(value: string): 'interactive' | 'nonInteractive' | 'headless' {
  if (value === 'interactive' || value === 'nonInteractive') return value
  return 'headless'
}

function requestedHarness(value: string): {
  family: RuntimeCompileRequest['requested']['harnessFamily']
  runtime: RuntimeCompileRequest['requested']['preferredHarnessRuntime']
  provider: RuntimeCompileRequest['requested']['modelProvider']
} {
  if (value.includes('claude')) {
    return { family: 'claude-code', runtime: 'claude-code-cli', provider: 'anthropic' }
  }
  if (value.includes('pi')) {
    return { family: 'pi', runtime: 'pi-cli', provider: 'openai' }
  }
  return { family: 'codex', runtime: 'codex-cli', provider: 'openai' }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
