import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import type { HarnessDetection, HarnessRunOptions, ResolvedPlacementContext } from 'spaces-config'
import {
  type RuntimePlacement,
  getAspHome,
  resolvePlacementContext,
  sweepAspTempArtifacts,
  writeRuntimeSystemPromptArtifact,
} from 'spaces-config'
import type { PlacementRuntimePlan } from 'spaces-execution'
import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
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
  assertProviderMatch,
  formatDisplayCommand,
  resolveFrontend,
} from './client-support.js'
import { composeAgentLocalEnv } from './compose-agent-local-env.js'
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
  modelReasoningEffort?: string | undefined
  yolo?: boolean | undefined
  disallowedTools?: string[] | undefined
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

async function persistSystemPromptArtifact(
  aspHome: string,
  artifactRoot: string,
  systemPrompt: MaterializeResult
): Promise<MaterializeResult> {
  const artifact = await writeRuntimeSystemPromptArtifact({
    aspHome,
    artifactRoot,
    content: systemPrompt.content,
  })
  return {
    ...systemPrompt,
    path: artifact.systemPromptPath,
  }
}

/**
 * Prepare placement-based CLI runtime state without choosing an output protocol.
 */
export async function preparePlacementCliRuntime(
  req: PreparePlacementCliRuntimeRequest,
  defaultAspHome?: string,
  defaultRegistryPath?: string
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
  assertProviderMatch(frontendDef, req.continuation)

  const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
  const { spec } = placementContext.materialization

  // Resolve placement to get audit metadata and materialization inputs
  const resolvedBundle = placementContext.resolvedBundle

  // Resolve effective cwd from placement
  const cwd = resolvedBundle.cwd

  const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
  await sweepAspTempArtifacts({ aspHome }).catch(() => {})
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
  const materializationIdentity =
    placement.bundle.kind === 'agent-project'
      ? (() => {
          if (!handleParts.agentId || !handleParts.projectId) {
            const fallbackProjectRoot =
              placement.projectRoot ??
              placement.cwd ??
              (placement.bundle.kind === 'agent-project' ? placement.bundle.projectRoot : undefined)
            console.warn(
              `[asp-diag] agent-project materialization missing semantic scopeRef identity; falling back to placement fields agentId=${JSON.stringify(
                placement.bundle.agentName
              )} projectRoot=${JSON.stringify(fallbackProjectRoot ?? 'missing-project')}`
            )
            return {
              agentId: placement.bundle.agentName,
              projectId: fallbackProjectRoot
                ? basename(resolve(fallbackProjectRoot))
                : 'missing-project',
              frontend: req.frontend,
            }
          }
          return {
            agentId: handleParts.agentId,
            projectId: handleParts.projectId,
            frontend: req.frontend,
          }
        })()
      : undefined

  // Unified materialization: use the shared placement context, then materialize the resolved spec.
  const materialized = await materializeSpec(spec, aspHome, runtimePlan.harnessId, {
    ...(defaultRegistryPath !== undefined ? { registryPathOverride: defaultRegistryPath } : {}),
    agentRoot: placement.agentRoot,
    projectRoot: placement.projectRoot,
    ...(placement.bundle.kind === 'agent-project'
      ? { materializationTargetName: placement.bundle.agentName }
      : {}),
    ...(materializationIdentity ? { materializationIdentity } : {}),
    agentLocalComponents,
  })
  const launchOverlayDir = join(aspHome, 'tmp', 'launch-overlays', randomUUID())
  let systemPrompt: MaterializeResult | undefined
  try {
    const materializedSystemPrompt = await materializeSystemPrompt(launchOverlayDir, {
      ...placement,
      ...(handleParts.agentId !== undefined ? { agentId: handleParts.agentId } : {}),
      ...(handleParts.projectId !== undefined ? { projectId: handleParts.projectId } : {}),
      ...(handleParts.taskId !== undefined ? { taskId: handleParts.taskId } : {}),
      ...(handleParts.lane !== undefined ? { lane: handleParts.lane } : {}),
    })
    systemPrompt =
      materializedSystemPrompt !== undefined
        ? await persistSystemPromptArtifact(
            aspHome,
            // Tie prompt-file lifetime to the versioned bundle that compiled
            // plans already reference; .versions pruning owns both together.
            join(materialized.materialization.outputPath, '.asp-runtime-artifacts'),
            materializedSystemPrompt
          )
        : undefined
  } finally {
    await rm(launchOverlayDir, { recursive: true, force: true }).catch(() => {})
  }

  // Bundle label = the LOGICAL target name (legacy `asp run` labels the bundle
  // with the agent/target name). Agent-project placements materialize under the
  // same agent-name target path, and loadTargetBundle uses the label for
  // launch-shape values like the claude remote-control session name
  // (`<targetName>-<project>`).
  const bundleLabel =
    placement.bundle.kind === 'agent-project' ? placement.bundle.agentName : materialized.targetName
  const bundle = await adapter.loadTargetBundle(
    materialized.materialization.outputPath,
    bundleLabel
  )

  const imageAttachmentPaths = extractImageAttachmentPaths(req.attachments)

  const expandedPrompt =
    runtimePlan.prompt !== undefined
      ? expandTemplate(runtimePlan.prompt, buildPromptExpansionContext(placement))
      : undefined
  // The visible launch/initial message is ONLY the priming/caller prompt for
  // every frontend. For codex, the system prompt + session reminder reach the
  // model via the runtime-home AGENTS.md (written under lock in
  // prepareCodexRuntimeHome), NOT by concatenating them ahead of the priming
  // prompt — that regression (T-03939) leaked the whole system prompt into the
  // first TUI message. The compiled system prompt is static per agent@project
  // (task-scoped identity removed from the `## Runtime scope` template section),
  // so baking it into the shared home is race-free under the fingerprint lock.
  const launchPrompt = expandedPrompt

  // Build run options for the adapter
  let runOptions: HarnessRunOptions = {
    ...runtimePlan.runOptions,
    ...(req.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: req.modelReasoningEffort }
      : {}),
    // Only push --model onto argv when the model came from an explicit source
    // (requested CLI/model, a default run-option model, or a supported
    // effective-config model). Falling back to the adapter default for plan
    // metadata must NOT inject --model — legacy `asp run` omits it (e.g. codex,
    // governed by CODEX_HOME/config.toml).
    ...(runtimePlan.model.info.explicit ? { model: runtimePlan.model.info.model } : {}),
    ...(launchPrompt !== undefined ? { prompt: launchPrompt } : {}),
    ...(runtimePlan.yolo !== undefined ? { yolo: runtimePlan.yolo } : {}),
    ...(req.disallowedTools ? { disallowedTools: req.disallowedTools } : {}),
    ...(handleParts.taskId !== undefined ? { taskId: handleParts.taskId } : {}),
    ...(handleParts.projectId !== undefined ? { projectId: handleParts.projectId } : {}),
    ...(imageAttachmentPaths.length > 0 ? { imageAttachments: imageAttachmentPaths } : {}),
    ...(systemPrompt
      ? {
          systemPrompt: systemPrompt.content,
          systemPromptMode: systemPrompt.mode,
          // Propagate the materialized session reminder so adapters that deliver
          // it on the launch argv (pi: --append-system-prompt) match legacy
          // `asp run`. The compiler materializes prompt+reminder from its own
          // bundle (single source); the legacy seam copied only content+mode and
          // silently dropped the reminder for pi (T-01824 real-binary divergence).
          ...(systemPrompt.reminderContent !== undefined
            ? { reminderContent: systemPrompt.reminderContent }
            : {}),
        }
      : {}),
  }

  // For codex frontends, prepare the stable runtime home directory so that
  // hrc run uses the same CODEX_HOME as asp run (codex-homes/<project>_<target>).
  // prepareCodexRuntimeHome syncs stable managed files + project trust and writes
  // the praesidium-context block (system prompt + reminder) into AGENTS.md inside
  // the home lock; the block hash is folded into the home fingerprint so the
  // shared home is rewritten only when the prompt material changes (race-free,
  // self-healing for stale blocks). Codex reads AGENTS.md on both interactive and
  // exec routes, so the model receives the system prompt without it appearing in
  // the visible launch message.
  if (frontendDef.frontend === CODEX_CLI_FRONTEND) {
    const codexHomeDir = await prepareCodexRuntimeHome(bundle, {
      ...runOptions,
      aspHome,
      interactive: req.interactionMode === 'interactive',
    })
    runOptions = { ...runOptions, codexHomeDir }
  }

  // Build argv and env using the adapter
  const args = adapter.buildRunArgs(bundle, runOptions)
  const adapterEnv = adapter.getRunEnv(bundle, runOptions)
  const commandPath = detection.path ?? runtimePlan.harnessId
  const argv = [commandPath, ...args]

  // Derive ASP_PROJECT and AGENTCHAT_ID so tools like agentchat can discover
  // their project and agent context without a manual .env.local.
  const agentchatEnv: Record<string, string> = {
    AGENTCHAT_ID: basename(placement.agentRoot),
  }
  if (placement.projectRoot) {
    agentchatEnv['ASP_PROJECT'] = basename(resolve(placement.projectRoot))
  }

  // Compose the agent-local env channels. The CLI path folds adapterEnv +
  // agentchatEnv into lockedEnv, gates the brain block on dryRun, and consumes
  // the typed pathPrepend + tool warnings.
  const composed = await composeAgentLocalEnv({
    placement,
    agentLocalComponents,
    aspHome,
    adapterEnv,
    agentchatEnv,
    ...(req.env !== undefined ? { reqEnv: req.env } : {}),
    ...(req.lockedEnv !== undefined ? { reqLockedEnv: req.lockedEnv } : {}),
    ...(req.dispatchEnv !== undefined ? { reqDispatchEnv: req.dispatchEnv } : {}),
    gateBrainOnDryRun: true,
  })
  const lockedEnv = composed.lockedEnv
  const dispatchEnv = composed.dispatchEnv
  const env = composed.env
  const pathPrepend = composed.pathPrepend
  warnings.push(...composed.warnings)

  // Build display command
  const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)

  // Build continuation ref
  const continuation: HarnessContinuationRef | undefined = req.continuation
    ? { provider: runtimePlan.provider, key: req.continuation.key }
    : undefined

  // The headless codex app-server conveys the model via its descriptor (config),
  // NOT via CLI argv. Plan metadata records the RESOLVED model (including the
  // adapter default) even when it is not pushed onto a foreground argv — so the
  // descriptor must always receive the resolved model, independent of the
  // source-aware `runOptions.model` (which only carries an explicit model).
  const codexAppServer =
    req.frontend === 'codex-cli' && req.interactionMode === 'headless'
      ? buildCodexAppServerLaunchDescriptor({ ...runOptions, model: runtimePlan.model.info.model })
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
