import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ArrisControlReceipt,
  ArrisHostDescriptor,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
  RawProviderRecord,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { CapturedRecord } from '../../../src/capture/capture-gate'
import type { ArrisControlClient } from '../../../src/drivers/arris-resident/control-client'
import {
  ArrisRetryableNotWrittenError,
  createArrisResidentDriver,
} from '../../../src/drivers/arris-resident/driver'
import type { DriverContext } from '../../../src/drivers/driver'

const hostId = 'host-incarnation:0fff54f7-f6f7-473b-8776-1ba07803f87d'

function descriptor(overrides: Partial<ArrisHostDescriptor> = {}): ArrisHostDescriptor {
  return {
    schema: 'arris.host-descriptor/1',
    host_incarnation: {
      host_incarnation_id: hostId,
      process: {
        pid: 4242,
        executable: '/opt/arris/bin/resident-arris-serve',
        os_started_at: 'Tue Sep 15 12:31:49 2026',
        observed_at_ms: 1,
      },
    },
    readiness: { state: 'ready', since_ms: 2, accepts_input: true },
    lifecycle: { host_lifecycle_owner: 'external', launch_id: null, accepts_managed_stop: false },
    control: {
      socket_path: '/tmp/arris-control.sock',
      admission_classes: ['queue', 'steer'],
      unsupported_classes: ['interrupt', 'preempt', 'exclusive', 'thread-management'],
    },
    events: {
      format: 'application/x-ndjson',
      path: '/tmp/arris-events.jsonl',
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
      thread_id: 'thread-arris',
      rollout_path: '/tmp/rollout.jsonl',
      model_id: 'gpt-test',
      rebind_count: 0,
      bound_at_ms: 1,
    },
    ...overrides,
  }
}

function spec(): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: 'inv-arris' as InvocationId,
    harness: { frontend: 'arris', provider: 'openai', driver: 'arris-resident' },
    process: {
      command: 'participant-owned-bridge',
      args: [],
      cwd: '/tmp',
      lockedEnv: {},
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'service', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: {
      kind: 'arris-resident',
      descriptorPath: '/tmp/host-descriptor.json',
      hostIncarnationId: hostId,
      hostLifecycleOwner: 'external',
      launchId: null,
    },
  }
}

function receipt(
  inputId: string,
  attempt: number,
  outcome: ArrisControlReceipt['outcome']
): ArrisControlReceipt {
  return {
    receipt_id: `receipt:${inputId}`,
    host_incarnation_id: hostId,
    identity: { platform: 'hrc', input_id: inputId, envelope_id: inputId, attempt: 1 },
    kind: 'queue',
    target_neutral_turn_id: null,
    recorded_at_ms: 1,
    neutral_turn_id: outcome.outcome === 'written' ? outcome.neutral_turn_id : null,
    outcome,
    outcome_at_ms: 2,
    presentation:
      outcome.outcome === 'written' && outcome.codex_turn_id !== null
        ? { codex_turn_id: outcome.codex_turn_id, at_ms: 2 }
        : null,
    completion: null,
    attempts_seen: Array.from({ length: attempt }, (_, index) => index + 1),
    resolution_note: null,
    prior_dispositions: [],
  }
}

