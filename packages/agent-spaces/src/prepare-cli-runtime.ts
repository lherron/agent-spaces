import { basename, extname, resolve } from 'node:path'

import type { HarnessDetection, HarnessRunOptions, ResolvedPlacementContext } from 'spaces-config'
import { type RuntimePlacement, getAspHome, resolvePlacementContext } from 'spaces-config'
import type { PlacementRuntimePlan } from 'spaces-execution'
import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentBrainRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'
import { buildCodexAppServerLaunchDescriptor } from 'spaces-harness-codex'
import type { AttachmentRef } from 'spaces-runtime'
import type { MaterializeResult } from 'spaces-runtime'
import { expandTemplate, materializeSystemPrompt } from 'spaces-runtime'

import { buildPromptExpansionContext, deriveHandleParts } from './broker-invocation.js'
import { type MaterializedSpec, materializeSpec } from './client-materialization.js'
import {
  CODEX_CLI_FRONTEND,
  CodedError,
  formatDisplayCommand,
  resolveFrontend,
  validateProviderMatch,
} from './client-support.js'
import { buildCorrelationEnvVars } from './placement-api.js'
import type {
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  HarnessContinuationRef,
  HarnessFrontend,
  InteractionMode,
  ProcessInvocationSpec,
} from './types.js'

export interface PreparedPlacementCliRuntime {
  placement: RuntimePlacement
  placementContext: ResolvedPlacementContext
  resolvedBundle: BuildProcessInvocationSpecResponse['resolvedBundle']
  runtimePlan: PlacementRuntimePlan
  materialized: MaterializedSpec
  systemPrompt?: MaterializeResult | undefined
  expandedPrompt?: string | undefined
  imageAttachmentPaths: string[]
  runOptions: HarnessRunOptions
  detection: HarnessDetection
  commandPath: string
  args: string[]
  argv: string[]
  lockedEnv: Record<string, string>
  dispatchEnv: Record<string, string>
  env: Record<string, string>
  /** Ordered dirs to prepend to the launched process PATH (typed PATH mutation, NOT lockedEnv). */
  pathPrepend: string[]
  cwd: string
  displayCommand: string
  continuation?: HarnessContinuationRef | undefined
  codexAppServer?: ProcessInvocationSpec['codexAppServer'] | undefined
  warnings: string[]
}

interface PreparePlacementCliRuntimeRequest {
  aspHome?: string | undefined
  provider: HarnessContinuationRef['provider']
  frontend: HarnessFrontend
  interactionMode: InteractionMode
  model?: string | undefined
  yolo?: boolean | undefined
  continuation?: HarnessContinuationRef | undefined
  prompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** @deprecated Use lockedEnv or dispatchEnv explicitly. Legacy env is treated as lockedEnv. */
  env?: Record<string, string> | undefined
  placement?: RuntimePlacement | undefined
}

function extractImageAttachmentPaths(attachments: AttachmentRef[] | undefined): string[] {
  if (!attachments) return []
  const paths: string[] = []
  for (const attachment of attachments) {
    if (attachment.kind !== 'file' || !attachment.path) continue
    if (!isImageAttachment(attachment)) continue
    paths.push(attachment.path)
  }
  return paths
}

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.avif',
])

function isImageAttachment(attachment: AttachmentRef): boolean {
  if (attachment.contentType?.toLowerCase().startsWith('image/') === true) return true
  const ref = attachment.path ?? attachment.url
  if (!ref) return false
  const clean = ref.split('?')[0]?.split('#')[0] ?? ref
  return IMAGE_ATTACHMENT_EXTENSIONS.has(extname(clean).toLowerCase())
}

/**
 * Prepare placement-based CLI runtime state without choosing an output protocol.
 */
