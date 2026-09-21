import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { ResolvedHarnessExecution } from './types.js'

/** Proves the materialized request still matches the resolver's frozen recipe. */
export function assertExecutionMatchesResolution(
  resolved: ResolvedHarnessExecution,
  startRequest: InvocationStartRequest
): void {
  const actualDriver = startRequest.spec.driver.kind
  if (actualDriver !== resolved.recipe.driver) {
    throw new Error(
      `Resolved driver ${resolved.recipe.driver} was materialized as ${actualDriver}`
    )
  }
  const actualTransport = startRequest.spec.process.harnessTransport.kind
  if (actualTransport !== resolved.recipe.hosting.executionTransport) {
    throw new Error(
      `Resolved transport ${resolved.recipe.hosting.executionTransport} was materialized as ${actualTransport}`
    )
  }
  const actualTerminalHost =
    'terminalHost' in startRequest.spec.driver ? startRequest.spec.driver['terminalHost'] : undefined
  if (
    resolved.recipe.hosting.terminalHost !== undefined &&
    actualTerminalHost !== resolved.recipe.hosting.terminalHost &&
    resolved.recipe.driver !== 'codex-app-server'
  ) {
    throw new Error(
      `Resolved terminal host ${resolved.recipe.hosting.terminalHost} was not materialized`
    )
  }
}
