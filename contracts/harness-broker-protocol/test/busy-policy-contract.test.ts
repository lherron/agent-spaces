import { describe, expect, test } from 'bun:test'
import { LEGACY_BUSY_POLICIES, validateCommand } from '../src/index'

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
})