export async function preparePlacementCliRuntime(
  req: PreparePlacementCliRuntimeRequest,
  defaultAspHome?: string
): Promise<PreparedPlacementCliRuntime> {
  const placement = req.placement as RuntimePlacement
  const warnings: string[] = []

  const frontendDef = resolveFrontend(req.frontend)

  // Validate provider matches frontend
  if (req.provider !== frontendDef.provider) {
    throw new CodedError(
      `Provider mismatch: frontend "${req.frontend}" requires provider "${frontendDef.provider}" but got "${req.provider}"`,
      'provider_mismatch'
    )
  }

  // Validate provider match with continuation if provided
  validateProviderMatch(frontendDef, req.continuation)

  const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
  const { spec } = placementContext.materialization

  // Resolve placement to get audit metadata and materialization inputs
  const resolvedBundle = placementContext.resolvedBundle

  // Resolve effective cwd from placement
  const cwd = resolvedBundle.cwd

  const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
  const runtimePlan = await planPlacementRuntime({
    placement,
    placementContext,
    frontend: req.frontend,
    aspHome,
    model: req.model,
    prompt: req.prompt,
    yolo: req.yolo,
    interactive: req.interactionMode === 'interactive',
    continuationKey: req.continuation?.key,
  })
  if (!runtimePlan.model.ok) {
    throw new Error(
      `Model not supported for frontend ${req.frontend}: ${runtimePlan.model.modelId}`
    )
  }

  // Get adapter from registry and detect binary
  const adapter = harnessRegistry.getOrThrow(runtimePlan.harnessId)
  const detection = await adapter.detect()
  if (!detection.available) {
    throw new Error(
      `Harness "${runtimePlan.harnessId}" is not available: ${detection.error ?? 'not found'}`
    )
  }

  // Detect agent-local skills/ and commands/ for materialization
  const agentLocalComponents = await detectAgentLocalComponents(placement.agentRoot)

  // Derive handle parts from the placement correlation, when present, so that
  // priming prompts and system prompt sections can reference {{agentId}},
  // {{projectId}}, {{taskId}}, {{handle}}, etc.
  const handleParts = deriveHandleParts(placement)

  // Unified materialization: use the shared placement context, then materialize the resolved spec.
  const materialized = await materializeSpec(spec, aspHome, runtimePlan.harnessId, {
    agentRoot: placement.agentRoot,
    projectRoot: placement.projectRoot,
    agentLocalComponents,
  })
  const systemPrompt = await materializeSystemPrompt(materialized.materialization.outputPath, {
    ...placement,
    ...(handleParts.agentId !== undefined ? { agentId: handleParts.agentId } : {}),
    ...(handleParts.projectId !== undefined ? { projectId: handleParts.projectId } : {}),
    ...(handleParts.taskId !== undefined ? { taskId: handleParts.taskId } : {}),
    ...(handleParts.lane !== undefined ? { lane: handleParts.lane } : {}),
  })

  const bundle = await adapter.loadTargetBundle(
    materialized.materialization.outputPath,
    materialized.targetName
  )

  const imageAttachmentPaths = extractImageAttachmentPaths(req.attachments)

  const expandedPrompt =
    runtimePlan.prompt !== undefined
      ? expandTemplate(runtimePlan.prompt, buildPromptExpansionContext(placement))
      : undefined

  // Build run options for the adapter
  let runOptions: HarnessRunOptions = {
    ...runtimePlan.runOptions,
    model: runtimePlan.model.info.model,
    ...(expandedPrompt !== undefined ? { prompt: expandedPrompt } : {}),
    ...(runtimePlan.yolo !== undefined ? { yolo: runtimePlan.yolo } : {}),
    ...(imageAttachmentPaths.length > 0 ? { imageAttachments: imageAttachmentPaths } : {}),
    ...(systemPrompt
      ? {
          systemPrompt: systemPrompt.content,
          systemPromptMode: systemPrompt.mode,
        }
      : {}),
  }

  // For codex frontends, prepare the stable runtime home directory so that
  // hrc run uses the same CODEX_HOME as asp run (codex-homes/<project>_<target>).
  // prepareCodexRuntimeHome syncs managed files, injects system prompt into
  // AGENTS.md, ensures project trust, and symlinks auth — all the steps that
  // were previously duplicated inline here.
  if (frontendDef.frontend === CODEX_CLI_FRONTEND) {
    const codexHomeDir = await prepareCodexRuntimeHome(bundle, {
      ...runOptions,
      aspHome,
    })
    runOptions = { ...runOptions, codexHomeDir }
  }

  // Build argv and env using the adapter
  const args = adapter.buildRunArgs(bundle, runOptions)
  const adapterEnv = adapter.getRunEnv(bundle, runOptions)
  const commandPath = detection.path ?? runtimePlan.harnessId
  const argv = [commandPath, ...args]

  // Build correlation env vars
  const correlationEnv = buildCorrelationEnvVars(placement)

  // Derive ASP_PROJECT and AGENTCHAT_ID so tools like agentchat can discover
  // their project and agent context without a manual .env.local.
  const agentchatEnv: Record<string, string> = {
    AGENTCHAT_ID: basename(placement.agentRoot),
  }
  if (placement.projectRoot) {
    agentchatEnv['ASP_PROJECT'] = basename(resolve(placement.projectRoot))
  }

  let lockedEnv: Record<string, string> = {
    ...adapterEnv,
    ...agentchatEnv,
    ...(req.env ?? {}),
    ...(req.lockedEnv ?? {}),
    ASP_HOME: aspHome,
  }
  const dispatchEnv: Record<string, string> = {
    ...correlationEnv,
    ...(req.dispatchEnv ?? {}),
  }
  let env: Record<string, string> = {
    ...lockedEnv,
    ...dispatchEnv,
  }

  const brainEnv = await prepareAgentBrainRuntime(
    {
      agentRoot: placement.agentRoot,
      agentName: basename(placement.agentRoot),
      ...(agentLocalComponents ? { components: agentLocalComponents } : {}),
    },
    env
  )
  lockedEnv = { ...lockedEnv, ...brainEnv }
  env = { ...env, ...brainEnv }

  let pathPrepend: string[] = []
  if (agentLocalComponents?.hasTools) {
    const toolRuntime = await prepareAgentToolRuntime(
      {
        agentRoot: placement.agentRoot,
        projectRoot: placement.projectRoot,
        components: agentLocalComponents,
      },
      env
    )
    const { PATH: toolPath, ...toolLockedEnv } = toolRuntime.env
    void toolPath
    // PATH is never routed through lockedEnv. The tool-bin dirs are emitted as
    // the typed HarnessProcessSpec.pathPrepend field (consumed by the broker
    // env compose) so the controlled PATH mutation is part of the launch shape.
    pathPrepend = toolRuntime.pathPrepend
    lockedEnv = { ...lockedEnv, ...toolLockedEnv }
    env = { ...env, ...toolRuntime.env }
    warnings.push(...toolRuntime.warnings)
  }

  // Build display command
  const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)

  // Build continuation ref
  const continuation: HarnessContinuationRef | undefined = req.continuation
    ? { provider: runtimePlan.provider, key: req.continuation.key }
    : undefined

  const codexAppServer =
    req.frontend === 'codex-cli' && req.interactionMode === 'headless'
      ? buildCodexAppServerLaunchDescriptor(runOptions)
      : undefined

  return {
    placement,
    placementContext,
    resolvedBundle,
    runtimePlan,
    materialized,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(expandedPrompt !== undefined ? { expandedPrompt } : {}),
    imageAttachmentPaths,
    runOptions,
    detection,
    commandPath,
    args,
    argv,
    cwd,
    lockedEnv,
    dispatchEnv,
    env,
    pathPrepend,
    ...(continuation ? { continuation } : {}),
    displayCommand,
    ...(codexAppServer ? { codexAppServer } : {}),
    warnings,
  }
}

export function toProcessInvocationSpec(
  prepared: PreparedPlacementCliRuntime,
  req: BuildProcessInvocationSpecRequest
): BuildProcessInvocationSpecResponse {
  const invocationSpec: ProcessInvocationSpec = {
    provider: prepared.runtimePlan.provider,
    frontend: req.frontend,
    argv: prepared.argv,
    cwd: prepared.cwd,
    env: prepared.env,
    interactionMode: req.interactionMode,
    ioMode: req.ioMode,
    ...(prepared.continuation ? { continuation: prepared.continuation } : {}),
    displayCommand: prepared.displayCommand,
    ...(prepared.systemPrompt
      ? {
          systemPromptFile: prepared.systemPrompt.path,
          prompts: {
            system: {
              content: prepared.systemPrompt.content,
              mode: prepared.systemPrompt.mode,
              sourcePath: prepared.systemPrompt.path,
            },
          },
        }
      : {}),
    ...(prepared.codexAppServer ? { codexAppServer: prepared.codexAppServer } : {}),
  }

  return {
    spec: invocationSpec,
    resolvedBundle: prepared.resolvedBundle,
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
  }
}
