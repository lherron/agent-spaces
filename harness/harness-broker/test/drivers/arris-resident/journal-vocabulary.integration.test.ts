import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ArrisHostDescriptor,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createArrisResidentDriver } from '../../../src/drivers/arris-resident/driver'

/**
 * T-10324. The Arris journal vocabulary is closed (T-08503): every kind the
 * resident writes is either mapped or deliberately ignored, and only a kind
 * Arris has never written reaches `capture.warning{blocked_unknown}`.
 *
 * Driven through the real broker, capture gate and a journal file on disk,
 * which is the path T-10299 saw warn on `codex_child_started` and
 * `shutdown_signal`.
 */

const fixtureHostId = 'host-incarnation:23d3a051-dd84-4a1e-bba9-340c2c4af963'
const invocationId = 'inv-arris-vocabulary' as InvocationId
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

/**
 * Every journal kind `arris-codex-adapter` (arris 151e7c6d) writes that the
 * driver did not handle before T-10324, with its emit site and a detail shaped
 * like that site's. Kinds the driver already handled are covered by the
 * T-10299 journal replay and the driver unit tests.
 */
const PREVIOUSLY_UNHANDLED: Array<[kind: string, detail: Record<string, unknown>]> = [
  // attached_proxy.rs:264
  [
    'approval_ownership_held',
    { child_request_id: 7, class: 'exec', thread: 't', to_connections: [] },
  ],
  [
    'approval_ownership_transferred',
    { child_request_id: 7, class: 'exec', thread: 't', to_connections: [1] },
  ],
  // attached_proxy.rs:302/310
  ['attached_answer_ignored', { child_request_id: 7, connection: 1, reason: 'not_owner' }],
  // attached_proxy.rs:390
  ['attached_client_observed', { connection: 1 }],
  // serve_loop.rs:272
  [
    'attached_request_allowed',
    { connection_id: 1, method: 'thread/read', request_id: 'Integer(3)' },
  ],
  // attached_proxy.rs:328
  ['attached_thread_unsubscribe_forwarded', { connection: 1, thread: 't' }],
  // serve_loop.rs:322
  [
    'attached_turn_admission_failed_open',
    { connection_id: 1, method: 'turn/start', request_id: 'Integer(4)', message: 'x' },
  ],
  // resident/server/child.rs:189
  ['child_exit_reconciled', { action_ids: ['a1'], redispatched: [] }],
  // child_client.rs:249
  ['child_frame_untyped', { method: null, error: 'expected value' }],
  // child_client.rs:353
  ['codex_child_exited', { pid: 99211, planned: false, status: null, signal: 9 }],
  // resident/server/child.rs:233
  ['codex_child_resumed', { thread_id: 't', incarnation_seq: 2 }],
  // child_client.rs:209
  ['codex_child_started', { pid: 99212, spawned_at: 1, incarnation_seq: 2 }],
  // resident/server/control.rs:157/133
  ['control_completion_not_recorded', { input_id: 'i', message: 'disk full' }],
  ['control_presentation_not_recorded', { input_id: 'i', message: 'disk full' }],
  // resident/server/journal.rs:153/146
  ['control_resolution_failed', { envelope_id: 'EN-1', message: 'x' }],
  ['control_resolution_unmatched', { envelope_id: 'EN-1' }],
  // resident/server/control.rs:577/555
  ['control_stop_decided', { graceful_timeout_ms: 1000, force_requested: false, result: 'stop' }],
  [
    'control_stop_refused',
    { code: 'external_lifecycle', host_lifecycle_owner: 'external', saved_anything: false },
  ],
  // resident/server/events.rs:265/145
  ['dynamic_tool_call_admitted', { conversation: 't', turn: 'c', call: 'k', codex_call_id: 'k' }],
  ['dynamic_tool_call_unattributed', { codex_turn_id: 'c', tool: 'arris.x', thread_id: 't' }],
  // resident/server/serve_loop.rs:161
  ['event_drain_resumed', { deferred: true, events_were_queued: true }],
  // resident/server.rs:335
  ['host_descriptor_publication_failed', { code: 'io', message: 'x' }],
  // host_outbox.rs:84/92
  ['mail_reply_sent', { envelope_id: 'EN-1' }],
  ['mail_reply_refused', { envelope_id: 'EN-1', code: 'x' }],
  // resident/server/approvals.rs:89, notifications.rs:200
  [
    'native_approval_answered',
    { class: 'exec', responder: 'arris_host', host_answered: true, decision: 'accepted' },
  ],
  [
    'native_approval_deferral_resolved',
    { codex_turn_id: 'c', resolved: 1, resolved_by: 'turn_completion' },
  ],
  // resident/server/notifications.rs:60
  ['resident_compacted', { codex_turn_id: 'c', host_incarnation_id: fixtureHostId }],
  // resident/server/child.rs:53
  ['resident_rebind_failed', { reason: 'child_restarted', code: 'x', message: 'x' }],
  // resident/server/events.rs:174
  ['resident_responder_delay_started', { milliseconds: 10, tool: 'arris.x' }],
  // resident/server.rs:398
  ['resumable_check_failed', { rollout_path: '/tmp/missing.jsonl' }],
  // attached_proxy.rs:163, resident/server/events.rs:122
  ['server_request_unhandled', { request: 'Other' }],
  // resident/server/child.rs:295
  [
    'settled_effect_surfaced',
    { action_id: 'a1', method: 'thread/inject_items', acknowledged: true },
  ],
  // resident/server/serve_loop.rs:141/174/178/182
  ['shutdown_signal', { source: 'control_stop', outcome: 'operator' }],
  // resident/server/notifications.rs:100/244/129/152
  [
    'turn_completed_already_bound',
    { codex_turn_id: 'c', status: 'Completed', closed_a_different_turn: false },
  ],
  ['turn_completed_without_active_turn', { codex_turn_id: 'c' }],
  ['turn_started_already_bound', { codex_turn_id: 'c', consumed_an_admission: false }],
  ['turn_started_without_admission', { codex_turn_id: 'c' }],
  // resident/server/serve_loop.rs:52
  ['turn_settle_deadline', { deadline_seconds: 120 }],
  // resident/server/control.rs:363, fence.rs:344
  [
    'turn_start_fault_applied',
    { fault: 'lose_ack', request_id: 'r', runtime_actually_answered: true },
  ],
  ['turn_start_fault_armed', { scope: 'next_control_submission', fault: 'lose_ack' }],
  // resident/server/fence.rs:165/195
  ['uncertain_probe_failed', { message: 'x', fence_retained: true }],
  ['uncertain_unresolved', { reason: 'no_positively_correlated_turn', fence_retained: true }],
]

