import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  validateArrisHostDescriptor,
  validateInvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import {
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
} from 'spaces-runtime-contracts'
import {
  ARRIS_RESIDENT_DRIVER_KIND,
  createArrisParticipantAdapter,
} from '../arris-participant-adapter.js'

const fixturePath = new URL('./fixtures/arris-host-descriptor.json', import.meta.url)
const identity = {
  requestId: 'request:arris-adapter' as never,
  operationId: 'runtimeOperation:arris-adapter' as never,
  hostSessionId: 'hostSession:arris-adapter' as never,
  generation: 7,
  runtimeId: 'runtime:arris-adapter' as never,
  invocationId: 'invocation:arris-adapter' as never,
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>
}

async function writeDescriptor(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arris-participant-adapter-'))
  const path = join(dir, 'host-descriptor.json')
  await writeFile(path, JSON.stringify(value))
  return path
}

describe('Arris participant adapter', () => {
  test('validates the ca7e110 descriptor fixture and preserves host identity in preparation', async () => {
    const descriptor = await fixture()
    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    const descriptorPath = await writeDescriptor(descriptor)
    const adapter = createArrisParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'arris:primary',
    })
    const admission = await adapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    expect(validateParticipantAdapterAdmission(admission).ok).toBe(true)
    expect(admission).toMatchObject({
      status: 'admitted',
      participantKey: 'arris:primary',
      preparation: {
        hostIncarnationId: 'host-incarnation:0fff54f7-f6f7-473b-8776-1ba07803f87d',
        hostPid: 67137,
        lifecycleOwner: 'external',
      },
      continuityEvidence: {
        schema: 'arris.host-continuity/1',
        host_incarnation_id: 'host-incarnation:0fff54f7-f6f7-473b-8776-1ba07803f87d',
      },
    })
    if (admission.status !== 'admitted') throw new Error('fixture was not admitted')
    const request = {
      classId: 'arris-resident',
      join: 'participant-served' as const,
      participantKey: admission.participantKey,
      workspaceCwd: admission.workspaceCwd,
      preparation: admission.preparation,
      identity,
      scopeRef: 'arris@arris:primary',
      laneRef: 'main',
      attachEpoch: 2,
    }
    const prepared = await adapter.prepare(request)
    expect(validateParticipantAdapterPreparation(request, prepared).ok).toBe(true)
    if (prepared.status !== 'prepared') throw new Error('fixture was not prepared')
    expect(prepared.profile).toMatchObject({
      brokerDriver: ARRIS_RESIDENT_DRIVER_KIND,
      brokerOwnership: 'participant-owned-process',
      harnessInvocation: {
        startRequest: {
          spec: {
            driver: {
              kind: ARRIS_RESIDENT_DRIVER_KIND,
              descriptorPath,
              hostLifecycleOwner: 'external',
            },
          },
        },
      },
    })
    expect(prepared.profile.harnessInvocation.startRequest.spec.correlation).toMatchObject({
      startRequestHash: prepared.profile.harnessInvocation.startRequestHash,
      selectedProfileHash: prepared.profile.profileHash,
    })
  })

  // The wire gap that hid T-08518: T-08503's real-host smoke drove `createBroker`
  // and `broker.start` in process, which never runs the JSON-RPC wire validator.
  // This asserts the composed profile through the REAL exported validator the
  // published broker's `broker.ensureInvocation` calls — never a local copy.
  test.each([
    ['participant-served', 'participant-served' as const],
    ['hrc-hosted', 'hrc-hosted' as const],
  ])('composes a %s start request the broker wire validator admits', async (_name, join) => {
    const descriptorPath = await writeDescriptor(await fixture())
    const adapter = createArrisParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'arris:primary',
    })
    const admission = await adapter.admit({
      classId: 'arris-resident',
      join,
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    if (admission.status !== 'admitted') throw new Error('fixture was not admitted')
    const prepared = await adapter.prepare({
      classId: 'arris-resident',
      join,
      participantKey: admission.participantKey,
      workspaceCwd: admission.workspaceCwd,
      preparation: admission.preparation,
      identity,
      scopeRef: 'arris@arris:primary',
      laneRef: 'main',
      attachEpoch: 2,
    })
    if (prepared.status !== 'prepared') throw new Error('fixture was not prepared')

    const startRequest = prepared.profile.harnessInvocation.startRequest
    // The profile really does declare in-process transport; if that ever
    // changes the validator assertion below stops covering this defect.
    expect(startRequest).toMatchObject({
      spec: {
        harness: { driver: ARRIS_RESIDENT_DRIVER_KIND },
        process: {
          command: 'arris-resident-external',
          harnessTransport: { kind: 'in-process' },
        },
      },
    })
    expect(Object.hasOwn(startRequest.spec, 'sdk')).toBe(false)

    expect(() => validateInvocationStartRequest(startRequest)).not.toThrow()
    expect(validateInvocationStartRequest(startRequest)).toEqual(startRequest)
  })

  test('accepts null control socket as valid startup state and holds admission pending', async () => {
    const descriptor = await fixture()
    ;(descriptor['control'] as Record<string, unknown>)['socket_path'] = null
    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    const descriptorPath = await writeDescriptor(descriptor)
    const adapter = createArrisParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'arris:primary',
    })
    expect(
      await adapter.admit({
        classId: 'arris-resident',
        join: 'participant-served',
        evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
      })
    ).toEqual({ status: 'pending', reason: 'arris_host_control_starting' })
  })

  test('rejects a changed host incarnation between admit and prepare', async () => {
    const descriptor = await fixture()
    const descriptorPath = await writeDescriptor(descriptor)
    const adapter = createArrisParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'arris:primary',
    })
    const admission = await adapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    if (admission.status !== 'admitted') throw new Error('fixture was not admitted')
    ;(descriptor['host_incarnation'] as Record<string, unknown>)['host_incarnation_id'] =
      'host-incarnation:foreign'
    ;(descriptor['events'] as Record<string, unknown>)['host_incarnation_id'] =
      'host-incarnation:foreign'
    await writeFile(descriptorPath, JSON.stringify(descriptor))
    expect(
      await adapter.prepare({
        classId: 'arris-resident',
        join: 'participant-served',
        participantKey: admission.participantKey,
        workspaceCwd: admission.workspaceCwd,
        preparation: admission.preparation,
        identity,
        scopeRef: 'arris@arris:primary',
        laneRef: 'main',
        attachEpoch: 2,
      })
    ).toEqual({ status: 'rejected', reason: 'arris_host_incarnation_changed' })
  })

  test('rejects foreign event journals and implicit process-lifetime participant keys', async () => {
    const descriptor = await fixture()
    ;(descriptor['events'] as Record<string, unknown>)['host_incarnation_id'] =
      'host-incarnation:foreign'
    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: '$.events.host_incarnation_id' }),
      ]),
    })
    const validPath = await writeDescriptor(await fixture())
    const adapter = createArrisParticipantAdapter({
      workspaceCwd: process.cwd(),
    })
    expect(
      await adapter.admit({
        classId: 'arris-resident',
        join: 'participant-served',
        evidence: {
          schema: 'arris.participant-evidence/1',
          descriptorPath: validPath,
        },
      })
    ).toEqual({ status: 'pending', reason: 'arris_participant_key_required' })
  })

  test('accepts an explicit future managed binding without inferring host ownership', async () => {
    const managed = await fixture()
    ;(managed['lifecycle'] as Record<string, unknown>) = {
      host_lifecycle_owner: 'hrc-managed',
      launch_id: 'launch:managed-1',
      accepts_managed_stop: true,
    }
    const descriptorPath = await writeDescriptor(managed)
    const adapter = createArrisParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'arris:managed',
    })
    const admission = await adapter.admit({
      classId: 'arris-resident',
      join: 'hrc-hosted',
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    if (admission.status !== 'admitted') throw new Error('managed fixture was not admitted')
    const prepared = await adapter.prepare({
      classId: 'arris-resident',
      join: 'hrc-hosted',
      participantKey: admission.participantKey,
      workspaceCwd: admission.workspaceCwd,
      preparation: admission.preparation,
      identity,
      scopeRef: 'arris@arris:managed',
      laneRef: 'main',
      attachEpoch: 1,
    })
    if (prepared.status !== 'prepared') throw new Error('managed fixture was not prepared')
    expect(prepared.profile).toMatchObject({
      brokerOwnership: 'hrc-owned-process',
      expectedCapabilities: { control: { stop: 'optional' } },
      harnessInvocation: {
        startRequest: {
          spec: {
            driver: {
              hostLifecycleOwner: 'hrc-managed',
              launchId: 'launch:managed-1',
            },
          },
        },
      },
    })
  })
})
