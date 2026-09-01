#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'

import { createBroker } from '../harness/harness-broker/src/broker'
import { TERMINAL_TURN_TYPES, terminalsBySubmission } from './lib/admission-matrix/ledger'
import { ROW_RECIPES, resolveTmuxBin } from './lib/admission-matrix/rows'

const TIMEOUT_MS = 120_000
const artifactDir =
  process.argv[2] ?? '/Users/lherron/praesidium/var/wrkq-artifacts/T-07859/quiescence'
const marker = `T07859_Q_${Date.now().toString(36).toUpperCase()}`
const workDir = mkdtempSync('/tmp/t07859-q-')
const hookIpcDir = join(workDir, 'ipc')
mkdirSync(join(hookIpcDir, 'control'), { recursive: true })
mkdirSync(artifactDir, { recursive: true })

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(100)
  }
  return false
}

function payloadString(event: InvocationEventEnvelope, key: string): string | undefined {
  const value = (event.payload as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value : undefined
}

function blockedUnknownIds(events: InvocationEventEnvelope[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.type === 'capture.warning')
      .map((event) => {
        const raw = (event.payload as { raw?: Record<string, unknown> }).raw
        return raw?.['kind'] === 'claude.dequeue-without-user-row' &&
          typeof raw['blockedSubmissionId'] === 'string'
          ? raw['blockedSubmissionId']
          : undefined
      })
      .filter((submissionId): submissionId is string => submissionId !== undefined)
  )
}

const recipe = ROW_RECIPES['claude-code-tmux']
if (recipe === undefined) throw new Error('claude-code-tmux matrix recipe is unavailable')
const probe = recipe.probe()
if (!probe.available) throw new Error(probe.reason)

const plan = await recipe.plan({
  repoRoot: process.cwd(),
  tmuxBin: resolveTmuxBin(),
  marker,
  hookIpcDir,
  timeoutMs: TIMEOUT_MS,
})
const events: InvocationEventEnvelope[] = []
const broker = createBroker({
  drivers: [plan.driver],
  onEvent: (event) => events.push(event),
  isOperator: (principalRef) => principalRef === 'agent:cody',
})
const invocationId = plan.startRequest.spec.invocationId as InvocationId
let started = false