interface Harness {
  journalPath: string
  events: InvocationEventEnvelope[]
  warnLines: string[]
  broker: ReturnType<typeof createBroker>
  nextSequence: number
}

function descriptor(dir: string, socketPath: string, journalPath: string): ArrisHostDescriptor {
  return {
    schema: 'arris.host-descriptor/1',
    host_incarnation: {
      host_incarnation_id: fixtureHostId,
      process: {
        pid: process.pid,
        executable: process.execPath,
        os_started_at: 'fixture',
        observed_at_ms: Date.now(),
      },
    },
    readiness: { state: 'ready', since_ms: Date.now(), accepts_input: true },
    lifecycle: { host_lifecycle_owner: 'external', launch_id: null, accepts_managed_stop: false },
    control: {
      socket_path: socketPath,
      admission_classes: ['queue', 'steer'],
      unsupported_classes: ['interrupt', 'preempt', 'exclusive', 'thread-management'],
    },
    events: {
      format: 'application/x-ndjson',
      path: journalPath,
      host_incarnation_id: fixtureHostId,
      first_sequence: 1,
      last_sequence_at_publish: 0,
      tail_is_authoritative_in: 'the journal file itself',
      dropped_records: 0,
      cursor_field: 'sequence',
    },
    helpers: [],
    resident_binding: {
      visibility: 'host-private',
      thread_id: 'thread-vocabulary',
      rollout_path: join(dir, 'rollout.jsonl'),
      model_id: 'gpt-test',
      rebind_count: 0,
      bound_at_ms: Date.now(),
    },
  }
}

function spec(descriptorPath: string): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'arris', provider: 'openai', driver: 'arris-resident' },
    process: {
      command: 'participant-owned-bridge',
      args: [],
      cwd: tmpdir(),
      lockedEnv: {},
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'service', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: {
      kind: 'arris-resident',
      descriptorPath,
      hostIncarnationId: fixtureHostId,
      hostLifecycleOwner: 'external',
      launchId: null,
    },
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

/** A broker attached to a journal seeded with the T-10299 resident journal. */
async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'arris-vocabulary-'))
  const socketPath = join(dir, 'control.sock')
  const descriptorPath = join(dir, 'descriptor.json')
  const journalPath = join(dir, 'events.jsonl')
  // The control socket only answers the driver's start-up reconciliation.
  const server: Server = createServer((socket) => {
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffered.slice(0, newline)) as { id: string }
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: [] })}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await copyFile(
    join(import.meta.dir, '../../fixtures/arris/events.resident.t10299.jsonl'),
    journalPath
  )
  await writeFile(descriptorPath, JSON.stringify(descriptor(dir, socketPath, journalPath)))
  const fixtureRows = (await readFile(journalPath, 'utf8')).trim().split('\n')

  const events: InvocationEventEnvelope[] = []
  const warnLines: string[] = []
  const broker = createBroker({
    drivers: [createArrisResidentDriver({ pollIntervalMs: 10 })],
    captureDir: join(dir, 'capture'),
    logWarn: (line) => warnLines.push(line),
    onEvent: (event) => events.push(event),
  })
  cleanup.push(async () => {
    await broker.stop({ invocationId, reason: 'test cleanup' }).catch(() => undefined)
    await broker.dispose({ invocationId }).catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })
  await broker.start({ spec: spec(descriptorPath) })
  await waitFor(
    () => events.some((event) => event.type === 'turn.completed'),
    'the T-10299 journal was not replayed through the broker'
  )
  return { journalPath, events, warnLines, broker, nextSequence: fixtureRows.length + 1 }
}

