import type {
  ArrisControlReceipt,
  ArrisHostDescriptor,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
  RawProviderRecord,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord } from '../../../src/capture/capture-gate'
import type { ArrisControlClient } from '../../../src/drivers/arris-resident/control-client'
import type { DriverContext } from '../../../src/drivers/driver'

/** Shared builders for the Arris resident driver tests: one host, one spec, scripted control. */
export const hostId = 'host-incarnation:0fff54f7-f6f7-473b-8776-1ba07803f87d'

export function descriptor(overrides: Partial<ArrisHostDescriptor> = {}): ArrisHostDescriptor {
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

export function spec(): HarnessInvocationSpec {
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

export function receipt(
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

export function context(events: InvocationEventEnvelope[]): DriverContext {
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

export function client(overrides: Partial<ArrisControlClient>): ArrisControlClient {
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

export function captured(
  sequence: number,
  kind: string,
  detail: Record<string, unknown>
): CapturedRecord {
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
      sourceCursor: { nativeSequence: String(sequence) },
      nativeType: kind,
      normalizer: { name: 'arris-resident-fixture', version: '1' },
    }),
  }
}
