import { describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationId, RawRecordDisposition } from 'spaces-harness-broker-protocol'
import { createCaptureGate } from '../../src/capture/capture-gate'
import { openCaptureIndex } from '../../src/capture/capture-index'
import { createRawJournal } from '../../src/capture/raw-journal'
import { createCodexHookTranscriptReader } from '../../src/drivers/codex-cli-tmux/hook-transcript'

/**
 * The Codex rollout drift guard (T-07870) — the codex analogue of
 * `claude-native-type-coverage.test.ts`, and the thing AUTHORITY.md's "a named
 * gap: the Codex rollout vocabulary is not pinned yet" was waiting for.
 *
 * Law `agent-spaces.harness-broker-local-commit-observation`: every raw row
 * reaches one durable disposition. This proves it for the WHOLE pinned
 * vocabulary — 107 (row type × payload type × item type) combinations, 47 of
 * them taken verbatim (structurally; every string redacted) from real rollouts,
 * the rest synthesized from the codex source enums.
 *
 * The fixture holds skeletons because the rollouts are real sessions carrying
 * prompts and tool output (§15). The LIVE-CORPUS describe below runs the same
 * assertions against the real committed journals when they are present, so the
 * redaction cannot hide a shape difference.
 */
const inventory = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../fixtures/codex-rollout/native-type-inventory.json'),
    'utf8'
  )
) as {
  types: string[]
  observed: string[]
  synthesized: string[]
  rows: Record<string, Record<string, unknown>>
}

const invocationId = 'inv_codex_native_types' as InvocationId
const roots: string[] = []
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Replay {
  dispositions: Array<{ nativeType: string; disposition: RawRecordDisposition }>
  warnings: string[]
  /** Records that HALTED the cursor, in order. */
  halted: string[]
}

/** Feed rollout lines through the real reader + a real capture gate. */
function replay(lines: string[]): Replay {
  const dir = mkdtempSync(join(tmpdir(), 'codex-native-'))
  roots.push(dir)
  const transcript = join(dir, 'rollout.jsonl')
  writeFileSync(transcript, '')

  const index = openCaptureIndex(join(dir, 'ledger-index.db'))
  const warnings: string[] = []
  const halted: string[] = []
  const gate = createCaptureGate({
    invocationId,
    journal: createRawJournal({ invocationId, dir }),
    index,
    normalizer: { name: 'codex-cli-tmux', version: 'test' },
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    emitWarning: (payload) => {
      warnings.push(payload.message)
      if (payload.raw?.cursorHalted === true) halted.push(payload.raw.nativeType)
      return warnings.length
    },
    emitReleased: () => 0,
    emitNormalizedAs: () => 0,
  })

  const reader = createCodexHookTranscriptReader({
    invocationId,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    getCurrentTurnId: () => 'turn_active',
    capture: gate,
  })

  reader.handleHook({ hook_event_name: 'SessionStart', transcript_path: transcript })
  const release = (): void => {
    const blockedOn = gate.state().blockedOn
    if (blockedOn !== undefined) {
      gate.release({ rawRecordId: blockedOn.rawRecordId, disposition: 'ignored-known' })
    }
  }
  for (const line of lines) {
    appendFileSync(transcript, `${line}\n`)
    // One hook per row, releasing any halt, so the whole corpus is classified in
    // a single pass rather than stopping at the first unknown.
    release()
    reader.handleHook({ hook_event_name: 'PostToolUse' })
  }
  release()

  const dispositions = index
    .list(invocationId)
    .map((row) => ({ nativeType: row.nativeType, disposition: row.disposition }))
  index.close()
  return { dispositions, warnings, halted }
}

/**
 * Same replay, but every line lands in ONE read. The reader holds assistant
 * prose and flushes it at a hook boundary, so a one-hook-per-row harness never
 * lets a ROW mint the flush — which is exactly the difference between
 * `state-only` and `normalized` for this driver.
 */
function replayInOneRead(lines: string[]): Replay {
  const dir = mkdtempSync(join(tmpdir(), 'codex-native-batch-'))
  roots.push(dir)
  const transcript = join(dir, 'rollout.jsonl')
  writeFileSync(transcript, '')
  const index = openCaptureIndex(join(dir, 'ledger-index.db'))
  const warnings: string[] = []
  const halted: string[] = []
  const gate = createCaptureGate({
    invocationId,
    journal: createRawJournal({ invocationId, dir }),
    index,
    normalizer: { name: 'codex-cli-tmux', version: 'test' },
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    emitWarning: (payload) => {
      warnings.push(payload.message)
      if (payload.raw?.cursorHalted === true) halted.push(payload.raw.nativeType)
      return warnings.length
    },
    emitReleased: () => 0,
    emitNormalizedAs: () => 0,
  })
  const reader = createCodexHookTranscriptReader({
    invocationId,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    getCurrentTurnId: () => 'turn_active',
    capture: gate,
  })
  reader.handleHook({ hook_event_name: 'SessionStart', transcript_path: transcript })
  for (const line of lines) appendFileSync(transcript, `${line}\n`)
  reader.handleHook({ hook_event_name: 'Stop' })
  const dispositions = index
    .list(invocationId)
    .map((row) => ({ nativeType: row.nativeType, disposition: row.disposition }))
  index.close()
  return { dispositions, warnings, halted }
}

const inventoryLines = (): string[] =>
  inventory.types.map((type) => JSON.stringify(inventory.rows[type]))

