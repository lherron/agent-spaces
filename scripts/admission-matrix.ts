#!/usr/bin/env bun
/**
 * Broker admission conformance matrix — T-07860, contract hcs T-07843 §9.
 *
 * Four submit doors × every registered driver × idle/busy seat states, asserted
 * from the BROKER EVENT LEDGER ONLY. This is a NEW, small, single-purpose
 * harness: it deliberately does not extend or reuse
 * `scripts/pre-hrc-broker-matrix-e2e.ts` (Lance, 2026-09-01).
 *
 * Landing 1 (this file today) runs the two columns the current protocol can
 * express — `input` (idle own-turn) and `steer` (`whenBusy: 'steer'`). Landing 2
 * swaps `scripts/lib/admission-matrix/doors.ts` onto the four real admission
 * methods once T-07859 publishes; the row machinery and the assertion engine do
 * not change.
 *
 * Rules this harness obeys:
 *   - rows are registry-driven; a new driver kind is a row automatically
 *   - a missing real dependency is a row FAILURE, never a skip
 *   - zero `capture.warning` across the WHOLE runtime is an assertion
 *   - no UI keys are ever sent (only the driver's own `interrupt()`)
 *   - a red cell is a finding to REPORT, never something to patch here
 *
 * Usage:
 *   bun scripts/admission-matrix.ts [--row <kind>]... [--door <door>]...
 *                                   [--state <seat-state>]... [--artifact-dir <dir>]
 *                                   [--timeout-ms <n>] [--keep-artifacts]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationId,
  InvocationInput,
} from 'spaces-harness-broker-protocol'

import type { Broker } from '../harness/harness-broker/src/broker'
import { createBroker } from '../harness/harness-broker/src/broker'
import type { BracketMintingMode } from '../harness/harness-broker/src/drivers/driver'
import { createDriverRegistry } from '../harness/harness-broker/src/drivers/registry'
import {
  CELLS,
  DOOR_NAMES,
  type DoorName,
  SEAT_STATES,
  type SeatState,
  basePrompt,
  expectationFor,
  knock,
} from './lib/admission-matrix/doors'
import {
  type Check,
  TERMINAL_TURN_TYPES,
  type Verdict,
  checkBracketMinting,
  checkNoCaptureWarning,
  checkOneDispositionPerSubmission,
  checkTurnManifest,
  excerpt,
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
/** How long a delivered own-turn submission has to produce its turn bracket. */
const TURN_BRACKET_TIMEOUT_MS = 45_000
/** How long a steered submission has to produce a disposition. */
const DISPOSITION_TIMEOUT_MS = 60_000
/** Post-quiescence settle so a late own-turn resolution is not missed. */
const CELL_SETTLE_MS = 3_000

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
  submission: unknown
  checks: Check[]
  ledgerSlice: unknown[]
  durationMs: number
}

