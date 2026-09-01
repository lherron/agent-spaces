#!/usr/bin/env bun
/**
 * Broker admission conformance matrix — T-07860, contract hcs T-07843 §9.
 *
 * The FOUR submit doors x every registered driver x idle/busy seat states,
 * asserted from the BROKER EVENT LEDGER and the broker's own read models
 * (`turn.manifest`, `queue.list`, `seat.probe`) ONLY — no harness JSONL, no
 * tmux pane capture. This is a NEW, small, single-purpose harness: it
 * deliberately does not extend or reuse `scripts/pre-hrc-broker-matrix-e2e.ts`
 * (Lance, 2026-09-01).
 *
 * Rules this harness obeys:
 *   - rows are registry-driven; a new driver kind is a row automatically
 *   - a missing real dependency is a row FAILURE, never a skip
 *   - expectations DERIVE from `capabilities.admission.classes` + the §3.1
 *     class table; nothing is hand-tabulated per driver
 *   - zero `capture.warning` across the WHOLE runtime is an assertion
 *   - no UI keys are ever sent (only the driver's own `interrupt()`)
 *   - a red cell is a finding to REPORT, never something to patch here
 *
 * Usage:
 *   bun scripts/admission-matrix.ts [--row <kind>]... [--door <door>]...
 *                                   [--state <seat-state>]... [--artifact-dir <dir>]
 *                                   [--timeout-ms <n>]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationId,
  TurnId,
} from 'spaces-harness-broker-protocol'

import type { Broker } from '../harness/harness-broker/src/broker'
import { createBroker } from '../harness/harness-broker/src/broker'
import { createDriverRegistry } from '../harness/harness-broker/src/drivers/registry'
import {
  CELLS,
  DOOR_NAMES,
  type DoorName,
  SEAT_STATES,
  type SeatState,
  TTL_CELL_MS,
  basePrompt,
  expectationFor,
  isBusy,
  knock,
  submissionCount,
} from './lib/admission-matrix/doors'
import {
  type Check,
  TERMINAL_TURN_TYPES,
  type Verdict,
  checkBracketMinting,
  checkDecisionLedger,
  checkNoCaptureWarning,
  checkOneDispositionPerSubmission,
  checkTurnManifest,
  excerpt,
  forSubmissions,
  terminalsBySubmission,
  verdictOf,
} from './lib/admission-matrix/ledger'
import {
  NOOP_DRIVER_KIND,
  type PlanContext,
  ROW_RECIPES,
  buildMatrixDrivers,
  resolveTmuxBin,
} from './lib/admission-matrix/rows'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Let an interactive TUI return to its composer after the launch priming turn. */
const BOOT_SETTLE_MS = 2_000
/** How long every submission of a cell has to reach a terminal disposition. */
const DISPOSITION_TIMEOUT_MS = 90_000
/** Post-quiescence settle so a late own-turn resolution is not missed. */
const CELL_SETTLE_MS = 3_000
/** Principal the matrix submits as. Operator authority so `preempt` is admitted. */
const MATRIX_PRINCIPAL = 'agent:clod'

