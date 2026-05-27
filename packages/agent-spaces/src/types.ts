import type {
  HostCorrelation as HostCorrelationType,
  LintWarning,
  ResolvedRuntimeBundle,
  RuntimePlacement,
} from 'spaces-config'
import type {
  HarnessInvocationSpec,
  InputId,
  InvocationId,
  InvocationInput,
  InvocationStartRequest,
  PermissionPolicy,
  ProcessLimits,
} from 'spaces-harness-broker-protocol'
import type { AttachmentRef } from 'spaces-runtime'
import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

/** Re-export HostCorrelation from config for placement consumers */
export type HostCorrelation = HostCorrelationType

// ---------------------------------------------------------------------------
// Core types (spec §3.1)
// ---------------------------------------------------------------------------

/** Provider domain identifies the AI provider for a harness. */
export type ProviderDomain = 'anthropic' | 'openai'

/** Opaque provider-native string used to resume a conversation. */
export type HarnessContinuationKey = string

/**
 * Provider-typed continuation reference.
 * `key` is absent until the first successful provider turn when applicable.
 */
export type HarnessContinuationRef = {
  provider: ProviderDomain
  key?: HarnessContinuationKey | undefined
}

/** How the CLI harness process interacts with the user/host. */
export type InteractionMode = 'interactive' | 'headless' | 'nonInteractive'

/** I/O mode for the CLI harness process. */
export type IoMode = 'pty' | 'pipes' | 'inherit'

/**
 * Frontend identifier.
 * SDK frontends (agent-sdk, pi-sdk) are executed by agent-spaces directly.
 * CLI frontends (claude-code, codex-cli, pi-cli) are prepared as invocation specs for CP to spawn.
 */
export type HarnessFrontend = 'agent-sdk' | 'pi-sdk' | 'claude-code' | 'codex-cli' | 'pi-cli'

/**
 * Structured process invocation spec for CP to spawn a CLI harness process.
 * CP MUST NOT shell-parse argv; it is an authoritative argv array.
 */
export type ProcessInvocationSpec = {
  provider: ProviderDomain
  frontend: HarnessFrontend
  argv: string[]
  cwd: string
  env: Record<string, string>
  interactionMode: InteractionMode
  ioMode: IoMode
  continuation?: HarnessContinuationRef | undefined
  displayCommand?: string | undefined
  /** Path to the materialized system prompt file (for audit/inspection) */
  systemPromptFile?: string | undefined
  /**
   * Structured prompt material carried into the launch artifact. Lets the
   * launch wrapper (exec.ts) print the rendered system/priming prompt for
   * harnesses that don't pass it through argv (e.g. codex-cli, which writes
   * to AGENTS.md). Shape mirrors hrc-core's HrcLaunchPromptMaterial.
   */
  prompts?:
    | {
        system?:
          | {
              content: string
              mode?: 'append' | 'replace' | undefined
              sourcePath?: string | undefined
            }
          | undefined
      }
    | undefined
  codexAppServer?:
    | {
        prompt?: string | undefined
        resumeThreadId?: string | undefined
        model?: string | undefined
        modelReasoningEffort?: string | undefined
        approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
        sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
        profile?: string | undefined
        imageAttachments?: string[] | undefined
        featureFlags?: string[] | undefined
        extraArgs?: string[] | undefined
      }
    | undefined
}

// ---------------------------------------------------------------------------
// Existing foundational types (unchanged)
// ---------------------------------------------------------------------------

export type SpaceSpec = { spaces: string[] } | { target: { targetName: string; targetDir: string } }
export type AgentSpacesAttachmentInput = string | AttachmentRef

export interface SessionCallbacks {
  onEvent(event: AgentEvent): void | Promise<void>
}

export type SessionState = 'running' | 'complete' | 'error'

// ---------------------------------------------------------------------------
// Request/Response: NonInteractive turn execution (spec §3.2)
// ---------------------------------------------------------------------------

export interface RunTurnNonInteractiveRequest {
  hostSessionId?: string | undefined
  /** @deprecated Use hostSessionId instead */
  cpSessionId?: string | undefined
  runId: string
  aspHome: string
  spec: SpaceSpec
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  yolo?: boolean | undefined
  continuation?: HarnessContinuationRef | undefined
  cwd: string
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** @deprecated Use lockedEnv or dispatchEnv explicitly. Legacy env is treated as lockedEnv. */
  env?: Record<string, string> | undefined
  prompt: string
  attachments?: AgentSpacesAttachmentInput[] | undefined
  callbacks: SessionCallbacks
  /** Placement-based request (v2) — when set, legacy session/spec/aspHome/cwd are ignored */
  placement?: RuntimePlacement | undefined
}

