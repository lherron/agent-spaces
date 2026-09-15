import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ArrisControlReceipt,
  ArrisHostDescriptor,
  ArrisInputIdentity,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createArrisResidentDriver } from '../../../src/drivers/arris-resident/driver'

const hostId = 'host-incarnation:socket-integration'
const invocationId = 'inv-arris-socket' as InvocationId
const origin: SubmissionOrigin = {
  principalRef: 'agent:test',
  scopeRef: 'test@agent-spaces',
}
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

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
      hostIncarnationId: hostId,
      hostLifecycleOwner: 'external',
      launchId: null,
    },
  }
}

function receipt(
  identity: ArrisInputIdentity,
  kind: 'queue' | 'steer',
  outcome: ArrisControlReceipt['outcome']
): ArrisControlReceipt {
  return {
    receipt_id: `receipt:${identity.input_id}`,
    host_incarnation_id: hostId,
    identity,
    kind,
    target_neutral_turn_id: null,
    recorded_at_ms: Date.now(),
    neutral_turn_id: outcome.outcome === 'written' ? outcome.neutral_turn_id : null,
    outcome,
    outcome_at_ms: Date.now(),
    presentation: null,
    completion: null,
    attempts_seen: Array.from({ length: identity.attempt }, (_, index) => index + 1),
    resolution_note: null,
    prior_dispositions: [],
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

describe('Arris resident broker over a real control socket', () => {
  test('retries one durable envelope after busy and never turns an idle steer into queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arris-broker-control-'))
    const socketPath = join(dir, 'control.sock')
    const descriptorPath = join(dir, 'descriptor.json')
    const journalPath = join(dir, 'events.jsonl')
    const operations: Array<{ op: string; identity?: ArrisInputIdentity }> = []
    let queueCalls = 0
    const server: Server = createServer((socket) => {
      let buffered = ''
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        const request = JSON.parse(buffered.slice(0, newline)) as {
          id: string
          op: string
          identity?: ArrisInputIdentity
        }
        operations.push({
          op: request.op,
          ...(request.identity !== undefined ? { identity: request.identity } : {}),
        })
        let result: unknown = []
        if (request.op === 'queue' && request.identity !== undefined) {
          queueCalls += 1
          result = receipt(
            request.identity,
            'queue',
            queueCalls === 1
              ? {
                  outcome: 'not_written',
                  code: 'host_busy',
                  message: 'local turn won the idle slot',
                  eligible_for_retry: true,
                  requeue_as_input_permitted: false,
                }
              : {
                  outcome: 'written',
                  neutral_turn_id: 'turn:socket-1',
                  codex_turn_id: null,
                }
          )
        } else if (request.op === 'steer' && request.identity !== undefined) {
          result = receipt(request.identity, 'steer', {
            outcome: 'not_written',
            code: 'turn_not_active',
            message: 'there is no active root turn',
            eligible_for_retry: false,
            requeue_as_input_permitted: true,
          })
        }
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    })
    await writeFile(journalPath, '')
    const descriptor: ArrisHostDescriptor = {
      schema: 'arris.host-descriptor/1',
      host_incarnation: {
        host_incarnation_id: hostId,
        process: {
          pid: process.pid,
          executable: process.execPath,
          os_started_at: 'fixture',
          observed_at_ms: Date.now(),
        },
      },
      readiness: { state: 'ready', since_ms: Date.now(), accepts_input: true },
      lifecycle: {
        host_lifecycle_owner: 'external',
        launch_id: null,
        accepts_managed_stop: false,
      },
      control: {
        socket_path: socketPath,
        admission_classes: ['queue', 'steer'],
        unsupported_classes: ['interrupt', 'preempt', 'exclusive', 'thread-management'],
      },
      events: {
        format: 'application/x-ndjson',
        path: journalPath,
        host_incarnation_id: hostId,
        first_sequence: 1,
        last_sequence_at_publish: 0,
        tail_is_authoritative_in: 'the journal file itself',
        dropped_records: 0,
        cursor_field: 'sequence',
      },
      helpers: [],
      resident_binding: {
        visibility: 'host-private',
        thread_id: 'thread-socket',
        rollout_path: join(dir, 'rollout.jsonl'),
        model_id: 'gpt-test',
        rebind_count: 0,
        bound_at_ms: Date.now(),
      },
    }
    await writeFile(descriptorPath, JSON.stringify(descriptor))

    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createArrisResidentDriver({ pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
    })
    await broker.start({ spec: spec(descriptorPath) })
    const steer = await broker.steer({
      invocationId,
      origin: { ...origin, envelopeId: 'EN-steer-idle' },
      body: 'must remain a steer',
    })
    expect(steer.admission).toBe('admitted')
    await waitFor(
      () => operations.some((entry) => entry.op === 'steer'),
      'idle steer did not reach Arris'
    )
    expect(operations.filter((entry) => entry.op === 'queue')).toHaveLength(0)
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'submission.rejected' &&
            (event.payload as { submissionId?: string }).submissionId === steer.submissionId
        ),
      'idle steer refusal was not projected'
    )

    const admitted = await broker.enqueue({
      invocationId,
      origin: { ...origin, envelopeId: 'EN-socket-1' },
      body: 'queue exactly once',
    })
    await waitFor(() => queueCalls === 1, 'first queue attempt did not reach Arris')
    expect((await broker.queueList({ invocationId })).entries).toHaveLength(1)

    await appendFile(
      journalPath,
      `${JSON.stringify({
        host_incarnation_id: hostId,
        sequence: 1,
        at_ms: Date.now(),
        kind: 'host_readiness_changed',
        detail: { to: { accepts_input: true } },
      })}\n`
    )
    await waitFor(() => queueCalls === 2, 'held submission was not retried')
    expect((await broker.queueList({ invocationId })).entries).toHaveLength(0)
    expect(
      operations.filter((entry) => entry.op === 'queue').map((entry) => entry.identity)
    ).toEqual([
      { platform: 'hrc', input_id: 'EN-socket-1', envelope_id: 'EN-socket-1', attempt: 1 },
      { platform: 'hrc', input_id: 'EN-socket-1', envelope_id: 'EN-socket-1', attempt: 2 },
    ])
    expect(admitted.admission).toBe('admitted')
    await broker.stop({ invocationId, reason: 'integration test cleanup' })
    await broker.dispose({ invocationId })
  })
})
