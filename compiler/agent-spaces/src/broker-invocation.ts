import { basename, dirname, resolve } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import { type RuntimePlacement, getAgentRootsForProject } from 'spaces-config'
import { buildCodexAppServerLaunchDescriptor } from 'spaces-config'
import type {
  CodexAppServerDriverSpec,
  HarnessInvocationSpec,
  InputContent,
  InputId,
  InvocationInput,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import {
  isAmbientEnvKey,
  isCredentialEnvKey,
  isReservedEnvKey,
  validateInvocationInput,
  validateInvocationSpec,
} from 'spaces-harness-broker-protocol'
import type { ContextResolverContext } from 'spaces-runtime'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

import { CodedError } from './client-support.js'
import type { PreparedPlacementCliRuntime } from './prepare-cli-runtime.js'
import type {
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
} from './types.js'

type BrokerInitialInputPrepared = Pick<
  PreparedPlacementCliRuntime,
  'expandedPrompt' | 'imageAttachmentPaths'
>

/**
 * Direct first-party preparation contains resource semantics only. In
 * particular, it has no command, args, adapter detection, or generated bundle.
 */
export type NativeWorkerBrokerPrepared = BrokerInitialInputPrepared & {
  cwd: string
  lockedEnv: Record<string, string>
  pathPrepend: string[]
  resolvedBundle: PreparedPlacementCliRuntime['resolvedBundle']
  warnings: string[]
  systemPrompt?: PreparedPlacementCliRuntime['systemPrompt'] | undefined
}

interface HandleParts {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
}

/**
 * Default broker process limits (milliseconds) applied when the caller does not
 * override them. Named per-field so the intent of each magic number is explicit
 * and so any tuning happens against a single documented source of truth.
 */
/** Max time to wait for the harness process to come up before failing the start. */
const DEFAULT_BROKER_STARTUP_TIMEOUT_MS = 20_000
/** Max wall-clock time a single turn may run before the broker aborts it (15 min). */
const DEFAULT_BROKER_TURN_TIMEOUT_MS = 900_000
/** Grace period granted for a clean shutdown before the broker hard-stops it. */
const DEFAULT_BROKER_STOP_GRACE_MS = 5_000

const DEFAULT_BROKER_PROCESS_LIMITS: NonNullable<HarnessInvocationSpec['process']['limits']> = {
  startupTimeoutMs: DEFAULT_BROKER_STARTUP_TIMEOUT_MS,
  turnTimeoutMs: DEFAULT_BROKER_TURN_TIMEOUT_MS,
  stopGraceMs: DEFAULT_BROKER_STOP_GRACE_MS,
}

/**
 * Best-effort parse of a shorthand `agent@project:task` handle into its parts.
 * Used as a fallback when {@link parseScopeRef} cannot parse a canonical
 * ScopeRef. Pure: emits no diagnostics and never throws.
 */
function parseShorthandHandle(scopeRef: string): HandleParts {
  const atIndex = scopeRef.indexOf('@')
  if (atIndex === -1) {
    return { agentId: scopeRef }
  }
  const agentId = scopeRef.slice(0, atIndex)
  const rest = scopeRef.slice(atIndex + 1)
  const colonIndex = rest.indexOf(':')
  if (colonIndex === -1) {
    return { agentId, projectId: rest }
  }
  return {
    agentId,
    projectId: rest.slice(0, colonIndex),
    taskId: rest.slice(colonIndex + 1),
  }
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
    } catch (error) {
      // Best-effort fallback for older callers that sent shorthand handles
      // instead of canonical ScopeRefs. A genuine parse failure on a value that
      // looks canonical is indistinguishable from shorthand here, so emit a
      // single diagnostic line — otherwise a derived agentId/projectId/taskId
      // mislabel would silently flow into broker correlation labels with no
      // trace of the parse having failed. (Best-effort fallback is retained.)
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[asp-diag] deriveHandleParts: parseScopeRef failed for scopeRef=${JSON.stringify(
          scopeRef
        )} (${reason}); using shorthand fallback\n`
      )
      const shorthand = parseShorthandHandle(scopeRef)
      parts.agentId = shorthand.agentId
      if (shorthand.projectId !== undefined) {
        parts.projectId = shorthand.projectId
      }
      if (shorthand.taskId !== undefined) {
        parts.taskId = shorthand.taskId
      }
    }
  }
  if (parts.agentId === undefined) {
    parts.agentId = basename(placement.agentRoot)
  }
  if (parts.projectId === undefined && placement.projectRoot) {
    parts.projectId = basename(resolve(placement.projectRoot))
  }
  if (laneRef && laneRef.length > 0) {
    parts.lane = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  }
  return parts
}

export function buildPromptExpansionContext(placement: RuntimePlacement): ContextResolverContext {
  const handleParts = deriveHandleParts(placement)
  return {
    agentRoot: placement.agentRoot,
    agentsRoot: dirname(placement.agentRoot),
    agentRootSearchPath: getAgentRootsForProject(placement.projectRoot),
    agentId: handleParts.agentId ?? basename(placement.agentRoot),
    projectId: handleParts.projectId,
    taskId: handleParts.taskId,
    lane: handleParts.lane,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    runMode: placement.runMode,
  }
}

export function validateBrokerInvocationRequest(req: BuildHarnessBrokerInvocationRequest): void {
  if (req.generation === undefined || !Number.isSafeInteger(req.generation) || req.generation < 0) {
    throw new CodedError(
      'Broker invocation generation must be a non-negative integer',
      'resolve_failed'
    )
  }
  if (req.frontend.length === 0 || req.provider.length === 0) {
    throw new CodedError(
      'Broker invocation frontend and provider must be non-empty',
      'resolve_failed'
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

export function combineBrokerPrompts(
  primingPrompt: string | undefined,
  callerPrompt: string | undefined,
  omitPriming = false
): string | undefined {
  // An explicit empty caller prompt suppresses all launch text. This preserves
  // the existing image-only/no-first-turn escape hatch.
  if (callerPrompt === '') {
    return ''
  }
  if (omitPriming) {
    return callerPrompt
  }
  if (primingPrompt !== undefined && callerPrompt !== undefined) {
    return `${primingPrompt}\n\n${callerPrompt}`
  }
  return primingPrompt ?? callerPrompt
}

function buildBrokerInitialText(
  prepared: BrokerInitialInputPrepared,
  req: BuildHarnessBrokerInvocationRequest
): string | undefined {
  if (req.prompt === '') {
    return undefined
  }
  if (req.omitPriming === true && req.prompt === undefined) {
    return undefined
  }

  // Codex receives the system prompt + session reminder via the runtime-home
  // AGENTS.md (written under lock in prepareCodexRuntimeHome), read on both the
  // interactive and exec/headless routes. The broker initial input is therefore
  // the priming/caller prompt ONLY — never the system prompt/reminder — matching
  // the interactive launch and avoiding the T-03939 first-message pollution.
  return prepared.expandedPrompt
}

/**
 * Derive a stable `initialInputId` from generation + input content (T-04133).
 * Replaces the former `input_${randomUUID()}` fallback: a random id made the
 * initial input — and any hash that includes it — non-reproducible. The
 * derivation folds the optional compile-context `idSalt`, the request
 * `generation`, and the canonical hash of the input content, so an identical
 * request + content repeats the id while a changed generation or input content
 * moves it. It is deliberately NEUTRAL to per-dispatch correlation/invocationId
 * so the start-request projection that includes this id stays hash-neutral
 * across pure correlation changes (the canonical-env contract). It is NOT a
 * hidden RNG: with fixed inputs it is a pure function. HRC's per-request
 * dispatch uniqueness is unaffected — it derives from invocationId, not from
 * the initial input id.
 */
function deriveInitialInputId(
  req: BuildHarnessBrokerInvocationRequest,
  content: InputContent[]
): InputId {
  const material = {
    idSalt: req.idSalt,
    generation: req.generation,
    content,
  }
  const digest = createCanonicalHasher().hash(material, {
    timestampMode: 'omit-ephemeral',
  }).value
  return `input_${digest.slice(0, 32)}` as InputId
}

function buildInitialInput(
  prepared: BrokerInitialInputPrepared,
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
    inputId: req.initialInputId ?? deriveInitialInputId(req, content),
    kind: 'user',
    content,
    // T-03779: a per-turn response format rides on the initial broker turn only
    // when a turn actually exists. Response format alone must never synthesize
    // an empty initial input (the content.length === 0 guard above handles that).
    ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
  }
}

/**
 * Muse headless start request (muse-serve): mirrors the committed matrix fixture
 * (contracts/harness-broker-protocol/src/fixtures/muse-serve/start-fresh.spec.json).
 * Serve argv stays fixture-exact; the broker owns queueing (fifo).
 */
function toMuseServeStartRequest(
  prepared: PreparedPlacementCliRuntime,
  req: BuildHarnessBrokerInvocationRequest
): BuildHarnessBrokerInvocationResponse {
  // The muse-serve driver prepares its own isolated HOME at birth and composes
  // HOME/XDG itself (driver.ts: isolated HOME is mandatory and cannot ride
  // lockedEnv). Strip the ambient/credential/reserved keys the spec forbids.
  const lockedEnv = Object.fromEntries(
    Object.entries(prepared.lockedEnv).filter(
      ([key]) => !isAmbientEnvKey(key) && !isCredentialEnvKey(key) && !isReservedEnvKey(key)
    )
  )
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.invocationId !== undefined ? { invocationId: req.invocationId } : {}),
    ...(req.labels !== undefined ? { labels: req.labels } : {}),
    harness: {
      frontend: 'muse-cli',
      provider: 'meta',
      driver: 'muse-serve',
    },
    process: {
      command: prepared.commandPath,
      // No-sandbox seat: serve's default proxy-only network sandbox denies the
      // direct TCP (wrkc workrpc) the seat needs, so disable shell
      // filesystem/network sandboxing for the host lifetime.
      args: ['serve', '--trust-workspace', '--disable-sandbox'],
      cwd: prepared.cwd,
      lockedEnv,
      ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: req.limits ?? DEFAULT_BROKER_PROCESS_LIMITS,
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'fifo',
    },
    ...(req.continuation?.key !== undefined
      ? {
          continuation: {
            provider: 'muse',
            kind: 'session',
            key: req.continuation.key,
          },
        }
      : {}),
    driver: {
      kind: 'muse-serve',
      workspace: prepared.cwd,
      // Operator HOME is REQUIRED for model calls: the operator credential
      // is keychain-bound oauth (device_code), which never leaves the
      // operator HOME — serve answers authRequired under an isolated HOME
      // even with auth.json symlinked. XDG dirs stay disposable.
      homeMode: 'operator',
      ...(req.model !== undefined ? { model: req.model } : {}),
      // Yolo: the muse seat runs without approval prompts (MSP allowAll —
      // the server approves tool use itself). permissionPolicy stays deny
      // as the backstop for anything the server still routes to policy.
      approvalMode: 'allowAll',
      permissionPolicy: req.permissionPolicy ?? { mode: 'deny' },
      ...(req.continuation?.key !== undefined ? { resumeSessionId: req.continuation.key } : {}),
      resumeFallback: req.resumeFallback ?? 'start-fresh',
    },
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

function toNativeAgentHarnessStartRequest(
  prepared: NativeWorkerBrokerPrepared,
  req: BuildHarnessBrokerInvocationRequest & {
    provider: 'openai'
    frontend: 'agent-harness-tui'
    interactionMode: 'headless' | 'interactive'
    brokerDriver: 'agent-harness' | 'agent-harness-tmux'
    harnessTransport: { kind: 'native-worker' }
    sdk: NonNullable<BuildHarnessBrokerInvocationRequest['sdk']>
    agent: NonNullable<BuildHarnessBrokerInvocationRequest['agent']>
  }
): BuildHarnessBrokerInvocationResponse {
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.invocationId !== undefined ? { invocationId: req.invocationId } : {}),
    ...(req.labels !== undefined ? { labels: req.labels } : {}),
    harness: {
      frontend: 'agent-harness-tui',
      provider: 'openai',
      driver: req.brokerDriver,
    },
    process: {
      execution: 'native-worker',
      cwd: prepared.cwd,
      lockedEnv: prepared.lockedEnv,
      ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
      harnessTransport: { kind: 'native-worker' },
      limits: req.limits ?? DEFAULT_BROKER_PROCESS_LIMITS,
    },
    interaction: {
      mode: req.interactionMode,
      turnConcurrency: 'single',
      inputQueue: req.interaction?.inputQueue ?? 'fifo',
    },
    ...(req.continuation?.key !== undefined
      ? {
          continuation: {
            provider: req.provider,
            kind: 'session',
            key: req.continuation.key,
          },
        }
      : {}),
    driver: {
      kind: req.brokerDriver,
      ...(req.brokerDriver === 'agent-harness-tmux' ? { terminalHost: 'tmux' } : {}),
      permissionPolicy: req.permissionPolicy ?? { mode: 'deny' },
    },
    sdk: req.sdk,
    agent: req.agent,
    ...(prepared.systemPrompt?.path !== undefined
      ? {
          launch: {
            systemPromptFile: prepared.systemPrompt.path,
            ...(prepared.systemPrompt.mode !== undefined
              ? { systemPromptMode: prepared.systemPrompt.mode }
              : {}),
          },
        }
      : {}),
    correlation: req.correlation ?? brokerCorrelationFromPlacement(req.placement),
  }
  const initialInput = buildInitialInput(prepared, req)
  const startRequest: InvocationStartRequest =
    initialInput === undefined ? { spec } : { spec, initialInput }
  validateInvocationSpec(spec)
  if (initialInput !== undefined) validateInvocationInput(initialInput)
  return {
    startRequest,
    spec,
    ...(initialInput !== undefined ? { initialInput } : {}),
    resolvedBundle: prepared.resolvedBundle,
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
  }
}

export function toHarnessBrokerStartRequest(
  prepared: PreparedPlacementCliRuntime | NativeWorkerBrokerPrepared,
  req: BuildHarnessBrokerInvocationRequest
): BuildHarnessBrokerInvocationResponse {
  if (req.brokerDriver === 'muse-serve') {
    return toMuseServeStartRequest(prepared as PreparedPlacementCliRuntime, req)
  }
  if (isNativeAgentHarnessBrokerRequest(req)) {
    return toNativeAgentHarnessStartRequest(prepared as NativeWorkerBrokerPrepared, req)
  }
  const childPrepared = prepared as PreparedPlacementCliRuntime
  const codexDescriptor = buildCodexAppServerLaunchDescriptor(childPrepared.runOptions)
  const driver: CodexAppServerDriverSpec = {
    kind: 'codex-app-server',
    ...(req.presentation !== undefined ? { presentation: req.presentation } : {}),
    ...(req.transport !== undefined ? { transport: req.transport } : {}),
    ...(req.continuation?.key !== undefined ? { resumeThreadId: req.continuation.key } : {}),
    ...(codexDescriptor.model !== undefined ? { model: codexDescriptor.model } : {}),
    ...(codexDescriptor.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: codexDescriptor.modelReasoningEffort }
      : {}),
    approvalPolicy: codexDescriptor.approvalPolicy ?? 'never',
    ...(codexDescriptor.sandboxMode !== undefined
      ? { sandboxMode: codexDescriptor.sandboxMode }
      : {}),
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
      command: childPrepared.commandPath,
      args: childPrepared.args,
      cwd: childPrepared.cwd,
      lockedEnv: childPrepared.lockedEnv,
      ...(childPrepared.pathPrepend.length > 0 ? { pathPrepend: childPrepared.pathPrepend } : {}),
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: req.limits ?? DEFAULT_BROKER_PROCESS_LIMITS,
    },
    interaction: {
      mode: req.interactionMode,
      turnConcurrency: 'single',
      inputQueue: 'fifo',
    },
    ...(req.continuation?.key !== undefined
      ? {
          continuation: {
            provider: 'codex',
            kind: 'thread',
            key: req.continuation.key,
          },
        }
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
    resolvedBundle: childPrepared.resolvedBundle,
    ...(childPrepared.warnings.length > 0 ? { warnings: childPrepared.warnings } : {}),
  }
}

function isNativeAgentHarnessBrokerRequest(
  req: BuildHarnessBrokerInvocationRequest
): req is BuildHarnessBrokerInvocationRequest & {
  provider: 'openai'
  frontend: 'agent-harness-tui'
  interactionMode: 'headless' | 'interactive'
  brokerDriver: 'agent-harness' | 'agent-harness-tmux'
  harnessTransport: { kind: 'native-worker' }
  sdk: NonNullable<BuildHarnessBrokerInvocationRequest['sdk']>
  agent: NonNullable<BuildHarnessBrokerInvocationRequest['agent']>
} {
  return (
    req.provider === 'openai' &&
    req.frontend === 'agent-harness-tui' &&
    (req.brokerDriver === 'agent-harness' || req.brokerDriver === 'agent-harness-tmux') &&
    req.harnessTransport?.kind === 'native-worker' &&
    req.sdk?.runtime === 'pi-sdk' &&
    req.agent !== undefined
  )
}
