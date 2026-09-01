#!/usr/bin/env bun
/**
 * Capture parity report (T-07853 §13 Phase 0, §14 item 8).
 *
 * Reads ONE broker ledger directory — the durable artifacts a real invocation
 * left behind — and reports, per driver × event family:
 *
 *   native / hook / both / broker / conflicts
 *
 * plus the raw-record disposition census and every declared-vs-observed
 * authority disagreement. It reads committed artifacts only; it never talks to
 * a live broker, so it can be run against a session that has already ended.
 *
 * Inputs (all under the directory passed as --dir, i.e. the invocation's bipc
 * dir — the parent of the `--event-ledger` path the broker was started with):
 *   events.ndjson      normalized envelopes, each carrying `provenance`
 *   raw/<inv>.ndjson   the verbatim raw ingress journal
 *   ledger-index.db    per-record dispositions and any capture halt
 *
 * Usage:
 *   bun harness/harness-broker/scripts/capture-parity.ts --dir <ledger dir> [--json <out>]
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  EventFamily,
  EventSourceKind,
  EvidenceAuthority,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { EVENT_FAMILY_BY_TYPE } from 'spaces-harness-broker-protocol'
import {
  AGENT_HARNESS_TMUX_AUTHORITY,
  BROKER_ONLY_AUTHORITY,
  CLAUDE_CODE_TMUX_AUTHORITY,
  CODEX_APP_SERVER_AUTHORITY,
  CODEX_CLI_TMUX_AUTHORITY,
  PI_TUI_TMUX_AUTHORITY,
} from '../src/drivers/evidence-authority'

const DECLARED: Record<string, Record<EventFamily, EvidenceAuthority>> = {
  'claude-code-tmux': CLAUDE_CODE_TMUX_AUTHORITY,
  'codex-cli-tmux': CODEX_CLI_TMUX_AUTHORITY,
  'codex-app-server': CODEX_APP_SERVER_AUTHORITY,
  'pi-tui-tmux': PI_TUI_TMUX_AUTHORITY,
  'agent-harness-tmux': AGENT_HARNESS_TMUX_AUTHORITY,
}

export interface FamilyCell {
  driver: string
  family: EventFamily
  declared: EvidenceAuthority | 'unknown'
  native: number
  hook: number
  /** Both sources contributed facts to this family in this run. */
  both: boolean
  broker: number
  /** Event types whose observed provenance disagrees with the declaration. */
  conflicting: Array<{ type: string; observed: EventSourceKind; declared: EvidenceAuthority }>
  /** Distinct native types observed producing this family. */
  nativeTypes: string[]
}

export interface ParityReport {
  generatedAt: string
  dir: string
  invocations: string[]
  events: { total: number; withProvenance: number }
  cells: FamilyCell[]
  dispositions: Record<string, number>
  /** Raw records that never reached a terminal disposition. */
  pendingRawRecords: Array<{ invocationId: string; rawRecordId: string; nativeType: string }>
  blockedUnknown: Array<{
    invocationId: string
    rawRecordId: string
    nativeType: string
    detail?: string
  }>
  captureHalts: Array<{ invocationId: string; rawRecordId: string; nativeType: string }>
  warnings: Array<{ invocationId: string; seq: number; kind?: string; message: string }>
}

function sourceToAuthority(kind: EventSourceKind): EvidenceAuthority {
  if (kind === 'hook') return 'hook'
  if (kind === 'broker') return 'broker'
  return 'native'
}

function readEvents(dir: string): InvocationEventEnvelope[] {
  const path = join(dir, 'events.ndjson')
  if (!existsSync(path)) return []
  const out: InvocationEventEnvelope[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as InvocationEventEnvelope)
    } catch {
      // A torn trailing record is expected after a crash; the ledger's own
      // startup scan repairs it. Skipping it keeps the report readable.
    }
  }
  return out
}

interface RawRow {
  invocation_id: string
  raw_record_id: string
  native_type: string
  disposition: string
  detail: string | null
}

