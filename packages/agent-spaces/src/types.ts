import type { LintWarning } from 'spaces-config'

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
 * CLI frontends (claude-code, codex-cli) are prepared as invocation specs for CP to spawn.
 */
export type HarnessFrontend = 'agent-sdk' | 'pi-sdk' | 'claude-code' | 'codex-cli'

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
}

// ---------------------------------------------------------------------------
// Existing foundational types (unchanged)
// ---------------------------------------------------------------------------

export type SpaceSpec = { spaces: string[] } | { target: { targetName: string; targetDir: string } }

export interface SessionCallbacks {
  onEvent(event: AgentEvent): void | Promise<void>
}

export type SessionState = 'running' | 'complete' | 'error'

// ---------------------------------------------------------------------------
// Request/Response: NonInteractive turn execution (spec §3.2)
// ---------------------------------------------------------------------------

export interface RunTurnNonInteractiveRequest {
  cpSessionId: string
  runId: string
  aspHome: string
  spec: SpaceSpec
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  continuation?: HarnessContinuationRef | undefined
  cwd: string
  env?: Record<string, string> | undefined
  prompt: string
  attachments?: string[] | undefined
  callbacks: SessionCallbacks
}

export interface RunTurnNonInteractiveResponse {
  continuation?: HarnessContinuationRef | undefined
  provider: ProviderDomain
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  result: RunResult
}

/**
 * In-flight turn execution request.
 * Uses the same payload shape as non-interactive turns, but allows additional
 * user messages to be queued/interrupts to be applied while the run is active.
 */
export interface RunTurnInFlightRequest extends RunTurnNonInteractiveRequest {}

export interface QueueInFlightInputRequest {
  cpSessionId: string
  runId: string
  prompt: string
  attachments?: string[] | undefined
}

export interface QueueInFlightInputResponse {
  accepted: boolean
  pendingTurns: number
}

export interface InterruptInFlightTurnRequest {
  cpSessionId: string
  runId?: string | undefined
  reason?: string | undefined
}

// ---------------------------------------------------------------------------
// Request/Response: CLI invocation preparation (spec §3.3)
// ---------------------------------------------------------------------------

export interface BuildProcessInvocationSpecRequest {
  cpSessionId: string
  aspHome: string
  spec: SpaceSpec
  provider: ProviderDomain
  frontend: 'claude-code' | 'codex-cli'
  model?: string | undefined
  interactionMode: 'interactive' | 'headless'
  ioMode: 'pty' | 'inherit' | 'pipes'
  continuation?: HarnessContinuationRef | undefined
  cwd: string
  env?: Record<string, string> | undefined
  artifactDir?: string | undefined
}

export interface BuildProcessInvocationSpecResponse {
  spec: ProcessInvocationSpec
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
    | undefined
  details?: Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// Event types (updated per spec §4)
// ---------------------------------------------------------------------------

export interface BaseEvent {
  ts: string
  seq: number
  cpSessionId: string
  runId: string
  continuation?: HarnessContinuationRef | undefined
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

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
  runTurnNonInteractive(req: RunTurnNonInteractiveRequest): Promise<RunTurnNonInteractiveResponse>
  runTurnInFlight(req: RunTurnInFlightRequest): Promise<RunTurnNonInteractiveResponse>
  queueInFlightInput(req: QueueInFlightInputRequest): Promise<QueueInFlightInputResponse>
  interruptInFlightTurn(req: InterruptInFlightTurnRequest): Promise<void>
  buildProcessInvocationSpec(
    req: BuildProcessInvocationSpecRequest
  ): Promise<BuildProcessInvocationSpecResponse>
  resolve(req: ResolveRequest): Promise<ResolveResponse>
  describe(req: DescribeRequest): Promise<DescribeResponse>
  getHarnessCapabilities(): Promise<HarnessCapabilities>
}
