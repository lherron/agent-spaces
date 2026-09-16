import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateArrisHostDescriptor } from 'spaces-harness-broker-protocol'

import { createArrisParticipantAdapter } from '../arris-participant-adapter.js'

/**
 * `fixtures/arris-host-descriptor-t08521.json` is a BYTE-FOR-BYTE copy of the
 * descriptor the producer itself publishes in its own tests:
 *
 *   repository: ~/praesidium/arris
 *   commit:     2b7d9ec1b9f49e2ef598479c519b933361201747   (arris T-08521)
 *   path:       codex-prototype/tests/federation/fixtures/host-descriptor.json
 *   sha256:     8f31d556d94266d5052715c76d7eba33980da944caaf4e71aec14ddd733c152a
 *
 * The hash is asserted below rather than left in prose. A fixture edited to
 * make a consumer test pass stops being evidence about the producer, and the
 * defect this file exists for -- a consumer refusing a real host -- is exactly
 * the kind a doctored fixture hides.
 *
 * Note what the real file shows: `control.mail_reply` is `false` and
 * `identity.participant` is `null`, because the host that produced it ran
 * without a participant identity. That is the identity-less host, and it must
 * validate. The identity-carrying shape is covered separately by a synthetic
 * descriptor, since no published fixture carries one yet.
 */
const T08521_FIXTURE_SHA256 = '8f31d556d94266d5052715c76d7eba33980da944caaf4e71aec14ddd733c152a'
const fixturePath = new URL('./fixtures/arris-host-descriptor-t08521.json', import.meta.url)

const identity = {
  requestId: 'request:arris-additive' as never,
  operationId: 'runtimeOperation:arris-additive' as never,
  hostSessionId: 'hostSession:arris-additive' as never,
  generation: 3,
  runtimeId: 'runtime:arris-additive' as never,
  invocationId: 'invocation:arris-additive' as never,
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>
}

function controlOf(descriptor: Record<string, unknown>): Record<string, unknown> {
  return descriptor['control'] as Record<string, unknown>
}

/**
 * A copy with those keys ABSENT, not set to undefined.
 *
 * The distinction is the subject of this file: an absent key is a host older
 * than the field, a present one is a declaration. `JSON.stringify` drops an
 * `undefined` value, so a shortcut here would accidentally test the right thing
 * for the wrong reason -- and stop doing so the moment the descriptor is passed
 * in memory rather than through a file.
 */