function readIndex(dir: string): { rows: RawRow[]; halts: ParityReport['captureHalts'] } {
  const path = join(dir, 'ledger-index.db')
  if (!existsSync(path)) return { rows: [], halts: [] }
  const db = new Database(path, { readonly: true })
  try {
    const rows = db
      .query<RawRow, []>(
        'SELECT invocation_id, raw_record_id, native_type, disposition, detail FROM raw_record ORDER BY invocation_id, raw_record_id'
      )
      .all()
    const halts = db
      .query<{ invocation_id: string; raw_record_id: string; native_type: string }, []>(
        'SELECT invocation_id, raw_record_id, native_type FROM capture_block'
      )
      .all()
      .map((r) => ({
        invocationId: r.invocation_id,
        rawRecordId: r.raw_record_id,
        nativeType: r.native_type,
      }))
    return { rows, halts }
  } catch {
    // A broker predating the capture contract has only `consumer_state`.
    return { rows: [], halts: [] }
  } finally {
    db.close()
  }
}

export function buildReport(dir: string): ParityReport {
  const events = readEvents(dir)
  const { rows, halts } = readIndex(dir)

  const cells = new Map<string, FamilyCell>()
  const invocations = new Set<string>()
  let withProvenance = 0

  for (const event of events) {
    invocations.add(event.invocationId)
    const provenance = event.provenance
    if (provenance === undefined) continue
    withProvenance += 1

    const driver = event.driver?.kind ?? provenance.normalizer.name
    const family = EVENT_FAMILY_BY_TYPE[event.type]
    const key = `${driver} ${family}`
    const declaredMatrix = DECLARED[driver] ?? BROKER_ONLY_AUTHORITY
    const cell = cells.get(key) ?? {
      driver,
      family,
      declared: declaredMatrix[family] ?? 'unknown',
      native: 0,
      hook: 0,
      both: false,
      broker: 0,
      conflicting: [],
      nativeTypes: [],
    }
    const observed = sourceToAuthority(provenance.sourceKind)
    if (observed === 'native') cell.native += 1
    else if (observed === 'hook') cell.hook += 1
    else cell.broker += 1

    if (provenance.nativeType !== undefined && !cell.nativeTypes.includes(provenance.nativeType)) {
      cell.nativeTypes.push(provenance.nativeType)
    }
    // A fact whose observed source is not the declared owner of its family is
    // the disagreement this report exists to surface. Broker-authored facts are
    // never a disagreement: the broker owns its own decisions in EVERY family
    // (input echoes, synthesized terminals, control dispositions).
    if (observed !== cell.declared && observed !== 'broker' && cell.declared !== 'unknown') {
      const already = cell.conflicting.some(
        (c) => c.type === event.type && c.observed === provenance.sourceKind
      )
      if (!already) {
        cell.conflicting.push({
          type: event.type,
          observed: provenance.sourceKind,
          declared: cell.declared,
        })
      }
    }
    cells.set(key, cell)
  }

  // `both` is the dual-capture signal Phase 0 exists to measure: this family
  // drew on hook AND native evidence within one run.
  for (const cell of cells.values()) {
    cell.both = cell.native > 0 && cell.hook > 0
  }

  const dispositions: Record<string, number> = {}
  for (const row of rows) {
    dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1
    invocations.add(row.invocation_id)
  }

  const warnings = events
    .filter((event) => event.type === 'capture.warning')
    .map((event) => {
      const payload = event.payload as { kind?: string; message: string }
      return {
        invocationId: event.invocationId,
        seq: event.seq,
        ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
        message: payload.message,
      }
    })

  return {
    generatedAt: new Date().toISOString(),
    dir,
    invocations: [...invocations].sort(),
    events: { total: events.length, withProvenance },
    cells: [...cells.values()].sort(
      (a, b) => a.driver.localeCompare(b.driver) || a.family.localeCompare(b.family)
    ),
    dispositions,
    pendingRawRecords: rows
      .filter((r) => r.disposition === 'pending')
      .map((r) => ({
        invocationId: r.invocation_id,
        rawRecordId: r.raw_record_id,
        nativeType: r.native_type,
      })),
    blockedUnknown: rows
      .filter((r) => r.disposition === 'blocked-unknown')
      .map((r) => ({
        invocationId: r.invocation_id,
        rawRecordId: r.raw_record_id,
        nativeType: r.native_type,
        ...(r.detail !== null ? { detail: r.detail } : {}),
      })),
    captureHalts: halts,
    warnings,
  }
}

