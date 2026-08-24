import { describe, expect, test } from 'bun:test'
import {
  type InputPolicyWhenBusy,
  LEGACY_BUSY_POLICIES,
  validateCommand,
  validateInvocationSpec,
} from '../src/index'

/**
 * T-07155 — contract coverage for the busy-input policy surface.
 *
 * `busyPolicies` exists so a client can ask a LIVE broker process what it can
 * execute. A headless runtime owns a long-lived broker that survives HRC
 * restarts, so publishing new code does not change the code loaded in an
 * existing broker; anything that lets a client assume otherwise reintroduces
 * the silent-downgrade failure this task removes.
 */

describe('InputPolicy.whenBusy contract', () => {
  test('LEGACY_BUSY_POLICIES is exactly the pre-T-07155 baseline', () => {
    // Older brokers omit `busyPolicies` entirely; this constant is what a
    // client may assume of them, so it must never grow to include `steer`.
    expect(LEGACY_BUSY_POLICIES).toEqual(['reject', 'queue'])
    expect(LEGACY_BUSY_POLICIES).not.toContain('steer')
  })

  test('InputPolicyWhenBusy admits steer alongside the historical members', () => {
    const all: InputPolicyWhenBusy[] = ['reject', 'queue', 'interrupt_then_apply', 'steer']
    expect(new Set(all).size).toBe(4)
    for (const legacy of LEGACY_BUSY_POLICIES) {
      expect(all).toContain(legacy)
    }
  })

  test('the input command validator accepts steer and still rejects unknown policies', () => {
    const command = (whenBusy: string) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'invocation.input',
      params: {
        invocationId: 'inv_contract',
        input: { inputId: 'input_1', kind: 'user', content: [{ type: 'text', text: 'hi' }] },
        policy: { whenBusy },
      },
    })

    expect(() => validateCommand(command('steer'))).not.toThrow()
    for (const legacy of LEGACY_BUSY_POLICIES) {
      expect(() => validateCommand(command(legacy))).not.toThrow()
    }
    // Fail closed on anything the broker cannot actually execute.
    expect(() => validateCommand(command('preempt'))).toThrow()
  })

  test('validateInvocationSpec is unaffected by the new policy member', () => {
    expect(() =>
      validateInvocationSpec({
        specVersion: 'harness-broker.invocation/v1',
        invocationId: 'inv_contract_spec',
        harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
        process: {
          command: 'test-driver',
          args: [],
          cwd: process.cwd(),
          harnessTransport: { kind: 'pipes' },
        },
        interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
        driver: { kind: 'test-driver' },
      })
    ).not.toThrow()
  })
})
