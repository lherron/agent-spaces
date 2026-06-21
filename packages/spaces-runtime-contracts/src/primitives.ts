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

export type RuntimeStatus =
  | 'allocating'
  | 'compiling'
  | 'admitted'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'unknown_after_restart'
  | 'disposed'
  | string

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
  | string