try {
  const hello = await broker.start(plan.startRequest, plan.dispatchEnv, plan.runtime)
  started = true
  if (plan.primingPrompt !== undefined) {
    const primed = await waitFor(() => events.some((event) => TERMINAL_TURN_TYPES.has(event.type)))
    if (!primed) throw new Error('Claude priming turn did not terminalize')
  }
  const idle = await waitFor(
    async () => (await broker.seatProbe({ invocationId })).seat.state === 'idle'
  )
  if (!idle) throw new Error('Claude seat did not become idle')

  const watermark = events.length
  const origin = {
    principalRef: 'agent:cody',
    scopeRef: 'agent:cody:project:agent-spaces:task:T-07859',
  }
  const base = await broker.invoke({
    invocationId,
    origin,
    body: `Run this exact shell command with your shell tool and nothing else: sleep 20 && printf '${marker}_BASE'. Then reply with exactly ${marker}_BASE.`,
  })
  const toolActive = await waitFor(() =>
    events.slice(watermark).some((event) => event.type === 'tool.call.started')
  )
  if (!toolActive) throw new Error('Claude base turn did not enter a tool call')
  const activeProbe = await broker.seatProbe({ invocationId })
  if (activeProbe.seat.state !== 'turn-active') {
    throw new Error(`tool call observed without an active turn: ${JSON.stringify(activeProbe)}`)
  }

  const queued = await Promise.all([
    broker.steer({
      invocationId,
      origin,
      body: `Reply with exactly ${marker}_QUEUED_1 and nothing else. Do not use tools.`,
    }),
    broker.steer({
      invocationId,
      origin,
      body: `Reply with exactly ${marker}_QUEUED_2 and nothing else. Do not use tools.`,
    }),
  ])
  const attemptedSteers = await waitFor(() =>
    queued.every((response) =>
      events.some(
        (event) =>
          event.type === 'input.accepted' &&
          payloadString(event, 'inputId') === response.submissionId &&
          (event.payload as { disposition?: unknown }).disposition === 'attempted_steer'
      )
    )
  )
  if (!attemptedSteers) {
    throw new Error('both steers did not reach attempted_steer delivery')
  }
  let maximumHarnessLocalDepth = 0
  const depthReached = await waitFor(() => {
    const depth = plan.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0
    maximumHarnessLocalDepth = Math.max(maximumHarnessLocalDepth, depth)
    return depth >= 2
  }, 15_000)
  if (!depthReached) {
    const diagnosticPath = join(artifactDir, `preempt-quiescence-${marker}-setup-failure.json`)
    writeFileSync(
      diagnosticPath,
      `${JSON.stringify(
        {
          marker,
          invocationId,
          activeProbe,
          queued,
          maximumHarnessLocalDepth,
          finalHarnessLocalDepth: plan.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0,
          events,
        },
        null,
        2
      )}\n`
    )
    throw new Error(
      `Claude harness-local queue depth never reached 2 (max ${maximumHarnessLocalDepth}, final ${plan.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0}); diagnostic ${diagnosticPath}`
    )
  }
  console.log(
    JSON.stringify({
      phase: 'queue-proven',
      invocationId,
      maximumHarnessLocalDepth,
    })
  )

  const preempt = await broker.preempt({
    invocationId,
    origin,
    body: `Reply with exactly ${marker}_PREEMPT and nothing else. Do not use tools.`,
  })
  const submissionIds = [
    base.submissionId,
    ...queued.map((response) => response.submissionId),
    preempt.submissionId,
  ]
  const settled = await waitFor(async () => {
    const runtimeEvents = events.slice(watermark)
    const terminals = terminalsBySubmission(runtimeEvents)
    const blockedUnknown = blockedUnknownIds(runtimeEvents)
    const allDispositionedOrBlocked = submissionIds.every(
      (submissionId) =>
        (terminals.get(submissionId) ?? []).length === 1 || blockedUnknown.has(submissionId)
    )
    return (
      allDispositionedOrBlocked && (await broker.seatProbe({ invocationId })).seat.state === 'idle'
    )
  })
  if (!settled) {
    const diagnosticPath = join(artifactDir, `preempt-quiescence-${marker}-settle-failure.json`)
    writeFileSync(
      diagnosticPath,
      `${JSON.stringify(
        {
          marker,
          invocationId,
          submissions: { base, queued, preempt },
          seat: await broker.seatProbe({ invocationId }),
          brokerQueue: await broker.queueList({ invocationId }),
          harnessLocalDepth: plan.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0,
          events,
        },
        null,
        2
      )}\n`
    )
    throw new Error(
      `quiescence submissions did not settle exactly once; diagnostic ${diagnosticPath}`
    )
  }

  const slice = events.slice(watermark)
  const terminals = terminalsBySubmission(slice)
  const interruptedTurns = slice.filter((event) => event.type === 'turn.interrupted')
  const completedTurns = slice.filter((event) => event.type === 'turn.completed')
  const captureWarnings = events.filter((event) => event.type === 'capture.warning')
  const blockedUnknownWarnings = captureWarnings.filter((event) => {
    const raw = (event.payload as { raw?: unknown }).raw
    return (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as { kind?: unknown }).kind === 'claude.dequeue-without-user-row'
    )
  })
  const blockedUnknownSubmissionIds = new Set(
    blockedUnknownWarnings
      .map((event) => {
        const raw = (event.payload as { raw?: Record<string, unknown> }).raw
        return typeof raw?.['blockedSubmissionId'] === 'string'
          ? raw['blockedSubmissionId']
          : undefined
      })
      .filter((submissionId): submissionId is string => submissionId !== undefined)
  )
  const otherCaptureWarnings = captureWarnings.filter(
    (event) => !blockedUnknownWarnings.includes(event)
  )
  const preemptDisposition = terminals.get(preempt.submissionId)?.[0]
  const interruptedTurnIds = new Set(
    interruptedTurns
      .map((event) => event.turnId ?? payloadString(event, 'turnId'))
      .filter((turnId): turnId is string => turnId !== undefined)
  )
  const completedTurnIds = new Set(
    completedTurns
      .map((event) => event.turnId ?? payloadString(event, 'turnId'))
      .filter((turnId): turnId is string => turnId !== undefined)
  )
  const carriedBeforePreempt = [
    base.submissionId,
    ...queued.map((response) => response.submissionId),
  ]
  const carriedTurns = carriedBeforePreempt.map((submissionId) => {
    const terminal = terminals.get(submissionId)?.[0]
    return {
      submissionId,
      disposition: terminal?.type,
      turnId: terminal === undefined ? undefined : payloadString(terminal, 'turnId'),
    }
  })
  const assertions = {
    admitted: [base, ...queued, preempt].every((response) => response.admission === 'admitted'),
    harnessLocalDepthBeforePreempt: 2,
    everySubmissionExactlyOneDisposition: submissionIds.every(
      (submissionId) => (terminals.get(submissionId) ?? []).length === 1
    ),
    everySubmissionDispositionOrBlockedUnknown: submissionIds.every(
      (submissionId) =>
        (terminals.get(submissionId) ?? []).length === 1 ||
        blockedUnknownSubmissionIds.has(submissionId)
    ),
    queuedSubmissionsExecuted: carriedTurns.every(
      (entry) =>
        entry.disposition === 'submission.executed' ||
        blockedUnknownSubmissionIds.has(entry.submissionId)
    ),
    baseAndTwoDrainsTerminalized: carriedTurns.every(
      (entry) =>
        blockedUnknownSubmissionIds.has(entry.submissionId) ||
        (entry.turnId !== undefined &&
          (interruptedTurnIds.has(entry.turnId) || completedTurnIds.has(entry.turnId)))
    ),
    interruptedTurnCount: interruptedTurnIds.size,
    boundedSlippageCompletedTurnCount: carriedTurns.filter(
      (entry) => entry.turnId !== undefined && completedTurnIds.has(entry.turnId)
    ).length,
    preemptExecutedOwnTurn: preemptDisposition?.type === 'submission.executed',
    blockedUnknownCount: blockedUnknownWarnings.length,
    otherCaptureWarnings: otherCaptureWarnings.length,
    wholeRuntimeCaptureWarnings: captureWarnings.length,
  }
  const ok =
    assertions.admitted &&
    assertions.everySubmissionDispositionOrBlockedUnknown &&
    assertions.queuedSubmissionsExecuted &&
    assertions.baseAndTwoDrainsTerminalized &&
    assertions.interruptedTurnCount >= 1 &&
    assertions.preemptExecutedOwnTurn &&
    assertions.blockedUnknownCount <= 1 &&
    assertions.otherCaptureWarnings === 0
  const artifact = {
    schema: 't07859-preempt-quiescence/v1',
    marker,
    invocationId,
    probe,
    capabilities: hello.capabilities,
    submissions: { base, queued, preempt },
    assertions,
    ok,
    events,
  }
  const artifactPath = join(artifactDir, `preempt-quiescence-${marker}.json`)
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(JSON.stringify({ ok, artifactPath, invocationId, assertions }, null, 2))
  if (!ok) process.exitCode = 1
} finally {
  if (started) {
    await broker.stop({ invocationId, reason: 'T-07859 quiescence smoke complete' }).catch(() => {})
    await broker.dispose({ invocationId }).catch(() => {})
  }
  await plan.cleanup().catch(() => {})
}