export interface RunTurnNonInteractiveResponse {
  continuation?: HarnessContinuationRef | undefined
  provider: ProviderDomain
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  result: RunResult
  resolvedBundle?: ResolvedRuntimeBundle | undefined
}

/**
 * In-flight turn execution request.
 * Uses the same payload shape as non-interactive turns, but allows additional
 * user messages to be queued/interrupts to be applied while the run is active.
 */
export interface RunTurnInFlightRequest extends RunTurnNonInteractiveRequest {}

export interface QueueInFlightInputRequest {
  hostSessionId?: string | undefined
  /** @deprecated Use hostSessionId instead */
  cpSessionId?: string | undefined
  runId: string
  inputApplicationId?: string | undefined
  idempotencyKey?: string | undefined
  semantics?: 'append_context' | 'interrupt_and_continue' | undefined
  prompt: string
  attachments?: AgentSpacesAttachmentInput[] | undefined
}

export interface QueueInFlightInputResponse {
  accepted: boolean
  pendingTurns: number
}

export interface InterruptInFlightTurnRequest {
  hostSessionId?: string | undefined
  /** @deprecated Use hostSessionId instead */
  cpSessionId?: string | undefined
  runId?: string | undefined
  reason?: string | undefined
}

// ---------------------------------------------------------------------------
// Request/Response: CLI invocation preparation (spec §3.3)
// ---------------------------------------------------------------------------

export interface BuildProcessInvocationSpecRequest {
  hostSessionId?: string | undefined
  /** @deprecated Use hostSessionId instead */
  cpSessionId?: string | undefined
  aspHome: string
  spec: SpaceSpec
  provider: ProviderDomain
  frontend: 'claude-code' | 'codex-cli' | 'pi-cli'
  model?: string | undefined
  interactionMode: 'interactive' | 'headless'
  ioMode: 'pty' | 'inherit' | 'pipes'
  continuation?: HarnessContinuationRef | undefined
  cwd: string
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** @deprecated Use lockedEnv or dispatchEnv explicitly. Legacy env is treated as lockedEnv. */
  env?: Record<string, string> | undefined
  artifactDir?: string | undefined
  /** Prompt text to include in the invocation argv */
  prompt?: string | undefined
  /** Attachment refs to thread into the invocation (image attachments become CLI `-i <path>` args) */
  attachments?: AttachmentRef[] | undefined
  /** YOLO mode - skip all permission prompts (--dangerously-skip-permissions) */
  yolo?: boolean | undefined
  /** Placement-based request (v2) — when set, legacy session/spec/aspHome/cwd are ignored */
  placement?: RuntimePlacement | undefined
}

export interface BuildProcessInvocationSpecResponse {
  spec: ProcessInvocationSpec
  resolvedBundle?: ResolvedRuntimeBundle | undefined
  warnings?: string[] | undefined
}

export interface BuildHarnessBrokerInvocationRequest {
  placement: RuntimePlacement
  provider: 'openai'
  frontend: 'codex-cli'
  interactionMode: 'headless'
  aspHome?: string | undefined
  model?: string | undefined
  yolo?: boolean | undefined
  continuation?: HarnessContinuationRef | undefined
  prompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** @deprecated Use lockedEnv or dispatchEnv explicitly. Legacy env is treated as lockedEnv. */
  env?: Record<string, string> | undefined
  invocationId?: InvocationId | undefined
  initialInputId?: InputId | undefined
  labels?: Record<string, string> | undefined
  correlation?: Record<string, string> | undefined
  permissionPolicy?: PermissionPolicy | undefined
  limits?: ProcessLimits | undefined
  interaction?: { inputQueue?: 'fifo' | 'none' | undefined } | undefined
  resumeFallback?: 'start-fresh' | 'fail' | undefined
}

export interface BuildHarnessBrokerInvocationResponse {
  startRequest: InvocationStartRequest
  spec: HarnessInvocationSpec
  initialInput?: InvocationInput | undefined
  resolvedBundle?: ResolvedRuntimeBundle | undefined
  warnings?: string[] | undefined
}

