/**
 * Shared types for the broker smoke test library.
 */
import type { InvocationEventEnvelope } from '../../../packages/harness-broker-protocol/src/events.ts'
import type { InputPolicy, InvocationInputResponse } from '../../../packages/harness-broker-protocol/src/commands.ts'

// ---------------------------------------------------------------------------
// Scenario types
// ---------------------------------------------------------------------------

export type ScenarioName = 'happy' | 'queue-policy'
export type ScenarioSelection = ScenarioName | 'all'

export interface ParsedArgs {
  scopeRef: string
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  aspHome: string
  invocationId: string
  timeout: number // seconds
  transcript: string
  prompt: string
  scenario: ScenarioSelection
  help: boolean
}

export interface ScenarioRun {
  name: ScenarioName
  args: ParsedArgs
}

// ---------------------------------------------------------------------------
// Event collection
// ---------------------------------------------------------------------------

export interface CollectedRun {
  collectedEvents: InvocationEventEnvelope[]
  seenTypes: Set<string>
  terminalTurnEvent?: InvocationEventEnvelope | undefined
  terminalTurnEvents: InvocationEventEnvelope[]
  assistantTexts: string[]
}

// ---------------------------------------------------------------------------
// Probe types (shared between scenario configs and assertions)
// ---------------------------------------------------------------------------

export interface ProbeSpec {
  label: string
  inputId: string
  whenBusy: InputPolicy['whenBusy']
  text?: string | undefined
  expectedReason?: string | undefined
}

export interface ProbeResult {
  probe: ProbeSpec
  response: InvocationInputResponse
  rpcRejected: boolean
}