type Args = {
  rows: string[]
  doors: DoorName[]
  states: SeatState[]
  artifactDir?: string | undefined
  timeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rows: [], doors: [], states: [], timeoutMs: 180_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    const need = (): string => {
      if (value === undefined) throw new Error(`${flag} requires a value`)
      i += 1
      return value
    }
    switch (flag) {
      case '--row':
        args.rows.push(need())
        break
      case '--door':
        args.doors.push(need() as DoorName)
        break
      case '--state':
        args.states.push(need() as SeatState)
        break
      case '--artifact-dir':
        args.artifactDir = need()
        break
      case '--timeout-ms':
        args.timeoutMs = Number(need())
        break
      case '--help':
        console.log(
          [
            'bun scripts/admission-matrix.ts [options]',
            '  --row <driver-kind>    Restrict to one registered driver kind (repeatable)',
            `  --door <door>          Restrict to one door: ${DOOR_NAMES.join(' | ')} (repeatable)`,
            `  --state <seat-state>   Restrict to one seat state: ${SEAT_STATES.join(' | ')} (repeatable)`,
            '  --artifact-dir <dir>   Where the JSON artifact is written',
            '  --timeout-ms <n>       Per-wait timeout (default 180000)',
          ].join('\n')
        )
        process.exit(0)
        break
      default:
        throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

type CellResult = {
  door: DoorName
  state: SeatState
  verdict: Verdict
  expectation: string
  submissions: unknown[]
  queueListWhileBusy?: unknown
  checks: Check[]
  ledgerSlice: unknown[]
  durationMs: number
}

type RowResult = {
  kind: string
  version: string
  probe: { available: boolean; reason: string }
  compile?: Record<string, unknown> | undefined
  capabilities?: unknown
  cells: CellResult[]
  /** Ledger tail, so a boot/settle failure is diagnosable from the artifact alone. */
  eventTail: unknown[]
  errors: string[]
  status: 'OK' | 'FAIL'
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(200)
  }
  return false
}

function openTurnIds(events: InvocationEventEnvelope[]): string[] {
  const open = new Set<string>()
  for (const event of events) {
    const turnId = (event.payload as { turnId?: unknown } | undefined)?.turnId
    if (typeof turnId !== 'string') continue
    if (event.type === 'turn.started') open.add(turnId)
    if (TERMINAL_TURN_TYPES.has(event.type)) open.delete(turnId)
  }
  return [...open]
}

async function waitForIdle(
  broker: Broker,
  invocationId: InvocationId,
  events: InvocationEventEnvelope[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await broker.seatProbe({ invocationId })
    if (
      probe.seat.state === 'idle' &&
      probe.brokerHeldDepth === 0 &&
      openTurnIds(events).length === 0
    ) {
      return true
    }
    if (probe.seat.state === 'terminal') return false
    await Bun.sleep(250)
  }
  return false
}

async function waitForTurnActive(
  broker: Broker,
  invocationId: InvocationId,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await broker.seatProbe({ invocationId })).seat.state === 'turn-active') return true
    await Bun.sleep(200)
  }
  return false
}

/** Recover a busy seat with the driver's own capability-gated interrupt — never a UI key. */
async function recoverToIdle(
  broker: Broker,
  invocationId: InvocationId,
  events: InvocationEventEnvelope[],
  timeoutMs: number
): Promise<void> {
  if (await waitForIdle(broker, invocationId, events, 5_000)) return
  await broker
    .interrupt({ invocationId, scope: 'turn', reason: 'admission-matrix-cell-recovery' })
    .catch(() => undefined)
  await waitForIdle(broker, invocationId, events, timeoutMs)
}

/** Ask the broker for the manifest of every turn the slice touched. */
async function collectManifests(
  broker: Broker,
  invocationId: InvocationId,
  slice: InvocationEventEnvelope[]
): Promise<Map<string, readonly string[]>> {
  const turnIds = new Set<string>()
  for (const event of slice) {
    const turnId = (event.payload as { turnId?: unknown } | undefined)?.turnId
    if (typeof turnId === 'string') turnIds.add(turnId)
  }
  const manifests = new Map<string, readonly string[]>()
  for (const turnId of turnIds) {
    try {
      const manifest = await broker.turnManifest({ invocationId, turnId: turnId as TurnId })
      manifests.set(turnId, manifest.submissionIds)
    } catch {
      // A turn the broker does not know is itself the finding; leave it absent
      // so checkTurnManifest reports it against the ledger.
    }
  }
  return manifests
}

// ---------------------------------------------------------------------------
// One cell: arm the seat state, knock on the door, settle, assert
// ---------------------------------------------------------------------------

