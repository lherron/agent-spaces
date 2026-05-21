/**
 * Happy-path smoke scenario: drives a single broker turn with a `pwd` command
 * and verifies the full event lifecycle including tool calls and introspection output.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createAgentSpacesClient } from '../../../../packages/agent-spaces/src/index.ts'
import type { BuildHarnessBrokerInvocationRequest } from '../../../../packages/agent-spaces/src/index.ts'
import { validateInvocationStartRequest } from '../../../../packages/harness-broker-protocol/src/schemas.ts'
import type { BrokerClient } from '../../../../packages/harness-broker-client/src/index.ts'

import {
  assertCommandToolCall,
  assertIntrospectionOutput,
  assertTerminalTurnCompleted,
  buildSensitiveValues,
  check,
  requireEvents,
} from '../assertions.ts'
import {
  REQUIRED_EVENTS,
  REQUIRED_TOOL_EVENTS,
  collectEventsUntilTerminal,
  cleanupInvocation,
} from '../event-collector.ts'
import {
  assertInitialInputStartsWithPriming,
  buildPlacement,
  expectedExpandedPrimingPrompt,
} from '../placement.ts'
import type { ScenarioRun } from '../types.ts'

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runHappyScenario(
  brokerClient: BrokerClient,
  run: ScenarioRun
): Promise<number> {
  const { args } = run
  const transcriptDir = dirname(args.transcript)
  mkdirSync(transcriptDir, { recursive: true })

  console.log(`[smoke] Scenario:       ${run.name}`)
  console.log(`[smoke] scope-ref:      ${args.scopeRef}`)
  console.log(`[smoke] asp-home:       ${args.aspHome}`)
  console.log(`[smoke] invocation-id:  ${args.invocationId}`)
  console.log(`[smoke] timeout:        ${args.timeout}s`)
  console.log(`[smoke] transcript:     ${args.transcript}`)
  console.log(`[smoke] prompt:         ${args.prompt}`)
  console.log()

  // Step 1: Build placement
  console.log('[smoke] Step 1: Building RuntimePlacement from scope-ref...')
  const placement = buildPlacement(args)
  console.log(`[smoke]   agentRoot:   ${placement.agentRoot}`)
  console.log(`[smoke]   projectRoot: ${placement.projectRoot ?? '(none)'}`)
  console.log(`[smoke]   cwd:         ${placement.cwd ?? '(none)'}`)
  console.log(`[smoke]   bundle:      ${JSON.stringify(placement.bundle)}`)
  if (placement.bundle.kind !== 'agent-project') {
    throw new Error(
      `Expected placement.bundle.kind to be "agent-project"; got "${placement.bundle.kind}"`
    )
  }
  console.log('[smoke]   Verified: placement bundle kind is agent-project.')
  console.log()

  // Step 2: Build invocation
  console.log('[smoke] Step 2: Building broker invocation via ASP SDK...')
  const spacesClient = createAgentSpacesClient({ aspHome: args.aspHome })
  const brokerReq: BuildHarnessBrokerInvocationRequest = {
    placement,
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    prompt: args.prompt,
    invocationId: args.invocationId,
    permissionPolicy: { mode: 'deny' },
    labels: { scenario: `asp-broker-real-codex-smoke:${run.name}` },
  }

  const invocationResponse = await spacesClient.buildHarnessBrokerInvocation(brokerReq)

  const expectedPriming = await expectedExpandedPrimingPrompt(placement)
  assertInitialInputStartsWithPriming(invocationResponse.initialInput, expectedPriming)
  console.log(`[smoke]   spec.invocationId: ${invocationResponse.spec.invocationId ?? '(auto)'}`)
  console.log(`[smoke]   spec.process.command: ${invocationResponse.spec.process.command}`)
  console.log(`[smoke]   spec.process.cwd: ${invocationResponse.spec.process.cwd}`)
  console.log(
    `[smoke]   spec.interaction.inputQueue: ${invocationResponse.spec.interaction?.inputQueue ?? '(none)'}`
  )
  console.log(`[smoke]   initialInput: ${invocationResponse.initialInput ? 'present' : 'absent'}`)
  if (invocationResponse.warnings?.length) {
    console.log(`[smoke]   warnings: ${invocationResponse.warnings.join(', ')}`)
  }
  console.log()

  // Step 3: Validate
  console.log('[smoke] Step 3: Validating InvocationStartRequest...')
  validateInvocationStartRequest(invocationResponse.startRequest)
  console.log('[smoke]   Validation passed.')
  console.log()

  // Step 6: Start invocation
  console.log('[smoke] Step 6: Starting invocation (with initialInput)...')
  const { invocationId, events } = await brokerClient.startInvocation(
    invocationResponse.startRequest.spec,
    invocationResponse.startRequest.initialInput
  )
  console.log(`[smoke]   invocationId: ${invocationId}`)
  console.log()

  // Collect events
  let collected = await collectEventsUntilTerminal(
    run,
    events,
    invocationResponse.spec.process.cwd
  ).finally(() => cleanupInvocation(brokerClient, invocationId))

  // Step 9: Assertions
  console.log('[smoke] Step 9: Assertions...')
  console.log(`[smoke]   Total events collected: ${collected.collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...collected.seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${run.args.transcript}`)
  console.log()

  let failures = 0
  failures += requireEvents(collected.seenTypes, REQUIRED_EVENTS)
  failures += requireEvents(collected.seenTypes, REQUIRED_TOOL_EVENTS)

  const sensitiveValues = buildSensitiveValues(run.args.scopeRef)
  const expectedCwd = invocationResponse.spec.process.cwd
  failures += assertCommandToolCall(collected, expectedCwd, sensitiveValues)
  failures += assertTerminalTurnCompleted(collected.terminalTurnEvent)
  failures += assertIntrospectionOutput(
    collected.assistantTexts,
    'ASP_BROKER_OK',
    run.args.scopeRef,
    sensitiveValues
  )

  console.log()
  return failures
}
