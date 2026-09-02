import { describe, expect, test } from 'bun:test'
import {
  SUPPORTED_BROKER_PROTOCOL_VERSIONS,
  validateCommand,
  validateEventEnvelope,
} from '../src/index'

const request = (method: string, params: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 'admission-test',
  method,
  params,
})

const common = {
  invocationId: 'inv_admission',
  origin: { principalRef: 'agent:test' },
  body: 'hello',
}

describe('harness-broker/0.3 admission protocol', () => {
  test('v0.3 is preferred while v0.2 remains compatible', () => {
    expect(SUPPORTED_BROKER_PROTOCOL_VERSIONS).toEqual(['harness-broker/0.3', 'harness-broker/0.2'])
  })

  test('validates all four class-in-method submit requests', () => {
    expect(validateCommand(request('submission.steer', common))).toBeDefined()
    expect(
      validateCommand(
        request('submission.enqueue', { ...common, ttlMs: 1000, turnPolicy: 'guarded' })
      )
    ).toBeDefined()
    expect(
      validateCommand(request('submission.invoke', { ...common, turnPolicy: 'open' }))
    ).toBeDefined()
    expect(
      validateCommand(
        request('submission.preempt', { ...common, ttlMs: 1000, turnPolicy: 'guarded' })
      )
    ).toBeDefined()
  })

  test('validates submission withdrawal requests and events', () => {
    expect(
      validateCommand(
        request('submission.withdraw', {
          submissionId: 'submission_1',
          reason: 'envelope-acked',
        })
      )
    ).toBeDefined()
    expect(
      validateCommand(
        request('submission.withdraw', { envelopeId: 'EN-00001', reason: 'envelope-acked' })
      )
    ).toBeDefined()
    expect(() =>
      validateCommand(
        request('submission.withdraw', {
          submissionId: 'submission_1',
          envelopeId: 'EN-00001',
          reason: 'ambiguous',
        })
      )
    ).toThrow()
    expect(() =>
      validateCommand(request('submission.withdraw', { reason: 'missing-selector' }))
    ).toThrow()
    for (const [type, payload] of [
      ['queue.withdrawn', { submissionId: 'submission_1', reason: 'envelope-acked', position: 0 }],
      ['submission.withdrawn', { submissionId: 'submission_1', reason: 'envelope-acked' }],
    ] as const) {
      expect(
        validateEventEnvelope({
          invocationId: 'inv_admission',
          seq: 1,
          time: '2026-09-02T12:00:00.000Z',
          type,
          payload,
          provenance: {
            sourceKind: 'broker',
            normalizer: { name: 'harness-broker-admission', version: '1' },
          },
        })
      ).toMatchObject({ type })
    }
  })

  test('steer cannot represent turn policy, wait, reply, or obligation fields', () => {
    for (const forbidden of ['turnPolicy', 'wait', 'reply', 'obligation']) {
      expect(() =>
        validateCommand(request('submission.steer', { ...common, [forbidden]: true }))
      ).toThrow()
    }
  })

  test('TTL must be positive', () => {
    expect(() => validateCommand(request('submission.enqueue', { ...common, ttlMs: 0 }))).toThrow()
  })

  test('decision events require broker provenance in the shared envelope', () => {
    const event = {
      invocationId: 'inv_admission',
      seq: 1,
      time: '2026-09-01T20:00:00.000Z',
      type: 'admission.admitted' as const,
      payload: { submissionId: 'submission_1', class: 'queue' as const },
    }
    expect(() => validateEventEnvelope(event)).toThrow()
    expect(
      validateEventEnvelope({
        ...event,
        provenance: {
          sourceKind: 'broker' as const,
          normalizer: { name: 'harness-broker-admission', version: '1' },
        },
      })
    ).toMatchObject({ type: 'admission.admitted' })
  })
})