async function runCell(input: {
  broker: Broker
  invocationId: InvocationId
  events: InvocationEventEnvelope[]
  door: DoorName
  state: SeatState
  ctx: PlanContext
  capabilities: InvocationCapabilities
}): Promise<CellResult> {
  const { broker, invocationId, events, door, state, ctx, capabilities } = input
  const startedAt = Date.now()
  const cellMarker = `AM_${door}_${state}_${ctx.marker}`.replace(/-/g, '_').toUpperCase()
  const checks: Check[] = []
  const expectation = expectationFor(door, state, capabilities)

  // 1. Arm the seat state. The base turn goes through `invoke` — the exclusive
  //    door — so even the fixture traffic obeys the four-door rule.
  const base = basePrompt(state, cellMarker)
  if (base !== undefined) {
    await knock('invoke', broker, { invocationId, body: base, principalRef: MATRIX_PRINCIPAL })
    const armed =
      state === 'busy-generating'
        ? await waitForTurnActive(broker, invocationId, ctx.timeoutMs)
        : await waitFor(
            () => events.some((event) => event.type === 'tool.call.started'),
            ctx.timeoutMs
          )
    if (!armed) {
      return {
        door,
        state,
        verdict: 'FAIL',
        expectation: expectation.kind,
        submissions: [],
        checks: [
          {
            id: 'seat-state-armed',
            ok: false,
            detail: `seat never reached ${state}`,
            evidence: excerpt(events.slice(-24)),
          },
        ],
        ledgerSlice: excerpt(events.slice(-24)),
        durationMs: Date.now() - startedAt,
      }
    }
  }

  // 2. Knock on the door — once, or three times for the FIFO cell.
  const watermark = events.length
  const outcomes = []
  for (let i = 0; i < submissionCount(state); i += 1) {
    outcomes.push(
      await knock(door, broker, {
        invocationId,
        body: `Reply with exactly ${cellMarker}_${i + 1} and nothing else. Do not use any tools.`,
        principalRef: MATRIX_PRINCIPAL,
        ...(state === 'busy-ttl' ? { ttlMs: TTL_CELL_MS } : {}),
      })
    )
  }
  const submissionIds = outcomes
    .map((outcome) => (outcome.admitted ? outcome.response.submissionId : outcome.submissionId))
    .filter((id): id is string => id !== undefined)
  const admittedIds = outcomes
    .filter((outcome) => outcome.admitted)
    .map((outcome) => (outcome as { response: { submissionId: string } }).response.submissionId)

  // While the seat is still busy, the broker-held queue must be observable (§6).
  let queueListWhileBusy: unknown
  if (door === 'enqueue' && isBusy(state)) {
    queueListWhileBusy = (await broker.queueList({ invocationId })).entries
  }

  // 3. Settle: every submission owes a terminal disposition (§3.2), so wait for
  //    exactly that, then let the seat quiesce.
  await waitFor(() => {
    const terminals = terminalsBySubmission(events.slice(watermark))
    return submissionIds.every((id) => (terminals.get(id) ?? []).length > 0)
  }, DISPOSITION_TIMEOUT_MS)
  await waitForIdle(broker, invocationId, events, ctx.timeoutMs)
  await Bun.sleep(CELL_SETTLE_MS)
  await waitForIdle(broker, invocationId, events, ctx.timeoutMs)
  const slice = events.slice(watermark)
  const terminals = terminalsBySubmission(slice)
  const terminalTypeOf = (id: string): string | undefined => terminals.get(id)?.[0]?.type
  const turnOf = (id: string): string | undefined => {
    const event = terminals.get(id)?.[0]
    const turnId = (event?.payload as { turnId?: unknown } | undefined)?.turnId
    return typeof turnId === 'string' ? turnId : undefined
  }

  // 4. Assert — ledger and broker read models only.
  let rejected = false
  switch (expectation.kind) {
    case 'typed-rejection':
    case 'rejected-busy': {
      rejected = true
      const layer = expectation.kind === 'rejected-busy' ? 'state' : 'capability'
      const decision = slice.find((event) => event.type === 'admission.rejected')
      const decisionLayer = (decision?.payload as { layer?: unknown } | undefined)?.layer
      checks.push({
        id: 'typed-rejection',
        ok:
          outcomes.every((outcome) => !outcome.admitted) &&
          decision !== undefined &&
          decisionLayer === layer,
        detail: outcomes.some((outcome) => outcome.admitted)
          ? `expected a typed rejection but the door admitted: ${JSON.stringify(outcomes)}`
          : `rejected; admission.rejected layer=${String(decisionLayer)} (expected '${layer}'), reason=${String((decision?.payload as { reason?: unknown } | undefined)?.reason)}`,
        evidence: excerpt(slice.filter((event) => event.type.startsWith('admission.'))),
      })
      break
    }
    case 'own-turn': {
      checks.push(...ownTurnChecks(outcomes, submissionIds, terminalTypeOf, slice, cellMarker))
      break
    }
    case 'absorbed-or-executed': {
      const observed = submissionIds.map(terminalTypeOf)
      checks.push({
        id: 'steer-dual-resolution',
        ok: observed.every(
          (type) => type === 'submission.absorbed' || type === 'submission.executed'
        ),
        detail: `dispositions: ${observed.map((type) => String(type)).join(', ')} (§3.1 accepts absorbed OR executed)`,
        evidence: observed.every(
          (type) => type === 'submission.absorbed' || type === 'submission.executed'
        )
          ? undefined
          : excerpt(slice),
      })
      break
    }
    case 'held-then-own-turn': {
      const enqueued = slice.filter((event) => event.type === 'queue.enqueued')
      checks.push({
        id: 'broker-held',
        ok: admittedIds.every((id) =>
          enqueued.some(
            (event) => (event.payload as { submissionId?: unknown }).submissionId === id
          )
        ),
        detail: `${enqueued.length} queue.enqueued for ${admittedIds.length} admitted submission(s)`,
        evidence: excerpt(enqueued),
      })
      if (isBusy(state)) {
        const held = (queueListWhileBusy ?? []) as Array<{ submissionId?: string }>
        checks.push({
          id: 'queue-list-visible',
          ok: admittedIds.every((id) => held.some((entry) => entry.submissionId === id)),
          detail: `queue.list while busy reported ${held.length} held entry/entries`,
          evidence: queueListWhileBusy,
        })
      }
      const executedTurns = submissionIds.map(turnOf)
      const allExecuted = submissionIds.every((id) => terminalTypeOf(id) === 'submission.executed')
      const distinct = new Set(executedTurns.filter((id): id is string => id !== undefined))
      checks.push({
        id: 'own-turn-each',
        ok: allExecuted && distinct.size === submissionIds.length,
        detail: `${submissionIds.length} submission(s) -> ${distinct.size} distinct turn(s); dispositions ${submissionIds.map((id) => String(terminalTypeOf(id))).join(', ')}`,
        evidence:
          allExecuted && distinct.size === submissionIds.length ? undefined : excerpt(slice),
      })
      if (submissionIds.length > 1) {
        const order = slice
          .filter((event) => event.type === 'submission.executed')
          .map((event) => (event.payload as { submissionId?: unknown }).submissionId)
          .filter((id): id is string => typeof id === 'string' && submissionIds.includes(id))
        checks.push({
          id: 'fifo-order',
          ok: JSON.stringify(order) === JSON.stringify(submissionIds),
          detail: `executed order ${JSON.stringify(order)} vs submitted order ${JSON.stringify(submissionIds)}`,
        })
      }
      break
    }
    case 'expired': {
      const expired = slice.filter((event) => event.type === 'submission.expired')
      const queueExpired = slice.filter((event) => event.type === 'queue.expired')
      checks.push({
        id: 'ttl-expiry',
        ok:
          submissionIds.every((id) => terminalTypeOf(id) === 'submission.expired') &&
          queueExpired.length > 0,
        detail: `submission.expired=${expired.length} queue.expired=${queueExpired.length}; dispositions ${submissionIds.map((id) => String(terminalTypeOf(id))).join(', ')}`,
        evidence: expired.length > 0 ? undefined : excerpt(slice),
      })
      break
    }
    case 'preempt-then-own-turn': {
      const requestedInterrupt = slice.filter((event) => event.type === 'interrupt.requested')
      const landed = slice.filter((event) => event.type === 'interrupt.landed')
      checks.push({
        id: 'interrupt-recorded',
        ok: requestedInterrupt.length > 0 && landed.length > 0,
        detail: `interrupt.requested=${requestedInterrupt.length} interrupt.landed=${landed.length}`,
        evidence:
          requestedInterrupt.length > 0 && landed.length > 0
            ? undefined
            : excerpt(slice.filter((event) => event.type.startsWith('interrupt.'))),
      })
      // §3.1 bounded-slippage clause: a drained turn that completed before the
      // interrupt key landed is recorded `completed`, and that is truth, not a
      // failure. So the requirement is that the live turn TERMINALIZED, with
      // the interrupted/completed split reported rather than demanded.
      const interrupted = slice.filter((event) => event.type === 'turn.interrupted')
      const completed = slice.filter((event) => event.type === 'turn.completed')
      checks.push({
        id: 'live-turn-terminalized',
        ok: interrupted.length + completed.length > 0,
        detail: `turn.interrupted=${interrupted.length} turn.completed=${completed.length} (${expectation.mode} mode; bounded slippage tolerated)`,
        evidence: interrupted.length + completed.length > 0 ? undefined : excerpt(slice),
      })
      checks.push(...ownTurnChecks(outcomes, submissionIds, terminalTypeOf, slice, cellMarker))
      break
    }
  }

  // Shared §9 assertions.
  checks.push(checkDecisionLedger(slice, submissionIds))
  checks.push(checkOneDispositionPerSubmission(slice, submissionIds))
  checks.push(
    checkBracketMinting(
      slice,
      capabilities.bracketMintingMode,
      submissionIds
        .filter((id) => terminalTypeOf(id) === 'submission.executed')
        .map(turnOf)
        .filter((id): id is string => id !== undefined)
    )
  )
  checks.push(checkTurnManifest(slice, await collectManifests(broker, invocationId, slice)))

  return {
    door,
    state,
    verdict: verdictOf(checks, rejected),
    expectation: expectation.kind,
    submissions: outcomes,
    ...(queueListWhileBusy !== undefined ? { queueListWhileBusy } : {}),
    checks,
    ledgerSlice: excerpt(forSubmissions(slice, submissionIds).concat(slice), 70),
    durationMs: Date.now() - startedAt,
  }
}

