export type { IsoTimestamp, JsonValue } from 'spaces-harness-broker-protocol'

export type JsonObject = Record<string, unknown>

export type SchemaVersion =
  | 'agent-runtime-compile-request/v1'
  | 'agent-runtime-compile-response/v1'
  | 'agent-runtime-plan/v1'
  | 'agent-runtime-profile/v1'
  | 'hrc-route-decision/v1'
  | 'runtime-operation/v1'
  | 'runtime-state/v1'
  | 'runtime-continuation/v1'
  | 'runtime-public-view/v1'
  | 'harness-broker.invocation/v1'

export type ProviderDomain = 'anthropic' | 'openai'
export type HarnessFamily = 'claude-code' | 'codex' | 'pi'
export type HarnessRuntime =
  | 'claude-code-cli'
  | 'claude-agent-sdk'
  | 'codex-cli'
  | 'pi-cli'
  | 'pi-sdk'

export type InteractionMode = 'interactive' | 'headless' | 'nonInteractive'
export type RuntimeControllerKind =
  | 'terminal'
  | 'embedded-sdk'
  | 'harness-broker'
  | 'command-process'
  | 'legacy-exec'

// Invariant: the execution-profile kind intentionally mirrors the controller
// kind — the two are kept identical by design. Kept as a distinct alias so the
// profile kind can diverge later if profile-level distinctions ever emerge.
export type RuntimeExecutionProfileKind = RuntimeControllerKind
export type LegacyTransportAlias = 'tmux' | 'headless' | 'sdk'

export const RUNTIME_STATE_STATUS_VALUES = [
  'allocating',
  'compiling',
  'admitted',
  'starting',
  'ready',
  'busy',
  'stopping',
  'stopped',
  'failed',
  'unknown_after_restart',
  'disposed',
  'awaiting_input',
  'stale',
  'terminated',
] as const

export type RuntimeStateStatus = (typeof RUNTIME_STATE_STATUS_VALUES)[number]

const RUNTIME_STATE_STATUS_SET: ReadonlySet<string> = new Set(RUNTIME_STATE_STATUS_VALUES)

export function isRuntimeStateStatus(value: unknown): value is RuntimeStateStatus {
  return typeof value === 'string' && RUNTIME_STATE_STATUS_SET.has(value)
}

export const RUNTIME_STATUS_VALUES = [...RUNTIME_STATE_STATUS_VALUES, 'dead', 'adopted'] as const

export type RuntimeStatus = (typeof RUNTIME_STATUS_VALUES)[number]

const RUNTIME_STATUS_SET: ReadonlySet<string> = new Set(RUNTIME_STATUS_VALUES)

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return typeof value === 'string' && RUNTIME_STATUS_SET.has(value)
}

export type RunStatus =
  | 'accepted'
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'degraded'
  | 'zombie'