describe('codex rollout native-type disposition coverage', () => {
  test('the pinned vocabulary is corpus-derived, not invented', () => {
    // A table built only from source enums would be a guess about the wire; a
    // table built only from a corpus would be a guess about completeness. Both
    // halves have to be non-trivial for the pin to mean anything.
    expect(inventory.observed.length).toBeGreaterThanOrEqual(45)
    expect(inventory.observed).toContain('event_msg:task_started')
    expect(inventory.observed).toContain('event_msg:item_completed:CommandExecution')
    expect(inventory.types.length).toBe(inventory.observed.length + inventory.synthesized.length)
  })

  test('every pinned native type reaches exactly one terminal disposition', () => {
    const { dispositions } = replay(inventoryLines())
    expect(dispositions).toHaveLength(inventory.types.length)
    // `pending` is the ONLY non-terminal disposition. Nothing may be left in it.
    expect(dispositions.filter((row) => row.disposition === 'pending')).toEqual([])
  })

  test('no pinned native type is blocked-unknown: the table covers the real vocabulary', () => {
    const { dispositions, warnings } = replay(inventoryLines())
    const blocked = dispositions.filter((row) => row.disposition === 'blocked-unknown')
    expect({ blocked, warnings }).toEqual({ blocked: [], warnings: [] })
  })

  test('the reader still ACTS on the rows it owns, rather than ignoring them all', () => {
    // A table that classified everything as `ignored-known` would also pass the
    // two tests above. `agent_message` is HELD (the held-latest terminal
    // candidate), which is `state-only` — a real read, no event yet — and it
    // must never read as `ignored-known`.
    const { dispositions } = replay(inventoryLines())
    const prose = dispositions.filter((row) => row.nativeType === 'event_msg:agent_message')
    expect(prose.map((row) => row.disposition)).toEqual(['state-only'])
  })

  test('a superseded held message is minted BY the row that supersedes it', () => {
    // Both rows land in ONE read, so the interim flush happens inside the
    // second row's normalization rather than at the hook boundary — which is
    // what makes that row `normalized` and pins the provenance to it.
    const { dispositions } = replayInOneRead([
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', id: 'msg_1', message: 'the answer' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', id: 'msg_2', message: 'a later answer' },
      }),
    ])
    expect(dispositions.map((row) => row.disposition)).toEqual([
      'state-only',
      'state-only',
      'normalized',
    ])
  })

  test('an UNKNOWN item subtype halts: its parent is pinned and load-bearing', () => {
    // `item_completed` is where codex's paginated history mode delivers the
    // terminal answer, so a renamed or added item type there costs assistant
    // prose. This is the codex analogue of Claude's unknown queue operation.
    const { warnings, halted, dispositions } = replay([
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'HolographicMessage' } },
      }),
    ])
    expect(warnings).toEqual(['Unknown Codex rollout item type: item_completed/HolographicMessage'])
    expect(halted).toEqual(['event_msg:item_completed:HolographicMessage'])
    // The replay harness releases each halt so the corpus classifies in one
    // pass; the point is that it halted at all and named the row.
    expect(dispositions).toEqual([
      { nativeType: 'event_msg:item_completed:HolographicMessage', disposition: 'ignored-known' },
    ])
  })

  test('an UNKNOWN event_msg payload type warns without halting', () => {
    const { warnings, halted } = replay([
      JSON.stringify({ type: 'event_msg', payload: { type: 'brand_new_event' } }),
    ])
    expect(warnings).toEqual(['Unknown Codex rollout event_msg type: brand_new_event'])
    expect(halted).toEqual([])
  })

  test('an UNKNOWN top-level row type warns without halting', () => {
    const { warnings, halted } = replay([
      JSON.stringify({ type: 'brand_new_row_kind', payload: {} }),
    ])
    expect(warnings).toEqual(['Unknown Codex rollout row type: brand_new_row_kind'])
    expect(halted).toEqual([])
  })

  test('an UNKNOWN response_item payload type warns without halting', () => {
    const { warnings, halted } = replay([
      JSON.stringify({ type: 'response_item', payload: { type: 'brand_new_item' } }),
    ])
    expect(warnings).toEqual(['Unknown Codex rollout response_item type: brand_new_item'])
    expect(halted).toEqual([])
  })
})

/**
 * Opt-in run against the REAL committed journals of the T-07870 corpus. "Make
 * one real call before trusting a fixture": the redacted inventory above is
 * derived from these (and from the archive), and this proves the derivation did
 * not lose a shape.
 */
const corpusDir = join(homedir(), 'praesidium/var/wrkq-artifacts/T-07870/corpus')
const corpusJournals = existsSync(corpusDir)
  ? readdirSync(corpusDir)
      .map((scenario) => join(corpusDir, scenario, 'raw'))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => readdirSync(dir).map((file) => join(dir, file)))
  : []

describe.if(corpusJournals.length > 0)('T-07870 live corpus (real codex-cli-tmux rollouts)', () => {
  for (const journal of corpusJournals) {
    test(`${journal.split('/').slice(-3)[0]}: every real rollout row classifies with no warning`, () => {
      const lines = readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { sourceKind: string; rawBase64: string })
        .filter((record) => record.sourceKind === 'provider-jsonl')
        .map((record) => Buffer.from(record.rawBase64, 'base64').toString('utf8'))
      expect(lines.length).toBeGreaterThan(0)
      const { dispositions, warnings } = replay(lines)
      expect(warnings).toEqual([])
      expect(dispositions.filter((row) => row.disposition === 'pending')).toEqual([])
      expect(dispositions.filter((row) => row.disposition === 'blocked-unknown')).toEqual([])
    })
  }
})