/** Own-turn shape: admitted, executed, bracketed, and carrying THIS cell's text. */
function ownTurnChecks(
  outcomes: Array<{ admitted: boolean }>,
  submissionIds: readonly string[],
  terminalTypeOf: (id: string) => string | undefined,
  slice: InvocationEventEnvelope[],
  cellMarker: string
): Check[] {
  const executed = submissionIds.filter((id) => terminalTypeOf(id) === 'submission.executed')
  // Correlation: the asserted turn must be THIS door call's turn. Without it a
  // cell that races an unrelated turn (a launch priming prompt, a leftover
  // drain) reports a green on someone else's evidence.
  const carried = slice.filter(
    (event) =>
      (event.type === 'user.message' || event.type === 'assistant.message.completed') &&
      JSON.stringify(event.payload ?? {}).includes(cellMarker)
  )
  return [
    {
      id: 'own-turn-admitted',
      ok: outcomes.every((outcome) => outcome.admitted) && executed.length === submissionIds.length,
      detail: `admitted=${outcomes.every((outcome) => outcome.admitted)}; dispositions ${submissionIds.map((id) => String(terminalTypeOf(id))).join(', ')}`,
      evidence:
        outcomes.every((outcome) => outcome.admitted) && executed.length === submissionIds.length
          ? undefined
          : excerpt(slice),
    },
    {
      id: 'own-turn-correlation',
      ok: carried.length > 0,
      detail:
        carried.length > 0
          ? `door submission text observed on ${carried.length} ledger event(s) of the asserted turn`
          : `no ledger event of the asserted turn carries this cell's submission (${cellMarker})`,
      evidence: carried.length > 0 ? undefined : excerpt(slice),
    },
  ]
}

