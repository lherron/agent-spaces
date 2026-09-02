import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationId } from 'spaces-harness-broker-protocol'
import { createDefaultBroker } from '../../src/default-broker'
import { createEventLedger } from '../../src/event-ledger'

/**
 * T-07868 — capture durability must survive the DEFAULT broker factory.
 *
 * `harness-broker run --transport unix` is the only broker with a ledger path,
 * so it is the only one whose capture can be durable at all — and it builds its
 * broker through `createDefaultBroker`, not `createBroker`. A `captureDir` that
 * the factory silently drops produces the worst possible failure: every event
 * still carries a plausible `rawRecordId`, but the journal it names was never
 * written and `replayPending` can never find anything after a restart.
 *
 * The unit tests that exercise the gate all call `createBroker` directly, so
 * none of them can see that gap. This one goes through the factory the
 * production CLI uses.
 */

const root = new URL('../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')
const scratch: string[] = []

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const spec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
  process: {
    command: Bun.execPath,
    args: [join(fixtureDir, 'tool-calls.ts')],
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

describe('durable capture wiring through createDefaultBroker', () => {
  test('a ledger-backed default broker writes the raw journal and the disposition index to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'default-broker-capture-'))
    scratch.push(dir)
    const invocationId = 'inv_default_broker_capture' as InvocationId

    let resolveTerminal!: () => void
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve
    })
    const broker = createDefaultBroker(
      (event) => {
        if (event.type === 'turn.completed' || event.type === 'turn.failed') resolveTerminal()
      },
      undefined,
      {
        eventLedger: createEventLedger({ path: join(dir, 'events.ndjson') }),
        captureDir: dir,
      }
    )
    await broker.start({ spec: spec(invocationId) })
    await broker.input({
      invocationId,
      input: { inputId: 'input_1', kind: 'user', content: [{ type: 'text', text: 'go' }] },
      policy: { whenBusy: 'reject' },
    })
    // turn/start acknowledgement now deliberately returns before trailing
    // provider notifications; the terminal event proves capture has drained.
    await terminal

    const journalPath = join(dir, 'raw', `${invocationId}.ndjson`)
    expect(existsSync(journalPath)).toBe(true)
    const rows = readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.length).toBeGreaterThan(0)

    const db = new Database(join(dir, 'ledger-index.db'), { readonly: true })
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
      // The ledger's own table is not evidence that capture is durable; the
      // disposition table is the one a dropped captureDir leaves missing.
      expect(tables.map((table) => table.name)).toContain('raw_record')
      const dispositions = db
        .query('SELECT raw_record_id, disposition FROM raw_record WHERE invocation_id = ?')
        .all(invocationId) as Array<{ raw_record_id: string; disposition: string }>
      expect(dispositions).toHaveLength(rows.length)
      expect(dispositions.every((row) => row.disposition !== 'pending')).toBe(true)
    } finally {
      db.close()
    }
  })
})
