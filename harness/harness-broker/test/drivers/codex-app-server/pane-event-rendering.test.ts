import { describe, expect, test } from 'bun:test'
import {
  INVOCATION_EVENT_TYPES,
  type InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { createCodexTranscriptModel } from '../../../src/drivers/codex-app-server/transcript'

/**
 * Representative payloads, one per family. Only the fields a renderer reads need
 * to be real; the point of the roster test is COVERAGE of the decision, not of
 * the payload schema (which `schemas.ts` owns).
 */
const PAYLOADS: Record<string, unknown> = {
  'admission.rejected': {
    submissionId: 'submission_inv-a_7',
    class: 'queue',
    layer: 'authority',
    reason: 'not a member',
  },
  'admission.requested': {
    submissionId: 'submission_inv-a_7',
    class: 'queue',
    origin: { principalRef: 'agent:lance' },
  },
  'admission.admitted': { submissionId: 'submission_inv-a_7', class: 'queue' },
  'queue.enqueued': {
    submissionId: 'submission_inv-a_7',
    class: 'queue',
    position: 0,
    ttlMs: 1_800_000,
  },
  'queue.jumped': {
    submissionId: 'submission_inv-a_7',
    fromPosition: 3,
    toPosition: 0,
    principalRef: 'agent:lance',
  },
  'queue.cancelled': { submissionId: 'submission_inv-a_7', principalRef: 'agent:lance' },
  'queue.expired': { submissionId: 'submission_inv-a_7' },
  'queue.withdrawn': { submissionId: 'submission_inv-a_7', reason: 'recalled', position: 0 },
  'submission.rejected': { submissionId: 'submission_inv-a_7', reason: 'turn is guarded' },
  'submission.expired': { submissionId: 'submission_inv-a_7' },
  'submission.withdrawn': { submissionId: 'submission_inv-a_7', reason: 'recalled' },
  'submission.cancelled': { submissionId: 'submission_inv-a_7', reason: 'removed' },
  'submission.lost': { submissionId: 'submission_inv-a_7', reason: 'turn-correlation-lost' },
  'submission.executed': { submissionId: 'submission_inv-a_7', turnId: 'turn-1' },
  'submission.absorbed': { submissionId: 'submission_inv-a_7', turnId: 'turn-1' },
  'interrupt.failed': { submissionId: 'submission_inv-a_7', reason: 'no active turn' },
  'interrupt.requested': { submissionId: 'submission_inv-a_7' },
  'interrupt.landed': { submissionId: 'submission_inv-a_7' },
  'input.accepted': { inputId: 'input-1', disposition: 'started' },
  'input.rejected': { inputId: 'input-1', disposition: 'rejected', reason: 'seat is busy' },
  'input.queued': { inputId: 'input-1', disposition: 'queued' },
  'harness.started': { generation: 2, mode: 'recycle', mechanism: 'direct-child' },
  'harness.exited': { generation: 2, reason: 'crash', exitCode: 1 },
  'harness.recovery.started': { fromGeneration: 2, reason: 'stall', activeTurnDisposition: 'none' },
  'harness.recovery.completed': { fromGeneration: 2, toGeneration: 3, ready: true },
  'harness.recovery.failed': { fromGeneration: 2, reason: 'spawn-failed' },
  'lifecycle.escalation': { reason: 'retry-exhausted', requestedAction: 'operator-attention' },
  'lifecycle.policy.accepted': { policyId: 'policy-a', retentionMode: 'keep-alive' },
  'turn.retry': {
    inputId: 'input-1',
    turnId: 'turn-1',
    fromAttempt: 1,
    toAttempt: 2,
    reason: 'harness-crashed',
    semantics: 'at-least-once',
  },
  'turn.stalled': { inputId: 'input-1', turnId: 'turn-1', noProgressMs: 45_000 },
  'turn.started': { turnId: 'turn-1' },
  'turn.completed': { turnId: 'turn-1' },
  'turn.failed': { turnId: 'turn-1', message: 'boom' },
  'turn.interrupted': { turnId: 'turn-1' },
  'permission.requested': {
    permissionRequestId: 'perm-1',
    kind: 'command',
    defaultDecision: 'allow',
  },
  'permission.resolved': { permissionRequestId: 'perm-1', decision: 'deny', source: 'policy' },
  'permission.cancelled': { permissionRequestId: 'perm-1', reason: 'turn-failed' },
  'capture.warning': { message: 'vocabulary drifted', raw: {}, kind: 'ledger_tail_repaired' },
  'capture.released': { rawRecordId: 'raw-1', disposition: 'normalized' },
  'invocation.started': { pid: 1, command: 'codex', args: [], cwd: '/tmp' },
  'invocation.ready': { state: 'ready' },
  'invocation.stopping': { reason: 'operator-stop' },
  'invocation.exited': { exitCode: 0 },
  'invocation.failed': { message: 'boom' },
  'invocation.disposed': { disposed: true },
  'invocation.summary': { summary: {} },
  'continuation.updated': { provider: 'codex', key: 'thread_1' },
  'continuation.cleared': { reason: 'prompt_input_exit' },
  'user.message': { content: 'hello' },
  'assistant.message.started': {},
  'assistant.message.delta': { text: 'hi' },
  'assistant.message.completed': { text: 'hi' },
  'tool.call.started': { toolCallId: 'tool-1', name: 'command', input: { command: 'ls' } },
  'tool.call.delta': { toolCallId: 'tool-1', data: { stream: 'stdout' }, text: 'x' },
  'tool.call.completed': { toolCallId: 'tool-1', result: { output: 'ok' } },
  'tool.call.failed': { toolCallId: 'tool-1', name: 'command', result: { exitCode: 2 } },
  'usage.updated': { usage: { last: { totalTokens: 10 } } },
  diagnostic: { level: 'info', message: 'hello' },
  'driver.notice': { message: 'notice' },
  'terminal.surface.reported': { kind: 'tmux-pane', paneId: '%1' },
  'provider.transcript.reported': { path: '/tmp/t.jsonl' },
}

function render(type: string, payload?: unknown, verbose = false): string[] {
  const lines: string[] = []
  const model = createCodexTranscriptModel({
    invocationId: 'inv-a',
    emit: (line) => lines.push(line),
    width: 120,
    verbose,
  })
  model.apply({
    invocationId: 'inv-a',
    seq: 1,
    time: '2026-09-02T18:00:00.000Z',
    type,
    payload: payload ?? PAYLOADS[type] ?? {},
  } as unknown as InvocationEventEnvelope)
  return lines
}

/**
 * The events the pane deliberately says nothing about. This is the OTHER half of
 * the compile-time exhaustiveness check in `transcript.ts`: the compiler proves
 * every type has a decision, and this proves which decision each one got — so
 * flipping an event from shown to silent (or the reverse) has to be done on
 * purpose, in this list, rather than by editing a switch arm unnoticed.
 */
const SUPPRESSED = new Set([
  'admission.requested',
  'admission.admitted',
  'submission.executed',
  'submission.absorbed',
  'queue.enqueued',
  'input.queued',
  'interrupt.requested',
  'interrupt.landed',
  'turn.stalled',
  'invocation.disposed',
  'permission.requested',
  'permission.cancelled',
  'capture.released',
  'provider.transcript.reported',
  // Streaming halves, folded into their completed event.
  'assistant.message.started',
  'assistant.message.delta',
  'tool.call.delta',
  // Tracked for the turn footer rather than rendered per step.
  'usage.updated',
])

describe('every protocol event has a rendering decision (T-07906)', () => {
  test('no event leaks a raw JSON payload into the pane', () => {
    const leaked: string[] = []
    for (const type of INVOCATION_EVENT_TYPES) {
      for (const line of render(type)) {
        // The old `default:` arm emitted `· <type> <JSON>`. Nothing may now.
        if (line.includes(`· ${type} {`) || line.includes(`· ${type} [`)) leaked.push(type)
      }
    }
    expect(leaked).toEqual([])
  })

  test('the suppressed set is exactly the events that render nothing', () => {
    const silent = INVOCATION_EVENT_TYPES.filter((type) => render(type).length === 0)
    expect([...silent].sort()).toEqual([...SUPPRESSED].sort())
  })

  test('the roster covers every event this test claims to have exercised', () => {
    const missing = INVOCATION_EVENT_TYPES.filter((type) => PAYLOADS[type] === undefined)
    expect(missing).toEqual([])
  })
})

describe('the events that mean a message did not get through are loud', () => {
  test.each([
    ['admission.rejected', '✗ rejected at authority · not a member'],
    ['submission.rejected', '✗ #7 rejected · turn is guarded'],
    ['submission.lost', '✗ #7 delivery outcome lost · turn-correlation-lost'],
    ['input.rejected', '✗ input rejected · seat is busy'],
    ['queue.expired', '⚠ #7 expired in the queue — never delivered'],
    ['submission.expired', '⚠ #7 expired'],
    ['interrupt.failed', '⚠ interrupt failed · no active turn'],
    ['turn.retry', '⚠ retry 2 · harness-crashed · at-least-once'],
    ['harness.exited', '✗ harness crashed · code=1'],
    ['harness.recovery.started', '⚠ recovering · stall'],
    ['harness.recovery.failed', '✗ recovery failed · spawn-failed'],
    ['lifecycle.escalation', '✗ escalation · retry-exhausted → operator-attention'],
    ['permission.resolved', '⚠ permission denied (policy)'],
  ])('%s renders as %s', (type, expected) => {
    expect(render(type).join('\n')).toContain(expected)
  })

  test('a harness recycle explains the silence; a first generation does not', () => {
    expect(render('harness.started').join('')).toContain('harness recycled · gen 2')
    expect(render('harness.started', { generation: 1, mode: 'initial' })).toEqual([])
  })

  test('a policy ALLOW is noise and stays out; only the deny is rendered', () => {
    expect(
      render('permission.resolved', {
        permissionRequestId: 'perm-1',
        decision: 'allow',
        source: 'policy',
      })
    ).toEqual([])
  })

  test('a teardown cancellation is the shutdown, not a disposition to read', () => {
    expect(
      render('submission.cancelled', { submissionId: 'submission_inv-a_7', reason: 'teardown' })
    ).toEqual([])
    expect(
      render('submission.cancelled', {
        submissionId: 'submission_inv-a_7',
        reason: 'recalled',
      }).join('')
    ).toContain('cancelled #7 · recalled')
  })

  test('a per-record blocked_unknown capture warning stays out of the pane', () => {
    expect(
      render('capture.warning', { message: 'unclassified', raw: {}, kind: 'blocked_unknown' })
    ).toEqual([])
  })
})

describe('BROKER_PANE_VERBOSE echoes the whole stream', () => {
  test('a suppressed event still shows its raw type and payload', () => {
    const lines = render('queue.enqueued', undefined, true)
    expect(lines.join('\n')).toContain('queue.enqueued {')
    expect(lines.join('\n')).toContain('"position":0')
  })

  test('a rendered event keeps its styled row alongside the echo', () => {
    const lines = render('queue.expired', undefined, true)
    expect(lines.join('\n')).toContain('queue.expired {')
    expect(lines.join('\n')).toContain('never delivered')
  })
})

/**
 * A turn that ran two hours ago and one that ran two minutes ago look identical
 * on a cold pane: `✓ done · 1.2k tok · 43s` says how long it ran, never when. Both
 * ends of the turn carry the operator's wall clock so scrollback can be read
 * against it — and each stamp comes from its OWN envelope's time, so a replayed
 * ledger shows the hours the turn actually spanned.
 */
describe('a turn is clocked at both ends with wall-clock time (T-07978)', () => {
  type Step = readonly [type: string, time: string | undefined, payload?: unknown]

  function renderSteps(steps: readonly Step[]): string[] {
    const lines: string[] = []
    const model = createCodexTranscriptModel({
      invocationId: 'inv-a',
      emit: (line) => lines.push(line),
      width: 120,
    })
    steps.forEach(([type, time, payload], index) => {
      model.apply({
        invocationId: 'inv-a',
        seq: index + 1,
        ...(time === undefined ? {} : { time }),
        type,
        payload: payload ?? { turnId: 'turn-1' },
      } as unknown as InvocationEventEnvelope)
    })
    return lines
  }

  test('a summer turn is stamped in CDT, not UTC, at both ends', () => {
    // 02:23Z/02:24Z on Jul 15 are 09:23/09:24 PM on Jul 14 in Chicago (UTC-5
    // under DST).
    const lines = renderSteps([
      ['turn.started', '2026-07-15T02:23:17.000Z'],
      ['turn.completed', '2026-07-15T02:24:00.000Z'],
    ])
    expect(lines.filter((l) => l.length > 0)).toEqual([
      '  ── Tue, Jul 14 ──',
      '  ▶ turn 1 · 09:23 PM',
      '▎ ✓ done · 43s · 09:24 PM',
    ])
  })

  test('a winter turn at the same wall-clock hour is stamped in CST', () => {
    // 03:24Z on Jan 15 is the same 09:24 PM in Chicago, off a UTC-6 offset. The
    // two cases agreeing from DIFFERENT offsets is what proves the zone is
    // applied rather than a hard-coded shift.
    const lines = renderSteps([
      ['turn.started', '2026-01-15T03:23:17.000Z'],
      ['turn.completed', '2026-01-15T03:24:00.000Z'],
    ])
    expect(lines.at(-1)).toBe('▎ ✓ done · 43s · 09:24 PM')
  })

  test('the stamp is the last segment, after the tokens and the elapsed', () => {
    const lines = renderSteps([
      ['turn.started', '2026-07-15T02:23:17.000Z'],
      ['usage.updated', '2026-07-15T02:23:40.000Z', { usage: { last: { totalTokens: 1234 } } }],
      ['turn.completed', '2026-07-15T02:24:00.000Z'],
    ])
    expect(lines.at(-1)).toBe('▎ ✓ done · 1,234 tok · 43s · 09:24 PM')
  })

  test('a failed turn is timestamped too', () => {
    const lines = renderSteps([
      ['turn.started', '2026-07-15T02:23:17.000Z'],
      ['turn.failed', '2026-07-15T02:24:00.000Z', { turnId: 'turn-1', message: 'boom' }],
    ])
    expect(lines.at(-1)).toBe('▎ ✗ failed  boom · 09:24 PM')
  })

  test('an absent or unparseable time omits the segment rather than inventing one', () => {
    const untimed = renderSteps([['turn.started', undefined]])
    expect(untimed.at(-1)).toBe('  ▶ turn 1')

    const completed = renderSteps([
      ['turn.started', '2026-07-15T02:23:17.000Z'],
      ['turn.completed', undefined],
    ])
    expect(completed.at(-1)).toBe('▎ ✓ done')

    const failed = renderSteps([
      ['turn.started', '2026-07-15T02:23:17.000Z'],
      ['turn.failed', 'not-a-time', { turnId: 'turn-1', message: 'boom' }],
    ])
    expect(failed.at(-1)).toBe('▎ ✗ failed  boom')
  })
})

/**
 * The other half of the clock (T-07994). `09:23 PM` says which hour, never which
 * day — and a pane's scrollback, or a replay of a recorded ledger, routinely
 * spans more than one. A dim divider carries the calendar date: once at the top,
 * and again only where the date actually changes.
 */
describe('the pane names its calendar date once, and again on every change (T-07994)', () => {
  type Step = readonly [type: string, time: string | undefined, payload?: unknown]

  function renderSteps(steps: readonly Step[]): string[] {
    const lines: string[] = []
    const model = createCodexTranscriptModel({
      invocationId: 'inv-a',
      emit: (line) => lines.push(line),
      width: 120,
    })
    steps.forEach(([type, time, payload], index) => {
      model.apply({
        invocationId: 'inv-a',
        seq: index + 1,
        ...(time === undefined ? {} : { time }),
        type,
        payload: payload ?? { turnId: 'turn-1' },
      } as unknown as InvocationEventEnvelope)
    })
    return lines
  }

  const dividers = (lines: readonly string[]): string[] => lines.filter((l) => l.includes('──'))

  test('two turns on one date are divided once, immediately before the first turn', () => {
    const lines = renderSteps([
      ['turn.started', '2026-07-15T14:23:17.000Z'],
      ['turn.completed', '2026-07-15T14:24:00.000Z'],
      ['turn.started', '2026-07-15T16:00:00.000Z'],
      ['turn.completed', '2026-07-15T16:00:43.000Z'],
    ])
    expect(dividers(lines)).toEqual(['  ── Wed, Jul 15 ──'])
    const body = lines.filter((l) => l.length > 0)
    expect(body[0]).toBe('  ── Wed, Jul 15 ──')
    expect(body[1]).toBe('  ▶ turn 1 · 09:23 AM')
  })

  test('a turn that crosses midnight is divided again before its own footer', () => {
    // 04:59Z / 05:01Z on Jul 16 are 11:59 PM Jul 15 and 12:01 AM Jul 16 in
    // Chicago: one turn, two calendar days, two dividers.
    const lines = renderSteps([
      ['turn.started', '2026-07-16T04:59:00.000Z'],
      ['turn.completed', '2026-07-16T05:01:00.000Z'],
    ])
    expect(lines.filter((l) => l.length > 0)).toEqual([
      '  ── Wed, Jul 15 ──',
      '  ▶ turn 1 · 11:59 PM',
      '  ── Thu, Jul 16 ──',
      '▎ ✓ done · 2m0s · 12:01 AM',
    ])
  })

  test('the date is the Chicago date, not the UTC one', () => {
    // 02:23Z on Jul 15 is still 09:23 PM on Jul 14 in Chicago. A divider naming
    // Jul 15 here would mean the zone was applied to the clock but not the date.
    const lines = renderSteps([['turn.started', '2026-07-15T02:23:17.000Z']])
    expect(dividers(lines)).toEqual(['  ── Tue, Jul 14 ──'])
  })

  test('an absent or unparseable time divides nothing and stamps nothing', () => {
    expect(renderSteps([['turn.started', undefined]]).filter((l) => l.length > 0)).toEqual([
      '  ▶ turn 1',
    ])
    expect(renderSteps([['turn.started', 'not-a-time']]).filter((l) => l.length > 0)).toEqual([
      '  ▶ turn 1',
    ])
  })

  test('an unstamped event never triggers a divider', () => {
    const lines = renderSteps([
      ['user.message', '2026-07-15T14:00:00.000Z', { content: 'hello' }],
      ['assistant.message.completed', '2026-07-15T14:00:10.000Z', { text: 'hi' }],
    ])
    expect(dividers(lines)).toEqual([])
  })

  test('a divider precedes an interrupted turn on a new date, with its own blank', () => {
    const lines = renderSteps([
      ['turn.started', '2026-07-16T04:59:00.000Z'],
      ['turn.interrupted', '2026-07-16T05:01:00.000Z'],
    ])
    expect(lines.filter((l) => l.length > 0)).toEqual([
      '  ── Wed, Jul 15 ──',
      '  ▶ turn 1 · 11:59 PM',
      '  ── Thu, Jul 16 ──',
      '  ◼ interrupted · 12:01 AM',
    ])
    // The divider brings the blank the interrupted row does not open itself.
    expect(lines[lines.indexOf('  ── Thu, Jul 16 ──') - 1]).toBe('')
  })
})

/**
 * `◼ interrupted` was the last turn terminal without a time (T-07994): a stop
 * only means something against when it landed.
 */
describe('an interrupted turn is clocked like the other terminals (T-07994)', () => {
  function renderInterrupt(time: string | undefined): string[] {
    const lines: string[] = []
    const model = createCodexTranscriptModel({
      invocationId: 'inv-a',
      emit: (line) => lines.push(line),
      width: 120,
    })
    model.apply({
      invocationId: 'inv-a',
      seq: 1,
      ...(time === undefined ? {} : { time }),
      type: 'turn.interrupted',
      payload: { turnId: 'turn-1' },
    } as unknown as InvocationEventEnvelope)
    return lines
  }

  test('the row carries the wall clock from its own envelope', () => {
    expect(renderInterrupt('2026-07-15T02:24:00.000Z').at(-1)).toBe('  ◼ interrupted · 09:24 PM')
  })

  test('an absent or unparseable time omits the segment rather than inventing one', () => {
    expect(renderInterrupt(undefined).at(-1)).toBe('  ◼ interrupted')
    expect(renderInterrupt('not-a-time').at(-1)).toBe('  ◼ interrupted')
  })
})
