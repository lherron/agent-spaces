import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { openCaptureIndex } from '../../../src/capture/capture-index'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'
import { mapCodexNotification } from '../../../src/drivers/codex-app-server/event-map'
import { createEventLedger } from '../../../src/event-ledger'

/**
 * T-07868 — Codex app-server committed-row normalization (T-07853 §§5.2, 6.1,
 * 7, 7.3, §13 Phase 2, §14 rows 1 and 8).
 *
 * The claims under test are narrow and load-bearing: the live mapper consumes
 * the COMMITTED raw record's bytes, every record reaches exactly one durable
 * disposition, and a record committed but never dispositioned is re-driven on
 * reattach to exactly one normalized result.
 */

const root = new URL('../../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const scratchRoots: string[] = []

afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-committed-row-'))
  scratchRoots.push(dir)
  return dir
}

const spec = (scenario: string, invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, `${scenario}.ts`)],
    cwd: process.cwd(),
    lockedEnv: { CODEX_HOME: '/tmp/harness-broker-codex-home' },
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
  driver: {
    kind: 'codex-app-server',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
})

const userInput = {
  inputId: 'input_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Please respond.' }],
}

interface Run {
  events: InvocationEventEnvelope[]
  broker: ReturnType<typeof createBroker>
  dir: string
  invocationId: InvocationId
  journalRows: () => Array<Record<string, unknown>>
  dispositions: () => Map<string, { disposition: string; nativeType: string }>
}

/** Run one fake-codex scenario against a broker with a DURABLE capture journal. */
async function runScenario(
  scenario: string,
  options: { dir?: string; invocationId?: string } = {}
): Promise<Run> {
  const dir = options.dir ?? scratchDir()
  const invocationId = (options.invocationId ??
    `inv_${scenario.replaceAll('-', '_')}`) as InvocationId
  const events: InvocationEventEnvelope[] = []
  let resolveTerminal!: () => void
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve
  })
  const broker = createBroker({
    drivers: [createCodexAppServerDriver()],
    eventLedger: createEventLedger({ path: join(dir, 'events.ndjson') }),
    captureDir: dir,
    onEvent: (event) => {
      events.push(event)
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'invocation.failed' ||
        event.type === 'invocation.exited' ||
        event.type === 'capture.warning'
      ) {
        resolveTerminal()
      }
    },
  })
  // Keep the exported provider transcript inside the scratch root rather than
  // the shared per-user temp subtree, so parallel runs cannot collide.
  await broker.start(
    { spec: spec(scenario, invocationId) },
    {
      HARNESS_BROKER_ARTIFACT_DIR: dir,
    }
  )
  await broker.input({ invocationId, input: userInput, policy: { whenBusy: 'reject' } })
  await terminal
  return {
    events,
    broker,
    dir,
    invocationId,
    journalRows: () =>
      readFileSync(join(dir, 'raw', `${invocationId}.ndjson`), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    dispositions: () => {
      const index = openCaptureIndex(join(dir, 'ledger-index.db'))
      try {
        return new Map(
          index
            .list(invocationId)
            .map((row) => [
              row.rawRecordId,
              { disposition: row.disposition, nativeType: row.nativeType },
            ])
        )
      } finally {
        index.close()
      }
    },
  }
}

/**
 * Events normalized FROM a committed raw record. `continuation.updated` is
 * excluded on purpose: it comes from the `thread/start` RESPONSE, not from a
 * notification, so it carries the driver's declared provider authority without
 * a record id.
 */
const recordEvents = (events: InvocationEventEnvelope[]): InvocationEventEnvelope[] =>
  events.filter((event) => event.provenance?.rawRecordId !== undefined)

const frameOf = (row: Record<string, unknown>): string =>
  Buffer.from(row['rawBase64'] as string, 'base64').toString('utf8')

