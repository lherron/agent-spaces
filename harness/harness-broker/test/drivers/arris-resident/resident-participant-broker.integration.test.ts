import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ResidentProductConfig,
  createArrisParticipantAdapter,
  createResidentParticipantAdapter,
} from 'agent-spaces'
import type {
  ArrisControlReceipt,
  ArrisHostDescriptor,
  ArrisInputIdentity,
  BrokerRuntimeIdentity,
  InvocationEventEnvelope,
  InvocationId,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'
import { validateParticipantAdapterPreparation } from 'spaces-runtime-contracts'
import { createBroker } from '../../../src/broker'
import { createArrisResidentDriver } from '../../../src/drivers/arris-resident/driver'

/**
 * T-08666: one maintained resident-participant mechanism serves both the Arris
 * compatibility configuration and a nonvisual product configuration over the
 * real published validator and the real broker install/ensure/submission path.
 *
 * Each leg runs an isolated fake resident host (control socket + descriptor +
 * journal) and an isolated in-process broker. The fake speaks the exact
 * control operations the maintained `arris-resident` driver uses; the driver
 * itself is never copied or forked.
 */

const NONVISUAL_PRODUCT: ResidentProductConfig = {
  productId: 'nonvisual-resident-product',
  frontend: 'nonvisual',
  processCommand: 'nonvisual-resident-external',
  profilePath: 'lib/nonvisual-resident-product/profile/agent-profile.toml',
}

const origin: SubmissionOrigin = {
  principalRef: 'agent:t08666',
  scopeRef: 't08666@agent-spaces',
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

function writtenReceipt(
  hostId: string,
  identity: ArrisInputIdentity,
  kind: 'queue' | 'steer',
  neutralTurnId: string
): ArrisControlReceipt {
  return {
    receipt_id: `receipt:${identity.input_id}`,
    host_incarnation_id: hostId,
    identity,
    kind,
    target_neutral_turn_id: null,
    recorded_at_ms: Date.now(),
    neutral_turn_id: neutralTurnId,
    outcome: { outcome: 'written', neutral_turn_id: neutralTurnId, codex_turn_id: null },
    outcome_at_ms: Date.now(),
    presentation: null,
    completion: null,
    attempts_seen: Array.from({ length: identity.attempt }, (_, index) => index + 1),
    resolution_note: null,
    prior_dispositions: [],
  }
}

type FakeHost = {
  dir: string
  socketPath: string
  descriptorPath: string
  hostId: string
  descriptor: ArrisHostDescriptor
  operations: Array<{ op: string; identity?: ArrisInputIdentity }>
}

async function startFakeHost(hostSuffix: string): Promise<FakeHost> {
  const dir = await mkdtemp(join(tmpdir(), `t08666-resident-${hostSuffix}-`))
  const socketPath = join(dir, 'control.sock')
  const descriptorPath = join(dir, 'host-descriptor.json')
  const journalPath = join(dir, 'events.jsonl')
  const hostId = `host-incarnation:t08666-${hostSuffix}`
  const operations: Array<{ op: string; identity?: ArrisInputIdentity }> = []
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
    // Internal threads/helpers share this host; they must never mint seats.
    helpers: [
      { kind: 'control_client', id: 'connection:1', first_seen_ms: Date.now() },
      { kind: 'attached_client', id: 'connection:0', first_seen_ms: Date.now() },
    ],
    resident_binding: {
      visibility: 'host-private',
      thread_id: `thread-t08666-${hostSuffix}`,
      rollout_path: join(dir, 'rollout.jsonl'),
      model_id: 'test-model',
      rebind_count: 0,
      bound_at_ms: Date.now(),
    },
  }
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
      if (request.op === 'descriptor') result = descriptor
      else if (request.op === 'readiness') result = descriptor.readiness
      else if (request.op === 'lookup') result = null
      else if (
        (request.op === 'queue' || request.op === 'steer') &&
        request.identity !== undefined
      ) {
        result = writtenReceipt(hostId, request.identity, request.op, `turn:t08666-${hostSuffix}-1`)
      }
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await writeFile(journalPath, '')
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, socketPath, descriptorPath, hostId, descriptor, operations }
}