function context(events: InvocationEventEnvelope[]): DriverContext {
  return {
    invocationId: 'inv-arris' as InvocationId,
    clientCapabilities: {},
    emit(type, payload, extra) {
      const event = {
        seq: events.length + 1,
        time: new Date().toISOString(),
        invocationId: 'inv-arris',
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event as never
    },
    emitEvent() {
      throw new Error('unused')
    },
  }
}

function client(overrides: Partial<ArrisControlClient>): ArrisControlClient {
  return {
    descriptor: async () => descriptor(),
    readiness: async () => descriptor().readiness,
    queue: async () => {
      throw new Error('unexpected queue')
    },
    steer: async () => {
      throw new Error('unexpected steer')
    },
    lookup: async () => null,
    unresolved: async () => [],
    ...overrides,
  }
}

function captured(sequence: number, kind: string, detail: Record<string, unknown>): CapturedRecord {
  const row = {
    host_incarnation_id: hostId,
    sequence,
    at_ms: sequence,
    kind,
    detail,
  }
  const record: RawProviderRecord = {
    rawRecordId: `raw-${sequence}`,
    invocationId: 'inv-arris' as InvocationId,
    provider: 'openai',
    driverKind: 'arris-resident',
    sourceKind: 'provider-jsonl',
    sourceEpoch: hostId,
    sourceCursor: { nativeSequence: String(sequence) },
    nativeType: kind,
    observedAt: new Date(sequence).toISOString(),
    sha256: `fixture-${sequence}`,
    rawBytes: Buffer.from(JSON.stringify(row)),
  }
  return {
    record,
    provenance: () => ({
      rawRecordId: record.rawRecordId,
      sourceKind: record.sourceKind,
      sourceEpoch: record.sourceEpoch,
      sourceCursor: record.sourceCursor,
      nativeType: kind,
    }),
  }
}

describe('Arris resident driver control seam', () => {
  test('preserves broker identity and targets steer at the written neutral turn', async () => {
    const events: InvocationEventEnvelope[] = []
    const queueIdentities: unknown[] = []
    const steerTargets: unknown[] = []
    const control = client({
      async queue(identity) {
        queueIdentities.push(identity)
        return receipt(identity.input_id, identity.attempt, {
          outcome: 'written',
          neutral_turn_id: 'turn:neutral-1',
          codex_turn_id: 'turn-codex-1',
        })
      },
      async steer(identity, target) {
        steerTargets.push({ identity, target })
        return {
          ...receipt(identity.input_id, identity.attempt, {
            outcome: 'written',
            neutral_turn_id: 'turn:neutral-1',
            codex_turn_id: 'turn-codex-1',
          }),
          kind: 'steer',
          target_neutral_turn_id: target,
        }
      },
    })
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => descriptor(),
      createControlClient: () => control,
    })
    await driver.start(spec(), context(events))

    await expect(
      driver.applyInputNow({
        inputId: 'submission-1' as never,
        kind: 'user',
        content: [{ type: 'text', text: 'queue me' }],
        metadata: { envelopeId: 'EN-1', principalRef: 'agent:lance' },
      })
    ).resolves.toEqual({ turnId: 'turn:neutral-1' })
    await driver.applySteerNow?.({
      inputId: 'submission-2' as never,
      kind: 'user',
      content: [{ type: 'text', text: 'steer me' }],
      metadata: { envelopeId: 'EN-2' },
    })

    expect(queueIdentities).toEqual([
      { platform: 'hrc', input_id: 'EN-1', envelope_id: 'EN-1', attempt: 1 },
    ])
    expect(steerTargets).toEqual([
      {
        identity: {
          platform: 'hrc',
          input_id: 'EN-2',
          envelope_id: 'EN-2',
          attempt: 1,
        },
        target: 'turn:neutral-1',
      },
    ])
    expect(events.filter((event) => event.type === 'driver.notice')).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'driver.notice').map((event) => event.inputId)
    ).toEqual(['submission-1', 'submission-2'])
    await driver.dispose()
  })

  test('marks eligible not-written as retryable and advances the same input attempt', async () => {
    const attempts: number[] = []
    const control = client({
      async queue(identity) {
        attempts.push(identity.attempt)
        return receipt(identity.input_id, identity.attempt, {
          outcome: 'not_written',
          code: 'host_busy',
          message: 'host is busy',
          eligible_for_retry: true,
          requeue_as_input_permitted: false,
        })
      },
    })
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => descriptor(),
      createControlClient: () => control,
    })
    await driver.start(spec(), context([]))
    const input = {
      inputId: 'submission-busy' as never,
      kind: 'user' as const,
      content: [{ type: 'text' as const, text: 'later' }],
      metadata: { envelopeId: 'EN-1' },
    }

    for (const expected of [1, 2]) {
      try {
        await driver.applyInputNow(input)
        throw new Error('expected retryable refusal')
      } catch (error) {
        expect(error).toBeInstanceOf(ArrisRetryableNotWrittenError)
        expect((error as ArrisRetryableNotWrittenError).retryableNotWritten).toBe(true)
        expect((error as { deliveryEvidence?: string }).deliveryEvidence).toBe('not_written')
      }
      expect(attempts.at(-1)).toBe(expected)
      expect(driver.probeAdmissionState?.()).toEqual({ harnessLocalQueueDepth: 1 })
    }
    await driver.dispose()
  })

  test('rejects a descriptor for another host before control entry', async () => {
    const driver = createArrisResidentDriver({
      readDescriptor: async () =>
        descriptor({
          host_incarnation: {
            ...descriptor().host_incarnation,
            host_incarnation_id: 'host-incarnation:foreign',
          },
          events: {
            ...descriptor().events,
            host_incarnation_id: 'host-incarnation:foreign',
          },
        }),
    })
    await expect(driver.start(spec(), context([]))).rejects.toMatchObject({
      code: BrokerErrorCode.IdentityInstallConflict,
    })
  })

  test('reconciles an unresolved lost acknowledgement after bridge restart without replay', async () => {
    const indeterminate = receipt('EN-lost', 1, {
      outcome: 'indeterminate',
      code: 'acknowledgement_lost',
      message: 'write acknowledgement was lost',
    })
    let queueCalls = 0
    let lookupCalls = 0
    const control = client({
      async unresolved() {
        return [indeterminate]
      },
      async lookup(identity) {
        lookupCalls += 1
        expect(identity).toEqual(indeterminate.identity)
        return indeterminate
      },
      async queue() {
        queueCalls += 1
        throw new Error('indeterminate input must not be replayed')
      },
    })
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => descriptor(),
      createControlClient: () => control,
    })
    const events: InvocationEventEnvelope[] = []
    await driver.start(spec(), context(events))

    await expect(
      driver.applyInputNow({
        inputId: 'new-broker-submission' as never,
        kind: 'user',
        content: [{ type: 'text', text: 'do not replay me' }],
        metadata: { envelopeId: 'EN-lost' },
      })
    ).resolves.toEqual({})

    expect(lookupCalls).toBe(1)
    expect(queueCalls).toBe(0)
    expect(events.findLast((event) => event.type === 'driver.notice')?.inputId).toBe(
      'new-broker-submission'
    )
    await driver.dispose()
  })

  test('maps root output and host-admitted tools while preserving child activity as provenance', async () => {
    const events: InvocationEventEnvelope[] = []
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => descriptor(),
      createControlClient: () => client({}),
    })
    await driver.start(spec(), context(events))
    const normalize = driver.captureNormalizer?.()
    if (normalize === undefined) throw new Error('Arris normalizer missing')

    expect(
      normalize(
        captured(1, 'turn_started', {
          origin: 'control',
          codex_turn_id: 'codex-root',
          neutral_turn_id: 'turn:root',
        })
      ).disposition
    ).toBe('normalized')
    normalize(
      captured(2, 'item_observed', {
        phase: 'completed',
        item_type: 'sub_agent_activity',
        event_source: 'internal_child',
        codex_turn_id: 'codex-root',
        thread_id: 'child-1',
        from_child_thread: true,
        observed_child: true,
        spawned_children: [],
        mints_identity: false,
      })
    )
    normalize(
      captured(3, 'dynamic_tool_call_answered', {
        responder: 'arris_host',
        event_source: 'arris_host_admitted',
        from_child_thread: true,
        child_thread_id: 'child-1',
        caller_attribution: 'own_turn_caller',
        mints_identity: false,
        tool: 'render_diagram',
        codex_turn_id: 'codex-root',
        action_id: 'action-1',
        success: true,
      })
    )
    normalize(captured(4, 'assistant_text_delta', { codex_turn_id: 'codex-root', delta: 'Done' }))
    normalize(
      captured(5, 'child_turn_completed_ignored', {
        child_thread_id: 'child-1',
        codex_turn_id: 'codex-child',
        status: 'Completed',
        root_turn_closed: false,
        host_turn_transitioned: false,
      })
    )
    normalize(
      captured(6, 'turn_completed', {
        origin: 'control',
        codex_turn_id: 'codex-root',
        neutral_turn_id: 'turn:root',
        status: 'Completed',
        host_state: 'Finished',
      })
    )

    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'driver.notice')?.payload).toMatchObject({
      code: 'ARRIS_ITEM_OBSERVED',
      data: { event_source: 'internal_child', mints_identity: false },
    })
    expect(events.filter((event) => event.type === 'tool.call.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool.call.completed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'Done',
      producedContent: true,
    })
    await driver.dispose()
  })

  test('replays the pinned ca7e110 root-turn journal fixture to one final response', async () => {
    const events: InvocationEventEnvelope[] = []
    const driver = createArrisResidentDriver({
      pollIntervalMs: 60_000,
      readDescriptor: async () => descriptor(),
      createControlClient: () => client({}),
    })
    await driver.start(spec(), context(events))
    const normalize = driver.captureNormalizer?.()
    if (normalize === undefined) throw new Error('Arris normalizer missing')
    const fixture = await readFile(
      join(import.meta.dir, '../../fixtures/arris/events.root-turn.ca7e110.jsonl'),
      'utf8'
    )
    const rows = fixture.trim().split('\n')
    for (const line of rows) {
      const row = JSON.parse(line) as {
        sequence: number
        kind: string
        detail: Record<string, unknown>
      }
      expect(normalize(captured(row.sequence, row.kind, row.detail)).disposition).not.toBe(
        'blocked-unknown'
      )
    }
    for (const line of rows) {
      const row = JSON.parse(line) as {
        sequence: number
        kind: string
        detail: Record<string, unknown>
      }
      expect(normalize(captured(row.sequence, row.kind, row.detail)).disposition).toBe('duplicate')
    }

    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'Ready',
      producedContent: true,
    })
    await driver.dispose()
  })
})