// ---------------------------------------------------------------------------
// Resolve / Describe (minor updates)
// ---------------------------------------------------------------------------

export interface ResolveRequest {
  aspHome: string
  spec: SpaceSpec
}

export interface ResolveResponse {
  ok: boolean
  error?: AgentSpacesError | undefined
}

export interface DescribeRequest {
  aspHome: string
  spec: SpaceSpec
  registryPath?: string | undefined
  frontend?: HarnessFrontend | undefined
  model?: string | undefined
  cwd?: string | undefined
  hostSessionId?: string | undefined
  /** @deprecated Use hostSessionId instead */
  cpSessionId?: string | undefined
  runLint?: boolean | undefined
}

export interface DescribeResponse {
  hooks: string[]
  skills: string[]
  tools: string[]
  agentSdkSessionParams?: Array<{ paramName: string; paramValue: unknown }> | undefined
  lintWarnings?: LintWarning[] | undefined
}

// ---------------------------------------------------------------------------
// Harness capabilities (updated per spec §5.1)
// ---------------------------------------------------------------------------

export interface HarnessCapabilities {
  harnesses: Array<{
    id: string
    provider: ProviderDomain
    frontends: HarnessFrontend[]
    models: string[]
  }>
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface RunResult {
  success: boolean
  finalOutput?: string | undefined
  error?: AgentSpacesError | undefined
}

// ---------------------------------------------------------------------------
// Error types (updated codes per spec)
// ---------------------------------------------------------------------------

export interface AgentSpacesError {
  message: string
  code?:
    | 'resolve_failed'
    | 'provider_mismatch'
    | 'continuation_not_found'
    | 'model_not_supported'
    | 'unsupported_frontend'
    | 'empty_response'
    | undefined
  details?: Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// Event types (updated per spec §4)
// ---------------------------------------------------------------------------

export interface BaseEvent {
  ts: string
  seq: number
  hostSessionId: string
  /** @deprecated Use hostSessionId instead */
  cpSessionId?: string | undefined
  runId: string
  continuation?: HarnessContinuationRef | undefined
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

/**
 * Public API event type for agent-spaces consumers.
 *
 * This is an adapter/translation from `UnifiedSessionEvent` (the canonical
 * session-layer event model in `spaces-runtime/session`), NOT a competing
 * event model. AgentEvent exists to provide a stable, coarser-grained
 * contract for CP and other host-level consumers.
 */
export type AgentEvent =
  | (BaseEvent & { type: 'state'; state: SessionState })
  | (BaseEvent & { type: 'message'; role: 'user' | 'assistant'; content: string })
  | (BaseEvent & { type: 'message_delta'; role: 'assistant'; delta: string })
  | (BaseEvent & {
      type: 'tool_call'
      toolUseId: string
      toolName: string
      input: unknown
      parentToolUseId?: string
    })
  | (BaseEvent & {
      type: 'tool_result'
      toolUseId: string
      toolName: string
      output: unknown
      isError: boolean
      parentToolUseId?: string
    })
  | (BaseEvent & {
      type: 'log'
      level: 'debug' | 'info' | 'warn' | 'error'
      message: string
      fields?: Record<string, unknown> | undefined
    })
  | (BaseEvent & { type: 'complete'; result: RunResult })

// ---------------------------------------------------------------------------
// Client interface (updated per spec)
// ---------------------------------------------------------------------------

export interface AgentSpacesClient {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
  runTurnNonInteractive(req: RunTurnNonInteractiveRequest): Promise<RunTurnNonInteractiveResponse>
  runTurnInFlight(req: RunTurnInFlightRequest): Promise<RunTurnNonInteractiveResponse>
  queueInFlightInput(req: QueueInFlightInputRequest): Promise<QueueInFlightInputResponse>
  interruptInFlightTurn(req: InterruptInFlightTurnRequest): Promise<void>
  buildProcessInvocationSpec(
    req: BuildProcessInvocationSpecRequest
  ): Promise<BuildProcessInvocationSpecResponse>
  buildHarnessBrokerInvocation(
    req: BuildHarnessBrokerInvocationRequest
  ): Promise<BuildHarnessBrokerInvocationResponse>
  resolve(req: ResolveRequest): Promise<ResolveResponse>
  describe(req: DescribeRequest): Promise<DescribeResponse>
  getHarnessCapabilities(): Promise<HarnessCapabilities>
}