type RowResult = {
  kind: string
  version: string
  bracketMintingMode?: string | undefined
  probe: { available: boolean; reason: string }
  compile?: Record<string, unknown> | undefined
  capabilities?: unknown
  cells: CellResult[]
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

function userInput(text: string, inputId: string): InvocationInput {
  return {
    inputId: inputId as InvocationInput['inputId'],
    kind: 'user',
    content: [{ type: 'text', text }],
  }
}

async function waitForIdle(
  broker: Broker,
  invocationId: InvocationId,
  events: InvocationEventEnvelope[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await broker.status({ invocationId })
    if (status.state === 'ready' && openTurnIds(events).length === 0) return true
    if (status.state === 'exited' || status.state === 'failed' || status.state === 'disposed') {
      return false
    }
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
    if ((await broker.status({ invocationId })).state === 'turn_active') return true
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
  bracketMintingMode: BracketMintingMode
  capabilities: InvocationCapabilities
}): Promise<CellResult> {
  const { broker, invocationId, events, door, state, ctx } = input
  const startedAt = Date.now()
  const cellMarker = `AM_${door}_${state}_${ctx.marker}`.replace(/-/g, '_').toUpperCase()
  const checks: Check[] = []

  // 1. Arm the seat state.
  const base = basePrompt(state, cellMarker)
  if (base !== undefined) {
    await broker.input({ invocationId, input: userInput(base, `input-base-${cellMarker}`) })
    const armed =
      state === 'busy-in-tool'
        ? await waitFor(
            () => events.some((event) => event.type === 'tool.call.started'),
            ctx.timeoutMs
          )
        : await waitForTurnActive(broker, invocationId, ctx.timeoutMs)
    if (!armed) {
      return {
        door,
        state,
        verdict: 'FAIL',
        expectation: 'seat armed into the requested state',
        submission: null,
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

  // 2. Knock on the door.
  const watermark = events.length
  const expectation = expectationFor(door, state, input.capabilities)
  const outcome = await knock(
    door,
    (req) => broker.input(req),
    invocationId,
    userInput(
      `Reply with exactly ${cellMarker} and nothing else. Do not use any tools.`,
      `input-door-${cellMarker}`
    )
  )

  // 3. Settle. An evidence-minting driver opens no bracket at delivery, so a
  //    plain `waitForIdle` here returns instantly and the cell would assert on
  //    an empty slice. Wait for the shape the expectation predicts FIRST, then
  //    let the seat quiesce.
  const sliceHas = (predicate: (event: InvocationEventEnvelope) => boolean): boolean =>
    events.slice(watermark).some(predicate)
  if (expectation.kind === 'own-turn') {
    await waitFor(() => sliceHas((event) => event.type === 'turn.started'), TURN_BRACKET_TIMEOUT_MS)
  } else if (expectation.kind === 'absorbed-or-executed') {
    await waitFor(
      () =>
        sliceHas(
          (event) => event.type === 'submission.absorbed' || event.type === 'submission.executed'
        ),
      DISPOSITION_TIMEOUT_MS
    )
  }
  await waitForIdle(broker, invocationId, events, ctx.timeoutMs)
  // A steered submission that found no boundary resolves as its OWN turn, which
  // can open just after the live turn ends; give that turn a chance to appear.
  await Bun.sleep(CELL_SETTLE_MS)
  await waitForIdle(broker, invocationId, events, ctx.timeoutMs)
  const slice = events.slice(watermark)

  // 4. Assert — ledger only.
  let rejected = false
  if (expectation.kind === 'typed-rejection') {
    rejected = true
    const rejectedOnLedger = slice.some((event) => event.type === 'input.rejected')
    checks.push({
      id: 'typed-rejection',
      ok: !outcome.accepted && rejectedOnLedger,
      detail: outcome.accepted
        ? `expected a typed rejection (${expectation.because}) but the door accepted: ${JSON.stringify(outcome.response)}`
        : `typed rejection recorded on the ledger: ${outcome.error.message}`,
      evidence: excerpt(slice.filter((event) => event.type.startsWith('input.'))),
    })
  } else if (expectation.kind === 'own-turn') {
    checks.push({
      id: 'own-turn-admitted',
      ok: outcome.accepted && outcome.response.disposition === 'started',
      detail: outcome.accepted
        ? `disposition=${outcome.response.disposition}`
        : `door rejected: ${outcome.error.message}`,
    })
    const bracket = slice.some((event) => event.type === 'turn.started')
    const terminal = slice.some((event) => TERMINAL_TURN_TYPES.has(event.type))
    checks.push({
      id: 'own-turn-bracketed',
      ok: bracket && terminal,
      detail: `turn.started=${bracket} terminal=${terminal}`,
      evidence: bracket && terminal ? undefined : excerpt(slice),
    })
    // Correlation: the asserted turn must be THIS door call's turn. Without it a
    // cell that races an unrelated turn (a launch priming prompt, a leftover
    // drain) reports a green on someone else's evidence.
    const carried = slice.filter(
      (event) =>
        (event.type === 'user.message' || event.type === 'assistant.message.completed') &&
        JSON.stringify(event.payload ?? {}).includes(cellMarker)
    )
    checks.push({
      id: 'own-turn-correlation',
      ok: carried.length > 0,
      detail:
        carried.length > 0
          ? `door submission text observed on ${carried.length} ledger event(s) of the asserted turn`
          : `no ledger event of the asserted turn carries this cell's submission (${cellMarker})`,
      evidence: carried.length > 0 ? undefined : excerpt(slice),
    })
  } else {
    // absorbed-or-executed: the §3.1 dual resolution.
    checks.push({
      id: 'steer-admitted',
      ok: outcome.accepted && outcome.response.disposition === 'attempted_steer',
      detail: outcome.accepted
        ? `disposition=${outcome.response.disposition}`
        : `door rejected: ${outcome.error.message}`,
    })
    const dispositions = slice.filter(
      (event) => event.type === 'submission.absorbed' || event.type === 'submission.executed'
    )
    checks.push({
      id: 'steer-dual-resolution',
      ok: dispositions.length > 0,
      detail:
        dispositions.length > 0
          ? dispositions
              .map((event) => `${event.type}(${JSON.stringify(event.payload)})`)
              .join(', ')
          : 'no submission.absorbed / submission.executed disposition for the steered submission',
      evidence: dispositions.length > 0 ? undefined : excerpt(slice),
    })
  }

  checks.push(
    checkOneDispositionPerSubmission(slice, input.bracketMintingMode, outcome.accepted ? 1 : 0)
  )
  checks.push(
    checkBracketMinting(
      slice,
      input.bracketMintingMode,
      expectation.kind === 'own-turn',
      outcome.accepted ? outcome.response.turnId : undefined
    )
  )
  checks.push(checkTurnManifest(slice, events))

  return {
    door,
    state,
    verdict: verdictOf(checks, rejected),
    expectation: expectation.kind,
    submission: outcome.accepted ? outcome.response : outcome.error,
    checks,
    ledgerSlice: excerpt(slice, 60),
    durationMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// One (row, door) seat: boot once, run every cell of that door on it
// ---------------------------------------------------------------------------

async function runDoor(input: {
  kind: string
  door: DoorName
  states: SeatState[]
  ctx: PlanContext
  bracketMintingMode: BracketMintingMode
  row: RowResult
}): Promise<CellResult[]> {
  const { kind, door, ctx, row } = input
  const recipe = ROW_RECIPES[kind]
  if (recipe === undefined) throw new Error(`no recipe for registered driver kind '${kind}'`)
  const plan = await recipe.plan(ctx)
  const events: InvocationEventEnvelope[] = []
  const results: CellResult[] = []
  const broker = createBroker({ drivers: [plan.driver], onEvent: (event) => events.push(event) })
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

    for (const state of input.states) {
      results.push(
        await runCell({
          broker,
          invocationId,
          events,
          door,
          state,
          ctx,
          bracketMintingMode: input.bracketMintingMode,
          capabilities: startResponse.capabilities,
        })
      )
      // Recover to idle between cells so one cell never contaminates the next.
      await recoverToIdle(broker, invocationId, events, ctx.timeoutMs)
    }

    // §9 assertion 8 is a RUNTIME-wide fact, so it is evaluated over the whole
    // seat lifetime and attributed to every cell this seat carried.
    const runtimeWide = checkNoCaptureWarning(events)
    for (const result of results) {
      result.checks.push(runtimeWide)
      result.verdict = verdictOf(result.checks, result.verdict === 'REJECT-OK')
    }
    return results
  } finally {
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
  const doors = [...new Set(selectedCells.map((cell) => cell.door))]

  console.log(`admission matrix ${marker}`)
  console.log(`repo       ${repoRoot}`)
  console.log(`rows       ${summaries.map((summary) => summary.kind).join(', ')}`)
  console.log(`cells      ${selectedCells.map((cell) => `${cell.door}/${cell.state}`).join(', ')}`)
  console.log(`artifacts  ${artifactDir}`)
  console.log('')

  const startedAt = Date.now()
  const rows: RowResult[] = []
  for (const summary of summaries) {
    const declared = drivers.find((driver) => driver.kind === summary.kind)
    const row: RowResult = {
      kind: summary.kind,
      version: summary.version,
      bracketMintingMode: declared?.bracketMintingMode,
      probe: { available: false, reason: 'not probed' },
      cells: [],
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

    for (const door of doors) {
      const states = selectedCells.filter((cell) => cell.door === door).map((cell) => cell.state)
      try {
        const cells = await runDoor({
          kind: summary.kind,
          door,
          states,
          ctx,
          bracketMintingMode: declared?.bracketMintingMode ?? 'delivery-asserted',
          row,
        })
        row.cells.push(...cells)
        for (const cell of cells) {
          console.log(
            `  ${summary.kind} ${door}/${cell.state}: ${cell.verdict} (${cell.durationMs}ms)`
          )
          for (const check of cell.checks.filter((candidate) => !candidate.ok)) {
            console.log(`      x ${check.id}: ${check.detail}`)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        row.errors.push(`${door}: ${message}`)
        console.log(`  ${summary.kind} ${door}: ERROR — ${message}`)
      }
    }
    row.status =
      row.errors.length === 0 &&
      row.cells.length > 0 &&
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
        schema: 'admission-matrix/v1',
        taskId: 'T-07860',
        contract: 'hcs T-07843 rev 7 §9',
        landing: 1,
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