async function appendKind(
  harness: Harness,
  kind: string,
  detail: Record<string, unknown>
): Promise<number> {
  const sequence = harness.nextSequence
  harness.nextSequence += 1
  await appendFile(
    harness.journalPath,
    `${JSON.stringify({ host_incarnation_id: fixtureHostId, sequence, at_ms: Date.now(), kind, detail })}\n`
  )
  return sequence
}

const blockedUnknown = (events: InvocationEventEnvelope[]) =>
  events.filter(
    (event) =>
      event.type === 'capture.warning' &&
      (event.payload as { kind?: string }).kind === 'blocked_unknown'
  )

const notice = (events: InvocationEventEnvelope[], code: string) =>
  events.find(
    (event) => event.type === 'driver.notice' && (event.payload as { code?: string }).code === code
  )

describe('Arris resident journal vocabulary through the broker (T-10324)', () => {
  test('the T-10299 resident journal replays with no blocked-unknown capture warning', async () => {
    const harness = await startHarness()
    // Let the tailer drain the trailing shutdown records too.
    await waitFor(
      () => notice(harness.events, 'ARRIS_SHUTDOWN_SIGNAL') !== undefined,
      'shutdown_signal produced no notice'
    )

    expect(blockedUnknown(harness.events)).toEqual([])
    expect(harness.warnLines).toEqual([])
    expect(notice(harness.events, 'ARRIS_CODEX_CHILD_STARTED')?.payload).toMatchObject({
      data: { pid: 99211, incarnation_seq: 1 },
    })
    expect(notice(harness.events, 'ARRIS_SHUTDOWN_SIGNAL')?.payload).toMatchObject({
      data: { source: 'sigint' },
    })
    const snapshot = await harness.broker.snapshot({ invocationId })
    expect(snapshot.capture?.blockedUnknown).toBeUndefined()
  })

  test('every kind Arris emits is mapped or ignored; a never-written kind still warns', async () => {
    const harness = await startHarness()
    for (const [kind, detail] of PREVIOUSLY_UNHANDLED) await appendKind(harness, kind, detail)
    // The sentinel is written last, so once it has warned every kind above has
    // been classified.
    await appendKind(harness, 'arris_kind_never_written', { note: 'sentinel' })
    await waitFor(
      () =>
        blockedUnknown(harness.events).some(
          (event) =>
            (event.payload as { raw: { nativeType: string } }).raw.nativeType ===
            'arris_kind_never_written'
        ),
      'the never-written sentinel kind did not reach capture.warning'
    )

    const warned = blockedUnknown(harness.events).map(
      (event) => (event.payload as { raw: { nativeType: string } }).raw.nativeType
    )
    expect(warned).toEqual(['arris_kind_never_written'])
    expect(harness.warnLines).toHaveLength(1)
    expect(harness.warnLines[0]).toContain('arris_kind_never_written')
    const snapshot = await harness.broker.snapshot({ invocationId })
    expect(snapshot.capture?.blockedUnknown?.map((entry) => entry.nativeType)).toEqual([
      'arris_kind_never_written',
    ])
    expect(notice(harness.events, 'ARRIS_CODEX_CHILD_EXITED')?.payload).toMatchObject({
      data: { pid: 99211, planned: false, signal: 9 },
    })
    expect(notice(harness.events, 'ARRIS_SHUTDOWN_SIGNAL')).toBeDefined()
  })

  test('a turn ended by a Codex child exit completes as interrupted', async () => {
    const harness = await startHarness()
    await appendKind(harness, 'turn_started', {
      origin: 'host',
      codex_turn_id: 'codex-exit-turn',
      neutral_turn_id: 'turn:child-exit',
    })
    await appendKind(harness, 'turn_ended_by_child_exit', {
      conversation: 'thread-vocabulary',
      codex_turn_id: 'codex-exit-turn',
      neutral_turn_id: 'turn:child-exit',
    })
    await waitFor(
      () =>
        harness.events.some(
          (event) =>
            event.type === 'turn.completed' &&
            (event.payload as { turnId?: string }).turnId === 'turn:child-exit'
        ),
      'turn_ended_by_child_exit left the turn open'
    )
    const completed = harness.events.find(
      (event) =>
        event.type === 'turn.completed' &&
        (event.payload as { turnId?: string }).turnId === 'turn:child-exit'
    )
    expect(completed?.payload).toMatchObject({ status: 'interrupted', producedContent: false })
    expect(blockedUnknown(harness.events)).toEqual([])
  })
})