function without(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

async function writeDescriptor(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arris-additive-'))
  const path = join(dir, 'host-descriptor.json')
  await writeFile(path, JSON.stringify(value))
  return path
}

/**
 * Drives the REAL published adapter, not the validator alone: the reported
 * symptom was `createArrisParticipantAdapter` answering
 * `arris_host_descriptor_invalid`, so "prepares" is the thing to assert.
 */
async function prepareThroughAdapter(
  value: unknown
): Promise<{ admission: string; prepared: string }> {
  const descriptorPath = await writeDescriptor(value)
  const adapter = createArrisParticipantAdapter({
    workspaceCwd: process.cwd(),
    participantKey: 'arris:primary',
  })
  const admission = await adapter.admit({
    classId: 'arris-resident',
    join: 'participant-served',
    evidence: { schema: 'arris.participant-evidence/1', descriptorPath },
  })
  if (admission.status !== 'admitted') {
    return {
      admission: `${admission.status}:${'reason' in admission ? admission.reason : ''}`,
      prepared: 'not-attempted',
    }
  }
  const prepared = await adapter.prepare({
    classId: 'arris-resident',
    join: 'participant-served',
    participantKey: admission.participantKey,
    workspaceCwd: admission.workspaceCwd,
    preparation: admission.preparation,
    identity,
    scopeRef: 'arris@arris:primary',
    laneRef: 'main',
    attachEpoch: 1,
  })
  return {
    admission: 'admitted',
    prepared:
      prepared.status === 'prepared'
        ? 'prepared'
        : `${prepared.status}:${'reason' in prepared ? prepared.reason : ''}`,
  }
}

describe('the published descriptor validator is additive under arris.host-descriptor/1', () => {
  test('the copied fixture is still the producer bytes', async () => {
    const bytes = await readFile(fixturePath)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(T08521_FIXTURE_SHA256)
  })

  test('the real arris T-08521 fixture validates and prepares', async () => {
    const descriptor = await fixture()
    // The facts that made this fixture worth copying, asserted so a silent
    // regeneration upstream cannot quietly weaken the coverage.
    expect(descriptor['schema']).toBe('arris.host-descriptor/1')
    expect(descriptor['identity']).toEqual({ participant: null })
    expect(controlOf(descriptor)['mail_reply']).toBe(false)
    expect(controlOf(descriptor)['approval_responder']).toBe('attached_client')
    expect(controlOf(descriptor)['pending_approvals']).toEqual([])

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    expect(await prepareThroughAdapter(descriptor)).toEqual({
      admission: 'admitted',
      prepared: 'prepared',
    })
  })

  test('a host that DOES carry a ledger identity validates and prepares', async () => {
    const descriptor = await fixture()
    descriptor['identity'] = {
      participant: {
        principal_ref: 'agent:arris',
        scope_ref: 'arris@arris:primary',
      },
    }
    controlOf(descriptor)['mail_reply'] = true

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    expect(await prepareThroughAdapter(descriptor)).toEqual({
      admission: 'admitted',
      prepared: 'prepared',
    })
  })

  /**
   * The T-08505 bisect: each key the producer added was, on its own, enough to
   * refuse the host, and stripping both made it prepare. Pinned key by key so a
   * future exact-key relapse names which field it broke on.
   */
  test.each([
    ['control.approval_responder', 'approval_responder', 'arris_host'],
    ['control.pending_approvals', 'pending_approvals', []],
    ['control.mail_reply', 'mail_reply', true],
  ])('%s alone no longer refuses the host', async (_name, key, value) => {
    const base = await fixture()
    const descriptor = {
      ...without(base, 'identity'),
      control: {
        ...without(controlOf(base), 'approval_responder', 'pending_approvals', 'mail_reply'),
        [key]: value,
      },
    }

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    expect(await prepareThroughAdapter(descriptor)).toEqual({
      admission: 'admitted',
      prepared: 'prepared',
    })
  })

  test('the top-level identity block alone no longer refuses the host', async () => {
    const base = await fixture()
    const descriptor = {
      ...base,
      control: without(controlOf(base), 'approval_responder', 'pending_approvals', 'mail_reply'),
    }
    expect(descriptor['identity']).toEqual({ participant: null })

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    expect(await prepareThroughAdapter(descriptor)).toEqual({
      admission: 'admitted',
      prepared: 'prepared',
    })
  })

  test('a descriptor carrying one extra unknown key in control still prepares', async () => {
    const descriptor = await fixture()
    controlOf(descriptor)['a_field_this_consumer_has_never_heard_of'] = {
      nested: true,
    }

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
    expect(await prepareThroughAdapter(descriptor)).toEqual({
      admission: 'admitted',
      prepared: 'prepared',
    })
  })

  /**
   * `readiness` is the block where tolerance is not optional. The producer's
   * readiness enum is internally tagged, so a state carrying data publishes it
   * as a SIBLING of `state`: `awaiting_approval` adds `class`, `failed` adds
   * `code` and `message`. An exact-key `readiness` refuses a host for entering
   * a state it is entitled to enter.
   */
  test('awaiting_approval, with the sibling key its tagged enum publishes, validates', async () => {
    const descriptor = await fixture()
    descriptor['readiness'] = {
      state: 'awaiting_approval',
      class: 'command_execution',
      since_ms: 1789540257833,
      accepts_input: false,
    }
    controlOf(descriptor)['pending_approvals'] = [
      {
        class: 'command_execution',
        codex_turn_id: 'codex-turn:7',
        offered_at_ms: 1789540260000,
      },
    ]

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
  })

  test('an unknown key at the top level does not refuse the host', async () => {
    const descriptor = await fixture()
    descriptor['a_block_added_after_this_consumer_shipped'] = { anything: 1 }

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({ ok: true })
  })
})

describe('additive is not permissive: the fields this consumer reads are still enforced', () => {
  /**
   * The cost of dropping exact-key checks would be a misspelled known field
   * passing unnoticed. It does not: a misspelling is the ABSENCE of the key it
   * misspells, and every key this consumer reads is still required by path.
   */
  test('a misspelled known key fails as the absence of the key it misspells', async () => {
    const base = await fixture()
    const descriptor = {
      ...base,
      control: {
        ...without(controlOf(base), 'socket_path'),
        socket_pathh: controlOf(base)['socket_path'],
      },
    }

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: '$.control.socket_path' })]),
    })
  })

  test.each([
    ['control.mail_reply that is not a boolean', '$.control.mail_reply'],
    ['control.approval_responder naming nobody real', '$.control.approval_responder'],
    ['identity.participant that is not an object or null', '$.identity.participant'],
    ['identity.participant missing scope_ref', '$.identity.participant.scope_ref'],
    ['a pending approval missing codex_turn_id', '$.control.pending_approvals[0].codex_turn_id'],
    ['pending_approvals that is not an array', '$.control.pending_approvals'],
  ])('refuses %s', async (_name, path) => {
    const descriptor = await fixture()
    const control = controlOf(descriptor)
    if (path === '$.control.mail_reply') control['mail_reply'] = 'yes'
    if (path === '$.control.approval_responder') control['approval_responder'] = 'somebody_else'
    if (path === '$.identity.participant') descriptor['identity'] = { participant: 'agent:arris' }
    if (path === '$.identity.participant.scope_ref') {
      descriptor['identity'] = {
        participant: { principal_ref: 'agent:arris' },
      }
    }
    if (path === '$.control.pending_approvals[0].codex_turn_id') {
      control['pending_approvals'] = [{ class: 'command_execution', offered_at_ms: 1 }]
    }
    if (path === '$.control.pending_approvals') control['pending_approvals'] = 'none'

    expect(validateArrisHostDescriptor(descriptor)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path })]),
    })
  })

  test('the cross-block invariants survive the rewrite', async () => {
    const foreign = await fixture()
    ;(foreign['events'] as Record<string, unknown>)['host_incarnation_id'] =
      'host-incarnation:foreign'
    expect(validateArrisHostDescriptor(foreign)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: '$.events.host_incarnation_id' }),
      ]),
    })

    const narrowed = await fixture()
    controlOf(narrowed)['unsupported_classes'] = ['exclusive']
    expect(validateArrisHostDescriptor(narrowed)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: '$.control.unsupported_classes' }),
      ]),
    })

    const wrongSchema = await fixture()
    wrongSchema['schema'] = 'arris.host-descriptor/2'
    expect(validateArrisHostDescriptor(wrongSchema)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ path: '$.schema' })]),
    })
  })
})
