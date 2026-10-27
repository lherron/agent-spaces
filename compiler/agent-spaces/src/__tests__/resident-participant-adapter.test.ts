import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  validateParticipantAdapterAdmission,
  validateParticipantAdapterPreparation,
} from 'spaces-runtime-contracts'
import {
  ARRIS_RESIDENT_DRIVER_KIND,
  type ResidentProductConfig,
  createResidentParticipantAdapter,
} from '../arris-participant-adapter.js'

const fixturePath = new URL('./fixtures/arris-host-descriptor.json', import.meta.url)
const identity = {
  requestId: 'request:resident-adapter' as never,
  operationId: 'runtimeOperation:resident-adapter' as never,
  hostSessionId: 'hostSession:resident-adapter' as never,
  generation: 7,
  runtimeId: 'runtime:resident-adapter' as never,
  invocationId: 'invocation:resident-adapter' as never,
}

// Readiness contract §4: the nonvisual product selects its own branding/profile
// while reusing the same maintained adapter/driver/control contract.
const NONVISUAL_PRODUCT: ResidentProductConfig = {
  productId: 'nonvisual-resident-product',
  frontend: 'nonvisual',
  processCommand: 'nonvisual-resident-external',
  profilePath: 'lib/nonvisual-resident-product/profile/agent-profile.toml',
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>
}

async function writeDescriptor(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'resident-participant-adapter-'))
  const path = join(dir, 'host-descriptor.json')
  await writeFile(path, JSON.stringify(value))
  return path
}

describe('Resident participant adapter (T-08666)', () => {
  test('nonvisual product yields its own identity over the same driver contract', async () => {
    const descriptorPath = await writeDescriptor(await fixture())
    const adapter = createResidentParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'nonvisual:primary',
      product: NONVISUAL_PRODUCT,
    })
    const admission = await adapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    expect(validateParticipantAdapterAdmission(admission).ok).toBe(true)
    expect(admission).toMatchObject({
      status: 'admitted',
      participantKey: 'nonvisual:primary',
    })
    if (admission.status !== 'admitted') throw new Error('nonvisual was not admitted')
    const request = {
      classId: 'arris-resident',
      join: 'participant-served' as const,
      participantKey: admission.participantKey,
      workspaceCwd: admission.workspaceCwd,
      preparation: admission.preparation,
      identity,
      scopeRef: 'nonvisual@nonvisual:primary',
      laneRef: 'main',
      attachEpoch: 2,
    }
    const prepared = await adapter.prepare(request)
    expect(validateParticipantAdapterPreparation(request, prepared).ok).toBe(true)
    if (prepared.status !== 'prepared') throw new Error('nonvisual was not prepared')
    // Own frontend/profile identity ...
    expect(prepared.descriptor.harnessInvocation.startRequest.spec.harness).toMatchObject({
      frontend: 'nonvisual',
      driver: ARRIS_RESIDENT_DRIVER_KIND,
    })
    expect(prepared.descriptor.harnessInvocation.startRequest.spec.process).toMatchObject({
      command: 'nonvisual-resident-external',
    })
    expect(prepared.descriptor.harnessInvocation.startRequest.spec.labels).toMatchObject({
      productId: 'nonvisual-resident-product',
      productProfile: 'lib/nonvisual-resident-product/profile/agent-profile.toml',
    })
    // ... same maintained driver/control contract without native continuation.
    expect(prepared.descriptor).toMatchObject({
      brokerDriver: ARRIS_RESIDENT_DRIVER_KIND,
      expectedCapabilities: { continuation: 'forbidden' },
    })
    expect(prepared.descriptor.continuation).toBeUndefined()
    expect(prepared.descriptor.harnessInvocation.startRequest.spec.driver).toMatchObject({
      kind: ARRIS_RESIDENT_DRIVER_KIND,
      descriptorPath,
      hostLifecycleOwner: 'external',
      profilePath: 'lib/nonvisual-resident-product/profile/agent-profile.toml',
    })
    // The real published protocol validator admits the composed request.
    const startRequest = prepared.descriptor.harnessInvocation.startRequest
    expect(() => validateInvocationStartRequest(startRequest)).not.toThrow()
    expect(validateInvocationStartRequest(startRequest)).toEqual(startRequest)
  })

  test.each([
    ['empty productId', { ...NONVISUAL_PRODUCT, productId: '' }, 'non-empty productId'],
    ['empty frontend', { ...NONVISUAL_PRODUCT, frontend: '' }, 'non-empty frontend'],
    [
      'empty processCommand',
      { ...NONVISUAL_PRODUCT, processCommand: '' },
      'non-empty processCommand',
    ],
    ['empty driverKind', { ...NONVISUAL_PRODUCT, driverKind: '' }, 'non-empty driverKind'],
    [
      'foreign driverKind',
      { ...NONVISUAL_PRODUCT, driverKind: 'no-such-driver' },
      "must be the maintained 'arris-resident'",
    ],
    [
      'absolute profilePath',
      { ...NONVISUAL_PRODUCT, profilePath: '/etc/nonvisual/agent-profile.toml' },
      'installed relative path',
    ],
  ])('malformed product config refuses predictably: %s', (_name, product, message) => {
    expect(() =>
      createResidentParticipantAdapter({ workspaceCwd: process.cwd(), product })
    ).toThrow(expect.objectContaining({ message: expect.stringContaining(message) }))
  })

  test('reconnect keeps continuity on the stable participant key', async () => {
    const descriptor = await fixture()
    const descriptorPath = await writeDescriptor(descriptor)
    const adapter = createResidentParticipantAdapter({
      workspaceCwd: process.cwd(),
      participantKey: 'nonvisual:primary',
      product: NONVISUAL_PRODUCT,
    })
    const admission = await adapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    if (admission.status !== 'admitted')
      throw new Error('nonvisual was not admitted')
      // Host rebinds its thread (same incarnation, bumped rebind count); the
      // controller reconnects without a new participant key.
    ;(descriptor['resident_binding'] as Record<string, unknown>)['rebind_count'] = 1
    await writeFile(descriptorPath, JSON.stringify(descriptor))
    const reconnected = await adapter.admit({
      classId: 'arris-resident',
      join: 'participant-served',
      participantKey: 'nonvisual:primary',
      evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
    })
    expect(reconnected).toMatchObject({
      status: 'admitted',
      participantKey: 'nonvisual:primary',
      continuityEvidence: {
        schema: 'arris.host-continuity/1',
        host_incarnation_id: 'host-incarnation:0fff54f7-f6f7-473b-8776-1ba07803f87d',
        resident_binding: { rebind_count: 1 },
      },
    })
    if (reconnected.status !== 'admitted') throw new Error('reconnect was not admitted')
    const prepared = await adapter.prepare({
      classId: 'arris-resident',
      join: 'participant-served',
      participantKey: reconnected.participantKey,
      workspaceCwd: reconnected.workspaceCwd,
      preparation: reconnected.preparation,
      identity,
      scopeRef: 'nonvisual@nonvisual:primary',
      laneRef: 'main',
      attachEpoch: 3,
    })
    if (prepared.status !== 'prepared') throw new Error('reconnect was not prepared')
    expect(prepared.descriptor.continuation).toBeUndefined()
  })
})