export function renderReport(report: ParityReport): string {
  const lines: string[] = []
  lines.push(`capture parity — ${report.dir}`)
  lines.push(`generated ${report.generatedAt}`)
  lines.push(`invocations: ${report.invocations.join(', ') || '(none)'}`)
  const provenanceGap = report.events.total === report.events.withProvenance ? '' : '   <-- GAP'
  lines.push(
    `events: ${report.events.total} total, ${report.events.withProvenance} carrying provenance${provenanceGap}`
  )
  lines.push('')
  lines.push(
    'driver                family                 declared  native   hook  both  broker  conflicts'
  )
  lines.push('-'.repeat(97))
  for (const cell of report.cells) {
    lines.push(
      [
        cell.driver.padEnd(21),
        cell.family.padEnd(22),
        cell.declared.padEnd(9),
        String(cell.native).padStart(6),
        String(cell.hook).padStart(6),
        (cell.both ? 'yes' : '-').padStart(5),
        String(cell.broker).padStart(7),
        String(cell.conflicting.length).padStart(10),
      ].join(' ')
    )
  }
  lines.push('')
  lines.push('raw-record dispositions:')
  const dispositionEntries = Object.entries(report.dispositions).sort()
  if (dispositionEntries.length === 0) {
    lines.push('  (no raw journal index — a broker without the capture contract)')
  }
  for (const [disposition, count] of dispositionEntries) {
    lines.push(`  ${disposition.padEnd(16)} ${count}`)
  }

  const conflicts = report.cells.filter((c) => c.conflicting.length > 0)
  lines.push('')
  if (conflicts.length === 0) {
    lines.push('declared-vs-observed: no disagreements.')
  } else {
    lines.push('declared-vs-observed disagreements (classify each before a cutover):')
    for (const cell of conflicts) {
      for (const conflict of cell.conflicting) {
        lines.push(
          `  ${cell.driver} / ${cell.family}: ${conflict.type} observed from ${conflict.observed}, declared ${conflict.declared}`
        )
      }
    }
  }

  if (report.pendingRawRecords.length > 0) {
    lines.push('')
    lines.push(`raw records with NO terminal disposition: ${report.pendingRawRecords.length}`)
    for (const row of report.pendingRawRecords.slice(0, 20)) {
      lines.push(`  ${row.invocationId} ${row.rawRecordId} ${row.nativeType}`)
    }
  }
  if (report.captureHalts.length > 0) {
    lines.push('')
    lines.push('capture HALTED:')
    for (const halt of report.captureHalts) {
      lines.push(`  ${halt.invocationId} blocked on ${halt.rawRecordId} (${halt.nativeType})`)
    }
  }
  lines.push('')
  lines.push(
    report.warnings.length === 0
      ? 'capture.warning: none (whole-runtime clean).'
      : `capture.warning: ${report.warnings.length}`
  )
  for (const warning of report.warnings.slice(0, 20)) {
    lines.push(`  seq ${warning.seq} [${warning.kind ?? 'driver'}] ${warning.message}`)
  }
  return lines.join('\n')
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const dir = readFlag(args, '--dir')
  if (dir === undefined) {
    process.stderr.write(
      'Usage: capture-parity.ts --dir <ledger dir> [--json <out path>]\n  --dir holds events.ndjson, raw/ and ledger-index.db\n'
    )
    process.exit(1)
  }
  if (!existsSync(dir)) {
    process.stderr.write(`No such directory: ${dir}\n`)
    process.exit(1)
  }
  const report = buildReport(dir)
  process.stdout.write(`${renderReport(report)}\n`)
  const jsonPath = readFlag(args, '--json')
  if (jsonPath !== undefined) {
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`\nartifact: ${jsonPath}\n`)
  }
  // A halt, an undispositioned record, or an envelope with no provenance is a
  // real finding, not a formatting choice: exit non-zero so a smoke/CI caller
  // notices without reading prose.
  const clean =
    report.pendingRawRecords.length === 0 &&
    report.captureHalts.length === 0 &&
    report.events.total === report.events.withProvenance
  process.exit(clean ? 0 : 1)
}
