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
  details: Array<{ nativeType: string; detail: string | undefined }>
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
    warn: () => {},
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
    // One hook per row. Nothing has to be released between rows: since T-07883
    // an unclassified row never stops the cursor.
    reader.handleHook({ hook_event_name: 'PostToolUse' })
  }

  const dispositions = index
    .list(invocationId)
    .map((r) => ({ nativeType: r.nativeType, disposition: r.disposition }))
  const details = index
    .list(invocationId)
    .map((r) => ({ nativeType: r.nativeType, detail: r.detail }))
  index.close()
  return { dispositions, details, warnings }
}

describe('claude native-type disposition coverage (archived T-07849 vocabulary)', () => {
  test('no archived native type is blocked-unknown: the table covers the real vocabulary', () => {
    const lines = inventory.types.map((type) => JSON.stringify(inventory.rows[type]))
    const { dispositions, warnings } = replay(lines)
    // Every distinct archived type reaches exactly one terminal disposition:
    // `pending` is the ONLY non-terminal one, and nothing may be left in it.
    expect(dispositions).toHaveLength(inventory.types.length)
    expect(dispositions.filter((d) => d.disposition === 'pending')).toEqual([])
    const blocked = dispositions.filter((d) => d.disposition === 'blocked-unknown')
    expect({ blocked, warnings }).toEqual({ blocked: [], warnings: [] })
  })

  // The mutation that proves the rule can fail: a native type Claude has never
  // emitted must be reported rather than pass through as state-only. Since
  // T-07883 it keeps its blocked-unknown disposition and the cursor advances
  // (the known row after it is still classified). `command_permissions` is
  // deliberately left loud until the authority matrix reviews it.
  test.each([
    {
      row: 'queue operation',
      line: { type: 'queue-operation', operation: 'reprioritize', content: 'x' },
      nativeType: 'queue-operation:reprioritize',
      warning: 'Unknown Claude queue operation: reprioritize',
    },
    {
      row: 'permission-named attachment subtype',
      line: { type: 'attachment', attachment: { type: 'command_permissions', allowedTools: [] } },
      nativeType: 'attachment:command_permissions',
      warning: 'Unknown Claude attachment type: command_permissions',
    },
    {
      row: 'unseen attachment subtype',
      line: { type: 'attachment', attachment: { type: 'never_seen_subtype' } },
      nativeType: 'attachment:never_seen_subtype',
      warning: 'Unknown Claude attachment type: never_seen_subtype',
    },
    {
      row: 'unpinned system subtype',
      line: { type: 'system', subtype: 'brand_new_subtype' },
      nativeType: 'system:brand_new_subtype',
      warning: 'Unknown Claude system row subtype: brand_new_subtype',
    },
    {
      row: 'top-level row type',
      line: { type: 'brand-new-row-kind', payload: {} },
      nativeType: 'brand-new-row-kind',
      warning: 'Unknown Claude transcript row type: brand-new-row-kind',
    },
  ])(
    'an unknown $row is blocked-unknown and warned, and the cursor advances past it',
    ({ line, nativeType, warning }) => {
      const { dispositions, warnings } = replay([
        JSON.stringify(line),
        JSON.stringify({ type: 'cost-state', totalCostUSD: 1.25, modelUsage: {} }),
      ])
      expect<unknown>(dispositions).toEqual([
        { nativeType, disposition: 'blocked-unknown' },
        { nativeType: 'cost-state', disposition: 'normalized' },
      ])
      expect(warnings).toEqual([warning])
    }
  )

  test('per-turn session metadata, live-smoke rows and 2.1.259 mail hints are ignored-known, not warned (R-00320)', () => {
    // Every live Claude turn wrote these; T-10297's evidence showed one warning
    // per type per turn, burying real capture warnings. Shapes are the key sets
    // observed in 60 local transcripts on 2026-10-05, with placeholder values.
    const metadata: Record<string, Record<string, unknown>> = {
      model: { identity: 'x', text: 'x' },
      instructions: { files: [] },
      environment: { snapshot: {} },
      session_context: { context: 'x' },
      prompt_snapshot: { systemPrompt: 'x', contextRendering: 'x' },
      date: { date: '2026-10-05' },
      credential_org: { organizationUuid: '00000000-0000-0000-0000-000000000000' },
      deferred_tools_record: { entries: [], toolInputCopies: [] },
      silent_turn_reminder: { text: 'x' },
      edited_text_file: { filename: '/tmp/x', snippet: 'x' },
      file: { filename: '/tmp/x', content: {}, displayPath: 'x' },
      compact_file_reference: { filename: '/tmp/x', displayPath: 'x' },
      thinking_drop: { requestId: 'req_x', model: 'x' },
      invoked_skills: { skills: [] },
      inlined_image_paths: { paths: [] },
    }
    // `ai-title` (a top-level row) and `attachment:auto_mode_exit` appear in no
    // archived session; the first real Claude session run against this code
    // produced both, which is why "one real call before trusting a fixture" is
    // a validation rule and not advice.
    const liveSmoke = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 's' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'auto_mode_exit' } }),
    ]
    // Real Claude 2.1.259 mail-hint attachments, recorded.
    const mailHints = readFileSync(
      join(import.meta.dir, '../fixtures/claude-transcript/mail-hint-attachments-2.1.259.jsonl'),
      'utf8'
    )
      .trimEnd()
      .split('\n')
    const { dispositions, warnings } = replay([
      ...Object.entries(metadata).map(([type, fields]) =>
        JSON.stringify({ type: 'attachment', attachment: { type, ...fields } })
      ),
      ...liveSmoke,
      ...mailHints,
    ])
    expect<unknown>(dispositions).toEqual([
      ...Object.keys(metadata).map((type) => ({
        nativeType: `attachment:${type}`,
        disposition: 'ignored-known',
      })),
      { nativeType: 'ai-title', disposition: 'ignored-known' },
      { nativeType: 'attachment:auto_mode_exit', disposition: 'ignored-known' },
      { nativeType: 'attachment:hook_success', disposition: 'ignored-known' },
      { nativeType: 'attachment:hook_additional_context', disposition: 'ignored-known' },
    ])
    expect(warnings).toEqual([])
  })

  test('Claude 2.1.311 request and tool-list rows are ignored-known, not warned (T-11969)', () => {
    // Claude 2.1.311 records each outgoing API request: its shape, its message
    // blobs, and its params. They are inputs, not results. Usage, the serving
    // model and the provider `requestId` stay on the `assistant` row, which
    // points back here only through `requestRef`. `tools-used` is a running
    // list of tool names that repeats the `tool_use` blocks. Redacted from real
    // seats.
    const rows = readFileSync(
      join(import.meta.dir, '../fixtures/claude-transcript/rows-2.1.311.jsonl'),
      'utf8'
    )
      .trimEnd()
      .split('\n')
    const { dispositions, warnings } = replay([
      ...rows,
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1.25, modelUsage: {} }),
    ])
    expect<unknown>(dispositions).toEqual([
      { nativeType: 'api-request-shape', disposition: 'ignored-known' },
      { nativeType: 'api-request-blob', disposition: 'ignored-known' },
      { nativeType: 'api-request', disposition: 'ignored-known' },
      { nativeType: 'tools-used', disposition: 'ignored-known' },
      { nativeType: 'cost-state', disposition: 'normalized' },
    ])
    expect(warnings).toEqual([])
  })

  test('Stop hook cancellation is ignored-known with its four diagnostic fields', () => {
    const { dispositions, details, warnings } = replay([
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_cancelled',
          hookName: 'Stop',
          hookEvent: 'Stop',
          durationMs: 72,
          timedOut: false,
          command: 'intentionally not copied into disposition detail',
        },
      }),
    ])

    expect<unknown>(dispositions).toEqual([
      { nativeType: 'attachment:hook_cancelled', disposition: 'ignored-known' },
    ])
    expect(JSON.parse(details[0]?.detail ?? 'null')).toEqual({
      hookName: 'Stop',
      hookEvent: 'Stop',
      durationMs: 72,
      timedOut: false,
    })
    expect(warnings).toEqual([])
  })

  test('the pinned `system` subtypes are read, and the turn terminal keeps its numbers', () => {
    // T-07873 §B: `system` left the ignored set so the turn bracket could be
    // MEASURED. The rows are `duplicate` — the Stop hook still owns
    // `turn-bracket` — but the numbers that decided it stay in the ledger.
    const { dispositions, details, warnings } = replay([
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 2892,
        messageCount: 11,
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'stop_hook_summary',
        stopReason: '',
        preventedContinuation: false,
      }),
      JSON.stringify({ type: 'system', subtype: 'bridge_status', content: 'x' }),
    ])
    expect<unknown>(dispositions).toEqual([
      { nativeType: 'system:turn_duration', disposition: 'duplicate' },
      { nativeType: 'system:stop_hook_summary', disposition: 'duplicate' },
      { nativeType: 'system:bridge_status', disposition: 'ignored-known' },
    ])
    expect(JSON.parse(details[0]?.detail ?? 'null')).toEqual({
      subtype: 'turn_duration',
      durationMs: 2892,
      messageCount: 11,
    })
    expect(JSON.parse(details[1]?.detail ?? 'null')).toEqual({
      subtype: 'stop_hook_summary',
      stopReason: '',
      preventedContinuation: false,
    })
    expect(warnings).toEqual([])
  })

  test('`cost-state` is a usage record now, not an ignored row', () => {
    const { dispositions, warnings } = replay([
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1.25, modelUsage: {} }),
    ])
    expect<unknown>(dispositions).toEqual([{ nativeType: 'cost-state', disposition: 'normalized' }])
    expect(warnings).toEqual([])
  })

  test('a blocked hook decision is classified on BOTH rows it writes', () => {
    // The structured-output retry is the only path that blocks a hook decision,
    // so no archived session contains either row. A live leg found both, and a
    // replay against the PREVIOUS release produced the same two — the halt is a
    // pre-existing defect this task surfaced, not a Phase 4 regression.
    const { dispositions, details, warnings } = replay([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'Stop hook feedback:\n/ must be valid JSON matching schema',
        },
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_blocking_error',
          hookName: 'Stop',
          hookEvent: 'Stop',
          toolUseID: 'tu_1',
          blockingError: {
            blockingError: '/ must be valid JSON matching schema',
            command: 'harness-broker claude-hook-decision --socket /tmp/secret.sock',
          },
        },
      }),
    ])
    expect<unknown>(dispositions).toEqual([
      // The mirror is stubbed to "no fact minted" in this harness, so the user
      // row's classification is the driver's job and is asserted in the driver
      // suite; here the point is that the ATTACHMENT no longer warns.
      { nativeType: 'user', disposition: 'state-only' },
      { nativeType: 'attachment:hook_blocking_error', disposition: 'ignored-known' },
    ])
    expect(JSON.parse(details[1]?.detail ?? 'null')).toEqual({
      hookName: 'Stop',
      hookEvent: 'Stop',
      blockingError: '/ must be valid JSON matching schema',
    })
    // The command carries socket paths and is deliberately not copied.
    expect(details[1]?.detail).not.toContain('secret.sock')
    expect(warnings).toEqual([])
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

// Reads this host's artifacts, so it runs under `just smoke-live`, not verify (T-10161).
describe.if(process.env['ASP_LIVE_TESTS'] === '1' && archived.length > 0)(
  'archived T-07849 transcripts (real sessions)',
  () => {
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
  }
)
