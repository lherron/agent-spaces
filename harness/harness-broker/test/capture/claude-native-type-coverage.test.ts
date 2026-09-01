import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationId, RawRecordDisposition } from 'spaces-harness-broker-protocol'
import { createCaptureGate } from '../../src/capture/capture-gate'
import { openCaptureIndex } from '../../src/capture/capture-index'
import { createRawJournal } from '../../src/capture/raw-journal'
import { createClaudeHookTranscriptReader } from '../../src/drivers/claude-code-tmux/hook-transcript'

/**
 * Law `agent-spaces.harness-broker-local-commit-observation`: "every raw row
 * reaches one durable normalized, state-only, duplicate, ignored-known, or
 * blocked-unknown disposition". This proves it for the FULL native vocabulary of
 * the archived T-07849 live sessions — 26 distinct types across 14 row types,
 * 9 attachment subtypes and 4 queue operations.
 *
 * The in-repo fixture holds structural skeletons with every string redacted:
 * the archived transcripts are real sessions carrying prompts and tool output,
 * which §15 forbids copying into ordinary storage. The `CLAUDE_ARCHIVED_
 * TRANSCRIPTS` test below runs the same assertions against the real files when
 * they are present, so the redaction cannot hide a shape difference.
 */
const inventory = JSON.parse(
  readFileSync(
    join(import.meta.dir, '../fixtures/claude-transcript/native-type-inventory.json'),
    'utf8'
  )
) as { types: string[]; rows: Record<string, Record<string, unknown>> }

const invocationId = 'inv_native_types' as InvocationId
const roots: string[] = []
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Replay {
  dispositions: Array<{ nativeType: string; disposition: RawRecordDisposition }>
  warnings: string[]
}

/** Feed transcript lines through the real reader + a real capture gate. */
function replay(lines: string[]): Replay {
  const dir = mkdtempSync(join(tmpdir(), 'claude-native-'))
  roots.push(dir)
  const transcript = join(dir, 'session.jsonl')
  writeFileSync(transcript, '')

  const index = openCaptureIndex(join(dir, 'ledger-index.db'))
  const warnings: string[] = []
  const gate = createCaptureGate({
    invocationId,
    journal: createRawJournal({ invocationId, dir }),
    index,
    normalizer: { name: 'claude-code-tmux', version: 'test' },
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    emitWarning: (payload) => {
      warnings.push(payload.message)
      return warnings.length
    },
    emitReleased: () => 0,
    emitNormalizedAs: () => 0,
  })

  const reader = createClaudeHookTranscriptReader({
    invocationId,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    getCurrentTurnId: () => 'turn_active',
    capture: gate,
    emit: () => {},
    // The disposition mirror is exercised by its own suite; here every
    // queue/attachment/user row reports "no fact minted", which is the strictest
    // setting for this test: it forces the CLASSIFIER, not the mirror, to give
    // each row a disposition.
    onTranscriptEntry: () => false,
  })

  reader.handleHook({ hook_event_name: 'SessionStart', transcript_path: transcript })
  for (const line of lines) {
    appendFileSync(transcript, `${line}\n`)
    // One hook per row: releases any halt so the whole corpus is classified in
    // a single pass rather than stopping at the first unknown.
    if (gate.state().state === 'blocked') {
      const blockedOn = gate.state().blockedOn
      if (blockedOn !== undefined) {
        gate.release({ rawRecordId: blockedOn.rawRecordId, disposition: 'ignored-known' })
      }
    }
    reader.handleHook({ hook_event_name: 'PostToolUse' })
  }
  if (gate.state().state === 'blocked') {
    const blockedOn = gate.state().blockedOn
    if (blockedOn !== undefined) {
      gate.release({ rawRecordId: blockedOn.rawRecordId, disposition: 'ignored-known' })
    }
  }

  const dispositions = index
    .list(invocationId)
    .map((r) => ({ nativeType: r.nativeType, disposition: r.disposition }))
  index.close()
  return { dispositions, warnings }
}

describe('claude native-type disposition coverage (archived T-07849 vocabulary)', () => {
  test('every distinct archived native type reaches exactly one terminal disposition', () => {
    const lines = inventory.types.map((type) => JSON.stringify(inventory.rows[type]))
    const { dispositions } = replay(lines)

    expect(dispositions).toHaveLength(inventory.types.length)
    // `pending` is the ONLY non-terminal disposition. Nothing may be left in it.
    expect(dispositions.filter((d) => d.disposition === 'pending')).toEqual([])
  })

  test('no archived native type is blocked-unknown: the table covers the real vocabulary', () => {
    const lines = inventory.types.map((type) => JSON.stringify(inventory.rows[type]))
    const { dispositions, warnings } = replay(lines)
    const blocked = dispositions.filter((d) => d.disposition === 'blocked-unknown')
    expect({ blocked, warnings }).toEqual({ blocked: [], warnings: [] })
  })

  test('a native type OUTSIDE the archived vocabulary is blocked, not silently dropped', () => {
    // The mutation that proves the rule can fail: an operation Claude has never
    // emitted must halt rather than pass through as state-only.
    const { dispositions, warnings } = replay([
      JSON.stringify({ type: 'queue-operation', operation: 'reprioritize', content: 'x' }),
    ])
    // The replay harness releases each halt so the whole corpus classifies in
    // one pass, so the RECORDED disposition here is the operator's release —
    // the point is that it halted at all and named the row.
    expect(dispositions).toEqual([
      { nativeType: 'queue-operation:reprioritize', disposition: 'ignored-known' },
    ])
    expect(warnings).toEqual(['Unknown Claude queue operation: reprioritize'])
  })

  test('native types found by the LIVE smoke are classified, not blocked', () => {
    // `ai-title` and `attachment:auto_mode_exit` appear in no archived session.
    // The first real Claude session run against this code produced both, which
    // is why "one real call before trusting a fixture" is a validation rule and
    // not advice.
    const { dispositions, warnings } = replay([
      JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 's' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'auto_mode_exit' } }),
    ])
    expect(dispositions.map((d) => d.disposition)).toEqual(['ignored-known', 'ignored-known'])
    expect(warnings).toEqual([])
  })

  test('an unknown top-level row type is reported but does NOT halt the cursor', () => {
    // We cannot assert a row type we cannot place is load-bearing, and the law
    // halts only on an unclassified LOAD-BEARING type. It still warns.
    const { warnings } = replay([JSON.stringify({ type: 'brand-new-row-kind', payload: {} })])
    expect(warnings).toEqual(['Unknown Claude transcript row type: brand-new-row-kind'])
  })
})

/**
 * Opt-in run against the real archived sessions. "Make one real call before
 * trusting a fixture": the redacted inventory above is derived from these files,
 * and this proves the derivation did not lose a shape.
 */
const archiveDir = join(homedir(), 'praesidium/var/wrkq-artifacts/T-07849')
const archived = existsSync(archiveDir)
  ? readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
  : []

describe.if(archived.length > 0)('archived T-07849 transcripts (real sessions)', () => {
  for (const file of archived) {
    test(`${file}: every row reaches a terminal disposition, none blocked-unknown`, () => {
      const lines = readFileSync(join(archiveDir, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
      const { dispositions, warnings } = replay(lines)
      expect(dispositions).toHaveLength(lines.length)
      expect(dispositions.filter((d) => d.disposition === 'pending')).toEqual([])
      expect({ file, warnings }).toEqual({ file, warnings: [] })
    })
  }
})
