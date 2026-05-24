import { randomUUID } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import type { RuntimePlacement } from 'spaces-config'
import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
  InputContent,
  InputId,
  InvocationInput,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import { validateInvocationInput, validateInvocationSpec } from 'spaces-harness-broker-protocol'
import { buildCodexAppServerLaunchDescriptor } from 'spaces-harness-codex'
import type { ContextResolverContext } from 'spaces-runtime'
import { expandTemplate } from 'spaces-runtime'

import { CODEX_CLI_FRONTEND, CodedError } from './client-support.js'
import type { PreparedPlacementCliRuntime } from './prepare-cli-runtime.js'
import type {
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
} from './types.js'

interface HandleParts {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
}

const DEFAULT_BROKER_PROCESS_LIMITS: NonNullable<HarnessInvocationSpec['process']['limits']> = {
  startupTimeoutMs: 20_000,
  turnTimeoutMs: 900_000,
  stopGraceMs: 5_000,
}

export function deriveHandleParts(placement: RuntimePlacement): HandleParts {
  const parts: HandleParts = {}
  const scopeRef = placement.correlation?.sessionRef?.scopeRef
  const laneRef = placement.correlation?.sessionRef?.laneRef
  if (scopeRef) {
    try {
      const parsed = parseScopeRef(scopeRef)
      parts.agentId = parsed.agentId
      if (parsed.projectId !== undefined) {
        parts.projectId = parsed.projectId
      }
      if (parsed.taskId !== undefined) {
        parts.taskId = parsed.taskId
      }
    } catch {
      // Best-effort fallback for older callers that sent shorthand handles
      // instead of canonical ScopeRefs.
      const atIndex = scopeRef.indexOf('@')
      if (atIndex === -1) {
        parts.agentId = scopeRef
      } else {
        parts.agentId = scopeRef.slice(0, atIndex)
        const rest = scopeRef.slice(atIndex + 1)
        const colonIndex = rest.indexOf(':')
        if (colonIndex === -1) {
          parts.projectId = rest
        } else {
          parts.projectId = rest.slice(0, colonIndex)
          parts.taskId = rest.slice(colonIndex + 1)
        }
      }
    }
  }
  if (parts.agentId === undefined) {
    parts.agentId = basename(placement.agentRoot)
  }
  if (parts.projectId === undefined && placement.projectRoot) {
    parts.projectId = basename(resolve(placement.projectRoot))
  }
  if (laneRef && laneRef.length > 0 && laneRef !== 'main' && laneRef !== 'lane:main') {
    parts.lane = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  }
  return parts
}

export function buildPromptExpansionContext(placement: RuntimePlacement): ContextResolverContext {
  const handleParts = deriveHandleParts(placement)
  return {
    agentRoot: placement.agentRoot,
    agentsRoot: dirname(placement.agentRoot),
    agentId: handleParts.agentId ?? basename(placement.agentRoot),
    projectId: handleParts.projectId,
    taskId: handleParts.taskId,
    lane: handleParts.lane,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    runMode: placement.runMode,
  }
}

export function validateBrokerInvocationRequest(req: BuildHarnessBrokerInvocationRequest): void {
  if (req.provider !== 'openai') {
    throw new CodedError(
      `Harness broker invocation only supports provider "openai"; got "${req.provider}"`,
      'provider_mismatch'
    )
  }
  if (req.frontend !== CODEX_CLI_FRONTEND) {
    throw new CodedError(
      `Harness broker invocation only supports frontend "${CODEX_CLI_FRONTEND}"; got "${req.frontend}"`,
      'unsupported_frontend'
    )
  }
  if (req.interactionMode !== 'headless') {
    throw new CodedError(
      `Harness broker invocation only supports headless interaction mode; got "${req.interactionMode}"`,
      'unsupported_frontend'
    )
  }
}

function brokerCorrelationFromPlacement(placement: RuntimePlacement): Record<string, string> {
  const correlation: Record<string, string> = {
    agentRoot: placement.agentRoot,
  }
  if (placement.projectRoot !== undefined) {
    correlation['projectRoot'] = placement.projectRoot
  }
  if (placement.cwd !== undefined) {
    correlation['cwd'] = placement.cwd
  }
  if (placement.runMode !== undefined) {
    correlation['runMode'] = placement.runMode
  }

  const sessionRef = placement.correlation?.sessionRef
  if (sessionRef?.scopeRef !== undefined) {
    correlation['scopeRef'] = sessionRef.scopeRef
  }
  if (sessionRef?.laneRef !== undefined) {
    correlation['laneRef'] = sessionRef.laneRef
  }
  if (placement.correlation?.hostSessionId !== undefined) {
    correlation['hostSessionId'] = placement.correlation.hostSessionId
  }

  const handleParts = deriveHandleParts(placement)
  if (handleParts.agentId !== undefined) {
    correlation['agentId'] = handleParts.agentId
  }
  if (handleParts.projectId !== undefined) {
    correlation['projectId'] = handleParts.projectId
  }
  if (handleParts.taskId !== undefined) {
    correlation['taskId'] = handleParts.taskId
  }
  if (handleParts.lane !== undefined) {
    correlation['lane'] = handleParts.lane
  }

  return correlation
}

