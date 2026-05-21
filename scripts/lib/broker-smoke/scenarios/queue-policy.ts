/**
 * Queue-policy smoke scenario: tests FIFO queue and none-queue input policies.
 *
 * Runs TWO parameterized sub-runs (fifo + none) from the same scenario config.
 * The probe table is defined ONCE and consumed by both the runner (to send probes)
 * and the assertions (to verify results). This is the single-source-of-truth
 * requirement from the review.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createAgentSpacesClient } from '../../../../packages/agent-spaces/src/index.ts'
import type { BuildHarnessBrokerInvocationRequest } from '../../../../packages/agent-spaces/src/index.ts'
import { validateInvocationStartRequest } from '../../../../packages/harness-broker-protocol/src/schemas.ts'
import type { BrokerClient } from '../../../../packages/harness-broker-client/src/index.ts'

import {
  assertFifoProbes,
  assertIntrospectionOutput,
  assertNoneProbe,
  assertTerminalTurnCompleted,
  buildSensitiveValues,
  check,
} from '../assertions.ts'
import {
  collectEventsUntilTerminal,
  cleanupInvocation,
  sendBusyProbe,
} from '../event-collector.ts'
import {
  assertInitialInputStartsWithPriming,
  buildPlacement,
  expectedExpandedPrimingPrompt,
} from '../placement.ts'
import type { CollectedRun, ProbeResult, ProbeSpec, ScenarioRun } from '../types.ts'

// ---------------------------------------------------------------------------
// Single-source probe tables
// ---------------------------------------------------------------------------

/**
 * FIFO probe table — the ONE definition consumed by both runner and assertions.
 * Do NOT duplicate this. The runner reads it to fire probes; assertFifoProbes
 * reads it to verify results.
 */
export const FIFO_PROBES: readonly ProbeSpec[] = [
  { label: 'A reject', inputId: 'queue_policy_probe_reject', whenBusy: 'reject' },
  {
    label: 'B queue',
    inputId: 'queue_policy_probe_queue',
    whenBusy: 'queue',
    text: 'Reply with exactly this single token: DRAIN_OK',
  },
  {
    label: 'C interrupt_then_apply',
    inputId: 'queue_policy_probe_interrupt',
    whenBusy: 'interrupt_then_apply',
    expectedReason: 'unsupported_busy_policy',
  },
] as const

/**
 * None-mode probe — single probe for the inputQueue=none sub-run.
 */
export const NONE_PROBE: ProbeSpec = {
  label: 'B2 queue none',
  inputId: 'queue_policy_probe_queue_none',
  whenBusy: 'queue',
  expectedReason: 'queue_not_supported',
}

// ---------------------------------------------------------------------------
// Invocation builder (shared by fifo and none sub-runs)
// ---------------------------------------------------------------------------

async function buildQueuePolicyInvocation(
  run: ScenarioRun,
  inputQueueOverride: 'fifo' | 'none'
) {
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
    interaction: { inputQueue: inputQueueOverride },
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

  console.log('[smoke] Step 3: Validating InvocationStartRequest...')
  validateInvocationStartRequest(invocationResponse.startRequest)
  console.log('[smoke]   Validation passed.')
  console.log()

  return { placement, invocationResponse }
}

// ---------------------------------------------------------------------------
// Sub-run helpers
// ---------------------------------------------------------------------------

function subRunArgs(run: ScenarioRun, suffix: string): ScenarioRun {
  return {
    ...run,
    args: {
      ...run.args,
      invocationId: `${run.args.invocationId}-${suffix}`,
      transcript: run.args.transcript.endsWith('.jsonl')
        ? run.args.transcript.replace(/\.jsonl$/, `-${suffix}.jsonl`)
        : `${run.args.transcript}-${suffix}`,
    },
  }
}

// ---------------------------------------------------------------------------
// FIFO sub-run
// ---------------------------------------------------------------------------