// ---------------------------------------------------------------------------
// One row = one seat carrying every selected cell in sequence
// ---------------------------------------------------------------------------

async function runRow(input: {
  kind: string
  cells: ReadonlyArray<{ door: DoorName; state: SeatState }>
  ctx: PlanContext
  row: RowResult
}): Promise<void> {
  const { kind, ctx, row } = input
  const recipe = ROW_RECIPES[kind]
  if (recipe === undefined) throw new Error(`no recipe for registered driver kind '${kind}'`)
  const plan = await recipe.plan(ctx)
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [plan.driver],
    onEvent: (event) => events.push(event),
    // Operator authority: `preempt` is granted by authority, never by policy
    // (§5 layer 3). The matrix submits as the operator so the preempt column
    // tests the CLASS rather than the authority check.
    isOperator: (principalRef) => principalRef === MATRIX_PRINCIPAL,
  })
  const invocationId = plan.startRequest.spec.invocationId as InvocationId
  let started = false
  try {
    row.compile = plan.compile
    const startResponse = await broker.start(plan.startRequest, plan.dispatchEnv, plan.runtime)
    started = true
    row.capabilities = startResponse.capabilities

    const alive = await waitFor(
      () =>
        events.some(
          (event) => event.type === 'invocation.ready' || event.type === 'harness.started'
        ),
      ctx.timeoutMs
    )
    if (!alive) throw new Error('seat never reported invocation.ready / harness.started')
    // The compiled launch shape submits a priming prompt via argv, so the seat
    // is NOT idle just because no turn bracket has been observed yet: on an
    // evidence-minting driver the priming bracket arrives only once the TUI's
    // hook fires. Gate the first cell on the priming turn's TERMINAL, or the
    // first cell knocks into a seat that is about to become busy and asserts
    // against the priming turn instead of its own submission.
    if (plan.primingPrompt !== undefined) {
      const primed = await waitFor(
        () => events.some((event) => TERMINAL_TURN_TYPES.has(event.type)),
        ctx.timeoutMs
      )
      if (!primed) throw new Error('launch priming turn never terminalized')
    }
    if (!(await waitForIdle(broker, invocationId, events, ctx.timeoutMs))) {
      throw new Error('seat never reached idle after boot')
    }
    await Bun.sleep(BOOT_SETTLE_MS)

    for (const cell of input.cells) {
      const result = await runCell({
        broker,
        invocationId,
        events,
        door: cell.door,
        state: cell.state,
        ctx,
        capabilities: startResponse.capabilities,
      })
      row.cells.push(result)
      console.log(
        `  ${kind} ${cell.door}/${cell.state}: ${result.verdict} (${result.durationMs}ms)`
      )
      for (const check of result.checks.filter((candidate) => !candidate.ok)) {
        console.log(`      x ${check.id}: ${check.detail}`)
      }
      // Recover to idle between cells so one cell never contaminates the next.
      await recoverToIdle(broker, invocationId, events, ctx.timeoutMs)
    }

    // §9 assertion 8 is a RUNTIME-wide fact, so it is evaluated over the whole
    // seat lifetime and attributed to every cell this seat carried.
    const runtimeWide = checkNoCaptureWarning(events)
    for (const result of row.cells) {
      result.checks.push(runtimeWide)
      result.verdict = verdictOf(result.checks, result.verdict === 'REJECT-OK')
    }
    if (!runtimeWide.ok) console.log(`      x ${runtimeWide.id}: ${runtimeWide.detail}`)
  } finally {
    row.eventTail = excerpt(events.slice(-60), 60)
    if (started) {
      await broker
        .stop({ invocationId, reason: 'admission-matrix-teardown' })
        .catch(() => undefined)
      await broker.dispose({ invocationId }).catch(() => undefined)
    }
    await plan.cleanup().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CELL_GLYPH: Record<Verdict, string> = { PASS: 'PASS', FAIL: 'FAIL', 'REJECT-OK': 'REJ-OK' }

function renderTable(
  rows: RowResult[],
  cells: ReadonlyArray<{ door: DoorName; state: SeatState }>
): string {
  const headers = ['driver kind', ...cells.map((cell) => `${cell.door}/${cell.state}`)]
  const body = rows.map((row) => [
    row.kind,
    ...cells.map((cell) => {
      const match = row.cells.find(
        (candidate) => candidate.door === cell.door && candidate.state === cell.state
      )
      if (match === undefined) return row.probe.available ? 'ERR' : 'DEP-FAIL'
      return CELL_GLYPH[match.verdict]
    }),
  ])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((line) => (line[index] ?? '').length))
  )
  const line = (columns: string[]): string =>
    columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join('  ')
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join(
    '\n'
  )
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const marker = `T07860_${Date.now().toString(36).toUpperCase()}`
  // `/tmp` (not the per-user tmpdir) so hook sockets bound under it stay inside
  // the unix socket path budget.
  const workDir = mkdtempSync(join('/tmp', 'am-'))
  const hookIpcDir = join(workDir, 'ipc')
  const controlDir = join(hookIpcDir, 'control')
  mkdirSync(controlDir, { recursive: true })
  const artifactDir = args.artifactDir ?? join(workDir, 'artifacts')
  mkdirSync(artifactDir, { recursive: true })
  const ctx: PlanContext = {
    repoRoot,
    tmuxBin: resolveTmuxBin(),
    marker,
    hookIpcDir,
    timeoutMs: args.timeoutMs,
  }

  // Rows are REGISTRY-DRIVEN. `noop-driver` is the only exclusion.
  const drivers = buildMatrixDrivers(hookIpcDir, controlDir)
  const summaries = createDriverRegistry(drivers)
    .summaries()
    .filter((summary) => summary.kind !== NOOP_DRIVER_KIND)
    .filter((summary) => args.rows.length === 0 || args.rows.includes(summary.kind))

  const selectedCells = CELLS.filter(
    (cell) =>
      (args.doors.length === 0 || args.doors.includes(cell.door)) &&
      (args.states.length === 0 || args.states.includes(cell.state))
  )

  console.log(`admission matrix ${marker}`)
  console.log(`repo       ${repoRoot}`)
  console.log(`rows       ${summaries.map((summary) => summary.kind).join(', ')}`)
  console.log(`cells      ${selectedCells.map((cell) => `${cell.door}/${cell.state}`).join(', ')}`)
  console.log(`artifacts  ${artifactDir}`)
  console.log('')

  const startedAt = Date.now()
  const rows: RowResult[] = []
  for (const summary of summaries) {
    const row: RowResult = {
      kind: summary.kind,
      version: summary.version,
      probe: { available: false, reason: 'not probed' },
      cells: [],
      eventTail: [],
      errors: [],
      status: 'FAIL',
    }
    rows.push(row)

    const recipe = ROW_RECIPES[summary.kind]
    if (recipe === undefined) {
      row.probe = {
        available: false,
        reason:
          'registered driver kind has no matrix recipe (add one to scripts/lib/admission-matrix/rows.ts)',
      }
      row.errors.push('no_recipe')
      console.log(`ROW ${summary.kind}: FAIL — ${row.probe.reason}`)
      continue
    }
    row.probe = recipe.probe()
    console.log(
      `ROW ${summary.kind}: probe ${row.probe.available ? 'OK' : 'MISSING'} — ${row.probe.reason}`
    )
    if (!row.probe.available) {
      // Standing rule: a missing real dependency is a row FAILURE, never a skip.
      row.errors.push(`dependency_missing: ${row.probe.reason}`)
      continue
    }

    try {
      await runRow({ kind: summary.kind, cells: selectedCells, ctx, row })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      row.errors.push(message)
      console.log(`  ${summary.kind}: ERROR — ${message}`)
    }
    row.status =
      row.errors.length === 0 &&
      row.cells.length === selectedCells.length &&
      row.cells.every((cell) => cell.verdict !== 'FAIL')
        ? 'OK'
        : 'FAIL'
  }

  const table = renderTable(rows, selectedCells)
  const artifactPath = join(artifactDir, `admission-matrix-${marker}.json`)
  writeFileSync(
    artifactPath,
    `${JSON.stringify(
      {
        schema: 'admission-matrix/v2',
        taskId: 'T-07860',
        contract: 'hcs T-07843 rev 7 §9 (four doors)',
        landing: 2,
        marker,
        host: hostname(),
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        cells: selectedCells,
        rows,
        table,
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  console.log('')
  console.log(table)
  console.log('')
  console.log(`artifact: ${artifactPath}`)

  const failed = rows.filter((row) => row.status !== 'OK')
  if (failed.length > 0) {
    console.log(`\n${failed.length} row(s) FAILED: ${failed.map((row) => row.kind).join(', ')}`)
    process.exit(1)
  }
  console.log('\nall rows OK')
}

await main()