describe('Resident participant broker path (T-08666)', () => {
  test.each([
    ['arris', 'participant-served' as const],
    ['nonvisual', 'participant-served' as const],
  ])(
    '%s product: validator admits, ensure starts, queue/steer reach the host',
    async (productName) => {
      const fake = await startFakeHost(productName)
      const participantKey = `${productName}:primary`
      const invocationId = `inv-t08666-${productName}` as InvocationId
      const adapter =
        productName === 'arris'
          ? createArrisParticipantAdapter({ workspaceCwd: fake.dir, participantKey })
          : createResidentParticipantAdapter({
              workspaceCwd: fake.dir,
              participantKey,
              product: NONVISUAL_PRODUCT,
            })
      const admission = await adapter.admit({
        classId: 'arris-resident',
        join: 'participant-served',
        evidence: { schema: 'arris.participant-evidence/1', descriptorPath: fake.descriptorPath },
      })
      if (admission.status !== 'admitted') throw new Error(`${productName} was not admitted`)
      const identity = {
        requestId: `request:t08666-${productName}` as never,
        operationId: `runtimeOperation:t08666-${productName}` as never,
        hostSessionId: `hostSession:t08666-${productName}` as never,
        generation: 3,
        runtimeId: `runtime:t08666-${productName}` as never,
        invocationId,
      }
      const preparationRequest = {
        classId: 'arris-resident',
        join: 'participant-served' as const,
        participantKey: admission.participantKey,
        workspaceCwd: admission.workspaceCwd,
        preparation: admission.preparation,
        identity,
        scopeRef: `${productName}@t08666:primary`,
        laneRef: 'main',
        attachEpoch: 1,
      }
      const prepared = await adapter.prepare(preparationRequest)
      expect(validateParticipantAdapterPreparation(preparationRequest, prepared).ok).toBe(true)
      if (prepared.status !== 'prepared') throw new Error(`${productName} was not prepared`)

      const startRequest = prepared.descriptor.harnessInvocation.startRequest
      // The REAL published protocol validator — the refusal T-08503 missed by
      // driving createBroker directly.
      expect(() => validateInvocationStartRequest(startRequest)).not.toThrow()

      const events: InvocationEventEnvelope[] = []
      const broker = createBroker({
        drivers: [createArrisResidentDriver({ pollIntervalMs: 10 })],
        onEvent: (event) => events.push(event),
      })
      cleanup.push(async () => {
        await broker.dispose({ invocationId }).catch(() => {})
      })

      // The REAL broker launch/register path: install the runtime identity,
      // then ensure the invocation with a durable at-most-once receipt.
      const install: BrokerRuntimeIdentity = {
        runtimeId: identity.runtimeId as string,
        hostSessionId: identity.hostSessionId as string,
        generation: identity.generation,
        attachEpoch: 1,
        invocationId,
        startRequestHash: prepared.descriptor.harnessInvocation.startRequestHash,
        selectedProfileHash: prepared.descriptor.descriptorHash,
        attachToken: `attach:t08666-${productName}`,
      }
      const installed = await broker.installIdentity(install)
      expect(installed).toMatchObject({ installed: true, invocationId })
      const ensured = await broker.ensureInvocation({
        startAttemptId: `attempt:t08666-${productName}-1`,
        invocationId,
        attachEpoch: 1,
        startRequest,
      })
      expect(ensured.receipt).toMatchObject({ state: 'started' })

      // A duplicate attempt replays the same receipt; the driver is not
      // started twice (no double-start behind one attempt id).
      const duplicateEnsure = await broker.ensureInvocation({
        startAttemptId: `attempt:t08666-${productName}-1`,
        invocationId,
        attachEpoch: 1,
        startRequest,
      })
      expect(duplicateEnsure.receipt).toMatchObject({
        state: 'started',
        requestDigest: ensured.receipt.requestDigest,
      })
      expect(events.filter((event) => event.type === 'invocation.started')).toHaveLength(1)

      // Addressed queue reaches the external host and is written.
      const enqueued = await broker.enqueue({
        invocationId,
        origin: { ...origin, envelopeId: `EN-t08666-${productName}-queue-1` },
        body: `${productName} queue body`,
      })
      expect(enqueued.admission).toBe('admitted')
      await waitFor(
        () => fake.operations.some((entry) => entry.op === 'queue'),
        `${productName} queue did not reach the host`
      )

      // Steer is delivered to the running host turn, never silently dropped.
      const steered = await broker.steer({
        invocationId,
        origin: { ...origin, envelopeId: `EN-t08666-${productName}-steer-1` },
        body: `${productName} steer body`,
      })
      expect(steered.admission).toBe('admitted')
      await waitFor(
        () => fake.operations.some((entry) => entry.op === 'steer'),
        `${productName} steer did not reach the host`
      )

      // Helpers recorded in the descriptor never minted seats: exactly one
      // broker invocation exists despite two helper entries.
      const listed = await broker.listInvocations({})
      expect(listed.invocations.map((entry) => entry.invocationId)).toEqual([invocationId])
      const snapshot = await broker.snapshot({ invocationId })
      expect(snapshot.seat).toBeDefined()

      // Broker stop/dispose tears down the bridge only: the control protocol
      // carries no host kill, and the external host stays alive for reconnect.
      await broker.stop({ invocationId, reason: 't08666 leg cleanup' })
      await broker.dispose({ invocationId })
      expect(fake.operations.map((entry) => entry.op)).not.toContain('stop')
      expect(fake.operations.map((entry) => entry.op)).not.toContain('kill')

      // Controller reconnect to the same incarnation keeps runtime continuity:
      // the untouched host serves a fresh ensure with the same incarnation key.
      const reconnected = await broker.ensureInvocation({
        startAttemptId: `attempt:t08666-${productName}-2`,
        invocationId,
        attachEpoch: 1,
        startRequest,
      })
      expect(reconnected.receipt).toMatchObject({ state: 'started' })
      const resnapshot = await broker.snapshot({ invocationId })
      expect(resnapshot.continuation).toMatchObject({
        provider: 'arris',
        kind: 'host-incarnation',
        key: fake.hostId,
      })
      const readmission = await adapter.admit({
        classId: 'arris-resident',
        join: 'participant-served',
        participantKey,
        evidence: { schema: 'arris.participant-evidence/1', descriptorPath: fake.descriptorPath },
      })
      expect(readmission).toMatchObject({
        status: 'admitted',
        participantKey,
        continuityEvidence: { host_incarnation_id: fake.hostId },
      })
      await broker.stop({ invocationId, reason: 't08666 leg cleanup' })
      await broker.dispose({ invocationId })
    },
    60_000
  )

  test('unknown driver kind fails before driver entry; foreign incarnation is indeterminate', async () => {
    // The factory keeps one maintained mechanism: a foreign driver kind would
    // select a different lifecycle, so it refuses at construction.
    expect(() =>
      createResidentParticipantAdapter({
        workspaceCwd: tmpdir(),
        product: { ...NONVISUAL_PRODUCT, driverKind: 'no-such-driver' },
      })
    ).toThrow(expect.objectContaining({ message: expect.stringContaining('maintained') }))

    // Malformed traffic that bypasses the factory still refuses predictably on
    // the real path. The composed profile always declares in-process
    // transport, which the published validator reserves for known drivers.
    const fakeUnknown = await startFakeHost('unknown-driver')
    const unknownAdapter = createResidentParticipantAdapter({
      workspaceCwd: fakeUnknown.dir,
      participantKey: 'nonvisual:unknown-driver',
      product: NONVISUAL_PRODUCT,
    })
    const unknownAdmission = await unknownAdapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      evidence: {
        schema: 'arris.participant-evidence/1',
        descriptorPath: fakeUnknown.descriptorPath,
      },
    })
    if (unknownAdmission.status !== 'admitted') throw new Error('unknown-driver was not admitted')
    const unknownInvocationId = 'inv-t08666-unknown-driver' as InvocationId
    const unknownIdentity = {
      requestId: 'request:t08666-unknown-driver' as never,
      operationId: 'runtimeOperation:t08666-unknown-driver' as never,
      hostSessionId: 'hostSession:t08666-unknown-driver' as never,
      generation: 3,
      runtimeId: 'runtime:t08666-unknown-driver' as never,
      invocationId: unknownInvocationId,
    }
    const unknownPrepared = await unknownAdapter.prepare({
      classId: 'arris-resident',
      join: 'participant-served',
      participantKey: unknownAdmission.participantKey,
      workspaceCwd: unknownAdmission.workspaceCwd,
      preparation: unknownAdmission.preparation,
      identity: unknownIdentity,
      scopeRef: 'nonvisual@t08666:unknown-driver',
      laneRef: 'main',
      attachEpoch: 1,
    })
    if (unknownPrepared.status !== 'prepared') throw new Error('unknown-driver was not prepared')
    const unknownBroker = createBroker({
      drivers: [createArrisResidentDriver({ pollIntervalMs: 10 })],
    })
    cleanup.push(async () => {
      await unknownBroker.dispose({ invocationId: unknownInvocationId }).catch(() => {})
    })
    const tampered = structuredClone(unknownPrepared.descriptor.harnessInvocation.startRequest)
    tampered.spec.harness.driver = 'no-such-driver'
    ;(tampered.spec.driver as Record<string, unknown>)['kind'] = 'no-such-driver'
    await expect(
      unknownBroker.ensureInvocation({
        startAttemptId: 'attempt:t08666-unknown-driver',
        invocationId: unknownInvocationId,
        attachEpoch: 1,
        startRequest: tampered,
      })
    ).rejects.toMatchObject({ code: -32602 })
    // With a transport the wire validator permits, the same malformed kind
    // reaches establishment and fails definitively before driver entry. The
    // correlation hashes are re-stamped so the installed identity matches;
    // establishment only equates them, and the refusal under test is the
    // missing driver registration.
    const piped = structuredClone(tampered)
    ;(piped.spec.process.harnessTransport as Record<string, unknown>)['kind'] = 'pipes'
    piped.spec.correlation['startRequestHash'] = 'restamped:t08666-unknown-driver'
    piped.spec.correlation['selectedProfileHash'] = 'restamped:t08666-unknown-driver'
    await unknownBroker.installIdentity({
      runtimeId: unknownIdentity.runtimeId as string,
      hostSessionId: unknownIdentity.hostSessionId as string,
      generation: unknownIdentity.generation,
      attachEpoch: 1,
      invocationId: unknownInvocationId,
      startRequestHash: 'restamped:t08666-unknown-driver',
      selectedProfileHash: 'restamped:t08666-unknown-driver',
      attachToken: 'attach:t08666-unknown-driver',
    })
    const unknown = await unknownBroker.ensureInvocation({
      startAttemptId: 'attempt:t08666-unknown-driver-pipes',
      invocationId: unknownInvocationId,
      attachEpoch: 1,
      startRequest: piped,
    })
    expect(unknown.receipt).toMatchObject({ state: 'failed' })
    expect(unknown.receipt.failure?.message ?? '').toMatch(/no-such-driver/i)

    // A start request that no longer matches the live descriptor reaches the
    // driver, which refuses the foreign host; the outcome is honestly
    // indeterminate rather than failed.
    const foreignBroker = createBroker({
      drivers: [createArrisResidentDriver({ pollIntervalMs: 10 })],
    })
    const foreignInvocationId = 'inv-t08666-foreign' as InvocationId
    cleanup.push(async () => {
      await foreignBroker.dispose({ invocationId: foreignInvocationId }).catch(() => {})
    })
    const fakeForeign = await startFakeHost('foreign')
    const foreignAdapter = createResidentParticipantAdapter({
      workspaceCwd: fakeForeign.dir,
      participantKey: 'nonvisual:foreign',
      product: NONVISUAL_PRODUCT,
    })
    const foreignAdmission = await foreignAdapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      evidence: {
        schema: 'arris.participant-evidence/1',
        descriptorPath: fakeForeign.descriptorPath,
      },
    })
    if (foreignAdmission.status !== 'admitted') throw new Error('foreign fixture was not admitted')
    const foreignIdentity = {
      requestId: 'request:t08666-foreign' as never,
      operationId: 'runtimeOperation:t08666-foreign' as never,
      hostSessionId: 'hostSession:t08666-foreign' as never,
      generation: 3,
      runtimeId: 'runtime:t08666-foreign' as never,
      invocationId: foreignInvocationId,
    }
    const foreignPrepared = await foreignAdapter.prepare({
      classId: 'arris-resident',
      join: 'participant-served',
      participantKey: foreignAdmission.participantKey,
      workspaceCwd: foreignAdmission.workspaceCwd,
      preparation: foreignAdmission.preparation,
      identity: foreignIdentity,
      scopeRef: 'nonvisual@t08666:foreign',
      laneRef: 'main',
      attachEpoch: 1,
    })
    if (foreignPrepared.status !== 'prepared') throw new Error('foreign fixture was not prepared')
    // The host file now belongs to a foreign incarnation after preparation.
    const foreignDescriptor = JSON.parse(
      await readFile(fakeForeign.descriptorPath, 'utf8')
    ) as Record<string, unknown>
    ;(foreignDescriptor['host_incarnation'] as Record<string, unknown>)['host_incarnation_id'] =
      'host-incarnation:foreign'
    ;(foreignDescriptor['events'] as Record<string, unknown>)['host_incarnation_id'] =
      'host-incarnation:foreign'
    await writeFile(fakeForeign.descriptorPath, JSON.stringify(foreignDescriptor))
    await foreignBroker.installIdentity({
      runtimeId: foreignIdentity.runtimeId as string,
      hostSessionId: foreignIdentity.hostSessionId as string,
      generation: foreignIdentity.generation,
      attachEpoch: 1,
      invocationId: foreignInvocationId,
      startRequestHash: foreignPrepared.descriptor.harnessInvocation.startRequestHash,
      selectedProfileHash: foreignPrepared.descriptor.descriptorHash,
      attachToken: 'attach:t08666-foreign',
    })
    const foreignResult = await foreignBroker.ensureInvocation({
      startAttemptId: 'attempt:t08666-foreign',
      invocationId: foreignInvocationId,
      attachEpoch: 1,
      startRequest: foreignPrepared.descriptor.harnessInvocation.startRequest,
    })
    expect(foreignResult.receipt).toMatchObject({ state: 'indeterminate' })
    expect(foreignResult.receipt.failure?.message ?? '').toMatch(/foreign host/i)
  }, 60_000)
})