describe('codex-app-server committed-row normalization', () => {
  test('every provider event links to a committed record, and every record is dispositioned', async () => {
    const run = await runScenario('tool-calls')
    const rows = run.journalRows()
    const dispositions = run.dispositions()

    expect(rows.length).toBeGreaterThan(0)
    // §6.1: exactly one terminal disposition per committed record. `pending` is
    // the only non-terminal value, so nothing may still hold it after the run.
    expect(dispositions.size).toBe(rows.length)
    for (const row of rows) {
      const decided = dispositions.get(row['rawRecordId'] as string)
      expect(decided).toBeDefined()
      expect(decided?.disposition).not.toBe('pending')
    }

    // §7.2: every provider-observed event names a record that exists and
    // carries that record's own hash — the link a reader follows to the bytes.
    const byId = new Map(rows.map((row) => [row['rawRecordId'] as string, row]))
    const provider = recordEvents(run.events)
    expect(provider.length).toBeGreaterThan(0)
    for (const event of provider) {
      const record = byId.get(event.provenance?.rawRecordId ?? '')
      expect(record).toBeDefined()
      expect(event.provenance?.rawSha256).toBe(record?.['sha256'] as string)
      expect(event.provenance?.nativeType).toBe(record?.['nativeType'] as string)
      expect(event.provenance?.sourceEpoch).toBe(record?.['sourceEpoch'] as string)
    }
    // A clean scenario raises no capture warning at all.
    expect(run.events.filter((event) => event.type === 'capture.warning')).toHaveLength(0)
  })

  test('normalizing from the committed bytes reproduces the pre-change mapper output exactly', async () => {
    // The parity regression (§14 row 8): feeding the SAME committed frames
    // through the bare mapper — the pre-Phase-2 path, which read the in-memory
    // notification — must yield the identical normalized sequence. If the
    // committed copy and the wire copy could ever differ, this is where it shows.
    for (const scenario of ['tool-calls', 'assistant-deltas', 'usage-update', 'start-fresh-turn']) {
      const run = await runScenario(scenario)
      const fromCommittedBytes = run
        .journalRows()
        .flatMap((row) => mapCodexNotification(JSON.parse(frameOf(row))))
      const emitted = recordEvents(run.events).map((event) => ({
        type: event.type,
        payload: event.payload,
      }))
      // delivery-acknowledged and the matching native notification race to
      // mint the same deduped bracket. If the response won, the committed
      // turn/started record still normalizes successfully but emits no second
      // event; every non-deduped mapper output remains an exact parity claim.
      const comparable = emitted.some((event) => event.type === 'turn.started')
        ? fromCommittedBytes
        : fromCommittedBytes.filter((event) => event.type !== 'turn.started')
      expect(comparable.map((event) => ({ type: event.type, payload: event.payload }))).toEqual(
        emitted
      )
    }
  })

  test('the exported provider transcript is a projection of the journal, never a superset', async () => {
    const run = await runScenario('tool-calls')
    const exported = readFileSync(
      join(run.dir, `${run.invocationId}.provider-transcript.jsonl`),
      'utf8'
    )
      .split('\n')
      .filter((line) => line.trim().length > 0)

    // Row-for-row identity in commit order: the sidecar cannot hold a row the
    // journal does not, because it IS the journal.
    expect(exported).toEqual(run.journalRows().map(frameOf))
    // Still verifier-shaped JSON-RPC, which is what `parseProviderTranscript`
    // in hrc-capture-verifier reads.
    for (const line of exported) {
      const row = JSON.parse(line) as { jsonrpc?: unknown; method?: unknown }
      expect(row.jsonrpc).toBe('2.0')
      expect(typeof row.method).toBe('string')
    }
  })

  test('an unknown load-bearing method halts the cursor and an operator release resumes it in order', async () => {
    const run = await runScenario('unknown-load-bearing')

    const warning = run.events.find((event) => event.type === 'capture.warning')
    expect(warning).toBeDefined()
    const raw = (warning?.payload as { raw: Record<string, unknown> }).raw
    expect(raw['nativeType']).toBe('turn/experimentalBracket')
    expect(raw['family']).toBe('turn-bracket')
    expect(raw['cursorHalted']).toBe(true)

    // The records after the halt are committed but HELD: their facts are not on
    // the stream yet, and the durable index says so.
    expect(run.events.some((event) => event.type === 'usage.updated')).toBe(false)
    expect(run.events.some((event) => event.type === 'turn.completed')).toBe(false)
    const held = [...run.dispositions().values()].filter((row) => row.disposition === 'pending')
    expect(held.map((row) => row.nativeType)).toEqual([
      'thread/tokenUsage/updated',
      'turn/completed',
    ])

    const released = await run.broker.captureRelease({
      invocationId: run.invocationId,
      rawRecordId: raw['rawRecordId'] as string,
      disposition: 'ignored-known',
      note: 'reviewed: provider experiment, no broker consumer',
    })
    expect(released.disposition).toBe('ignored-known')
    expect(released.resumedRecords).toBe(2)
    expect(released.capture.state).toBe('open')

    // Resumed IN CURSOR ORDER: the usage row was committed before the terminal.
    expect(
      run.events
        .filter((event) => event.type === 'usage.updated' || event.type === 'turn.completed')
        .map((event) => event.type)
    ).toEqual(['usage.updated', 'turn.completed'])
    for (const row of run.dispositions().values()) {
      expect(row.disposition).not.toBe('pending')
    }
  })

  test('a reconnect over the same invocation mints a new epoch and restarts the cursor', async () => {
    const dir = scratchDir()
    const first = await runScenario('start-fresh-turn', { dir, invocationId: 'inv_epoch_rotation' })
    await first.broker.stop({ invocationId: first.invocationId })
    await first.broker.dispose({ invocationId: first.invocationId })
    const firstRows = first.journalRows()

    // A second broker over the SAME durable capture dir and invocation id: the
    // journal keeps the first connection's rows, and the new JSON-RPC stream
    // must not compare cursors against them (§7.1).
    const second = await runScenario('start-fresh-turn', {
      dir,
      invocationId: 'inv_epoch_rotation',
    })
    const newRows = second.journalRows().slice(firstRows.length)

    expect(newRows.length).toBeGreaterThan(0)
    expect(typeof newRows[0]?.['sourceEpoch']).toBe('string')
    expect(newRows[0]?.['sourceEpoch']).not.toBe(firstRows[0]?.['sourceEpoch'])
    expect(new Set(newRows.map((row) => row['sourceEpoch'])).size).toBe(1)
    // The per-connection cursor restarts, which is only meaningful BECAUSE the
    // epoch changed — the pair is what makes a cursor comparable.
    expect((newRows[0]?.['sourceCursor'] as { nativeSequence?: string })?.nativeSequence).toBe('1')
  })

  test('a record committed but never dispositioned is replayed exactly once on reattach', async () => {
    // §14 row 1 / §7.3: the crash window between raw fsync and normalized
    // commit. Its DURABLE signature is a committed raw row whose disposition is
    // still `pending`, which is exactly what is reconstructed here.
    const run = await runScenario('usage-update')
    const usageRow = run
      .journalRows()
      .find((row) => row['nativeType'] === 'thread/tokenUsage/updated')
    expect(usageRow).toBeDefined()
    const pendingId = usageRow?.['rawRecordId'] as string

    const index = openCaptureIndex(join(run.dir, 'ledger-index.db'))
    index.dispose(run.invocationId, pendingId, 'pending', undefined, 'test-crash')
    index.close()

    const attachRequest = {
      runtimeId: 'rt_replay',
      hostSessionId: 'hs_replay',
      generation: 1,
      invocationId: run.invocationId,
      startRequestHash: 'sha_start',
      selectedProfileHash: 'sha_profile',
      controllerInstanceId: 'ctl_1',
      attachToken: 'token',
    }

    const before = run.events.length
    await run.broker.attach(attachRequest)
    const replayed = run.events.slice(before)

    // EXACTLY ONE normalized result for the pending record — no duplicates, and
    // nothing already dispositioned re-normalized alongside it.
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.type).toBe('usage.updated')
    expect(replayed[0]?.provenance?.rawRecordId).toBe(pendingId)
    expect(run.dispositions().get(pendingId)?.disposition).toBe('normalized')

    // A second reattach replays nothing: the disposition is terminal now.
    const afterFirst = run.events.length
    await run.broker.attach(attachRequest)
    expect(run.events.slice(afterFirst)).toHaveLength(0)
  })
})