function combineBrokerPrompts(
  primingPrompt: string | undefined,
  callerPrompt: string | undefined
): string | undefined {
  if (primingPrompt !== undefined && callerPrompt !== undefined) {
    return `${primingPrompt}\n\n${callerPrompt}`
  }
  return primingPrompt ?? callerPrompt
}

function buildBrokerInitialText(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): string | undefined {
  if (req.prompt === '') {
    return undefined
  }

  const expansionContext = buildPromptExpansionContext(prepared.placement)
  const defaultPrompt =
    prepared.runtimePlan.defaultRunOptions.prompt ??
    prepared.placementContext.materialization.effectiveConfig?.priming_prompt
  const primingPrompt =
    defaultPrompt !== undefined ? expandTemplate(defaultPrompt, expansionContext) : undefined
  const callerPrompt =
    req.prompt !== undefined ? expandTemplate(req.prompt, expansionContext) : undefined

  return combineBrokerPrompts(primingPrompt, callerPrompt)
}

function buildInitialInput(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): InvocationInput | undefined {
  const content: InputContent[] = []
  const initialText = buildBrokerInitialText(prepared, req)
  if (initialText !== undefined && initialText.length > 0) {
    content.push({ type: 'text', text: initialText })
  }
  for (const imagePath of prepared.imageAttachmentPaths) {
    content.push({ type: 'local_image', path: imagePath })
  }
  if (content.length === 0) {
    return undefined
  }
  return {
    inputId: req.initialInputId ?? (`input_${randomUUID()}` as InputId),
    kind: 'user',
    content,
  }
}

export function toHarnessBrokerStartRequest(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): BuildHarnessBrokerInvocationResponse {
  const codexDescriptor = buildCodexAppServerLaunchDescriptor(prepared.runOptions)
  const driver: CodexAppServerDriverSpec = {
    kind: 'codex-app-server',
    ...(req.continuation?.key !== undefined ? { resumeThreadId: req.continuation.key } : {}),
    ...(codexDescriptor.model !== undefined ? { model: codexDescriptor.model } : {}),
    ...(codexDescriptor.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: codexDescriptor.modelReasoningEffort }
      : {}),
    approvalPolicy: codexDescriptor.approvalPolicy ?? 'never',
    ...(codexDescriptor.sandboxMode !== undefined
      ? { sandboxMode: codexDescriptor.sandboxMode }
      : {}),
    ...(codexDescriptor.profile !== undefined ? { profile: codexDescriptor.profile } : {}),
    permissionPolicy: req.permissionPolicy ?? { mode: 'deny' },
    resumeFallback: req.resumeFallback ?? 'start-fresh',
  }

  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.invocationId !== undefined ? { invocationId: req.invocationId } : {}),
    ...(req.labels !== undefined ? { labels: req.labels } : {}),
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: prepared.commandPath,
      args: prepared.args,
      cwd: prepared.cwd,
      env: prepared.env,
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: req.limits ?? DEFAULT_BROKER_PROCESS_LIMITS,
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: req.interaction?.inputQueue ?? 'none',
    },
    ...(req.continuation?.key !== undefined
      ? { continuation: { provider: 'codex', kind: 'thread', key: req.continuation.key } }
      : {}),
    driver,
    correlation: req.correlation ?? brokerCorrelationFromPlacement(req.placement),
  }
  const initialInput = buildInitialInput(prepared, req)
  const startRequest: InvocationStartRequest =
    initialInput === undefined ? { spec } : { spec, initialInput }

  validateInvocationSpec(startRequest.spec)
  if (startRequest.initialInput !== undefined) {
    validateInvocationInput(startRequest.initialInput)
  }

  return {
    startRequest,
    spec,
    ...(initialInput !== undefined ? { initialInput } : {}),
    resolvedBundle: prepared.resolvedBundle,
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
  }
}