async function runFifoSubRun(
  brokerClient: BrokerClient,
  run: ScenarioRun
): Promise<{ failures: number }> {
  const fifoRun = subRunArgs(run, 'fifo')
  const { invocationResponse } = await buildQueuePolicyInvocation(fifoRun, 'fifo')

  console.log('[smoke] Step 6: Starting FIFO invocation (with initialInput)...')
  const { invocationId, events } = await brokerClient.startInvocation(
    invocationResponse.startRequest.spec,
    invocationResponse.startRequest.initialInput
  )
  const status = await brokerClient.status({ invocationId })
  console.log(`[smoke]   invocationId: ${invocationId}`)
  console.log(`[smoke]   capabilities.input.queue: ${status.capabilities.input.queue}`)
  console.log()

  // Fire probes on turn.started — uses FIFO_PROBES (single source)
  let probePromise: Promise<ProbeResult[]> | undefined
  const fireProbes = () => {
    console.log('[smoke]   turn.started observed; firing busy-input probes...')
    probePromise = Promise.all(
      FIFO_PROBES.map((probe) => sendBusyProbe(brokerClient, invocationId, probe))
    )
  }

  let collected: CollectedRun | undefined
  try {
    collected = await collectEventsUntilTerminal(
      fifoRun,
      events,
      invocationResponse.spec.process.cwd,
      fireProbes,
      2
    )
  } finally {
    await cleanupInvocation(brokerClient, invocationId)
  }
  if (!collected) {
    throw new Error('Queue-policy scenario did not collect events')
  }

  const probeResults = probePromise ? await probePromise : undefined

  // Assertions
  console.log('[smoke] Step 9: Queue-policy FIFO assertions...')
  console.log(`[smoke]   Total events collected: ${collected.collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...collected.seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${fifoRun.args.transcript}`)
  console.log()

  let failures = 0
  failures += check(
    status.capabilities.input.queue === true,
    'capabilities.input.queue is true',
    `capabilities.input.queue expected true, got ${JSON.stringify(status.capabilities.input.queue)}`
  )
  failures += check(
    collected.seenTypes.has('turn.started'),
    'holder turn started before busy-input probes',
    'MISSING: holder turn.started'
  )

  // Assert probes using the SAME FIFO_PROBES table (single source)
  failures += assertFifoProbes(collected, FIFO_PROBES, probeResults)

  failures += check(
    collected.terminalTurnEvents.length >= 2,
    'observed holder and drained terminal turn events',
    `expected 2 terminal turn events, saw ${collected.terminalTurnEvents.length}`
  )

  for (const [index, terminal] of collected.terminalTurnEvents.entries()) {
    if (terminal.type === 'turn.completed') {
      const payload = terminal.payload as Record<string, unknown> | undefined
      console.log(
        `[smoke]   \u2713 turn ${index + 1} completed (turnId: ${payload?.['turnId'] ?? 'n/a'})`
      )
    } else {
      console.error(
        `[smoke]   \u2717 turn ${index + 1} terminal event is ${terminal.type}, expected turn.completed`
      )
      failures++
    }
  }

  const sensitiveValues = buildSensitiveValues(fifoRun.args.scopeRef)
  failures += assertIntrospectionOutput(
    collected.assistantTexts,
    'QUEUE_HOLDER_OK',
    fifoRun.args.scopeRef,
    sensitiveValues
  )

  console.log()
  return { failures }
}

// ---------------------------------------------------------------------------
// None sub-run
// ---------------------------------------------------------------------------

async function runNoneSubRun(
  brokerClient: BrokerClient,
  run: ScenarioRun
): Promise<{ failures: number }> {
  const noneRun = subRunArgs(run, 'none')
  const { invocationResponse } = await buildQueuePolicyInvocation(noneRun, 'none')

  console.log('[smoke] Step 6b: Starting inputQueue=none invocation (with initialInput)...')
  const { invocationId, events } = await brokerClient.startInvocation(
    invocationResponse.startRequest.spec,
    invocationResponse.startRequest.initialInput
  )
  const status = await brokerClient.status({ invocationId })
  console.log(`[smoke]   invocationId: ${invocationId}`)
  console.log(`[smoke]   capabilities.input.queue: ${status.capabilities.input.queue}`)
  console.log()

  // Fire none probe on turn.started — uses NONE_PROBE (single source)
  let probePromise: Promise<ProbeResult[]> | undefined
  const fireNoneProbe = () => {
    console.log('[smoke]   turn.started observed; firing inputQueue=none busy-input probe...')
    probePromise = Promise.all([sendBusyProbe(brokerClient, invocationId, NONE_PROBE)])
  }

  let collected: CollectedRun | undefined
  try {
    collected = await collectEventsUntilTerminal(
      noneRun,
      events,
      invocationResponse.spec.process.cwd,
      fireNoneProbe
    )
  } finally {
    await cleanupInvocation(brokerClient, invocationId)
  }
  if (!collected) {
    throw new Error('Queue-policy inputQueue=none scenario did not collect events')
  }

  const probeResults = probePromise ? await probePromise : undefined

  // Assertions
  console.log('[smoke] Step 10: Queue-policy none assertions...')
  console.log(`[smoke]   Total events collected: ${collected.collectedEvents.length}`)
  console.log(`[smoke]   Unique event types seen: ${[...collected.seenTypes].join(', ')}`)
  console.log(`[smoke]   Transcript: ${noneRun.args.transcript}`)
  console.log()

  let failures = 0
  failures += check(
    status.capabilities.input.queue === false,
    'capabilities.input.queue is false',
    `capabilities.input.queue expected false, got ${JSON.stringify(status.capabilities.input.queue)}`
  )

  // Assert probe using the SAME NONE_PROBE (single source)
  failures += assertNoneProbe(collected, NONE_PROBE, probeResults)

  failures += assertTerminalTurnCompleted(collected.terminalTurnEvent)

  console.log()
  return { failures }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runQueuePolicyScenario(
  brokerClient: BrokerClient,
  run: ScenarioRun
): Promise<number> {
  const fifoResult = await runFifoSubRun(brokerClient, run)
  const noneResult = await runNoneSubRun(brokerClient, run)
  return fifoResult.failures + noneResult.failures
}
