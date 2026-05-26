import { describe, expect, test } from 'bun:test'

const loadTarget = async () =>
  (await import('../../../src/drivers/claude-code-tmux/hook-ingestion')) as {
    buildHookEnvelopeFromEnv: (
      hookData: unknown,
      env: Record<string, string | undefined>
    ) => unknown
  }

describe('claude-code-tmux hook ingestion', () => {
  test('buildHookEnvelopeFromEnv builds the broker callback envelope from hook environment', async () => {
    const { buildHookEnvelopeFromEnv } = await loadTarget()
    const envelope = buildHookEnvelopeFromEnv(
      { hook_event_name: 'UserPromptSubmit', prompt: 'continue' },
      {
        HARNESS_BROKER_INVOCATION_ID: 'inv_cc_1',
        HARNESS_BROKER_HOOK_GENERATION: '7',
        HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/harness-broker-hooks.sock',
        HARNESS_BROKER_RUNTIME_ID: 'runtime_cc_1',
        HARNESS_BROKER_TURN_ID: 'turn_cc_1',
      }
    )

    expect(envelope).toEqual({
      invocationId: 'inv_cc_1',
      generation: 7,
      callbackSocket: '/tmp/harness-broker-hooks.sock',
      runtimeId: 'runtime_cc_1',
      turnId: 'turn_cc_1',
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'continue' },
    })
  })

  test('buildHookEnvelopeFromEnv rejects missing required hook environment', async () => {
    const { buildHookEnvelopeFromEnv } = await loadTarget()
    expect(() =>
      buildHookEnvelopeFromEnv({ hook_event_name: 'Stop' }, { HARNESS_BROKER_INVOCATION_ID: 'inv' })
    ).toThrow(/HARNESS_BROKER_HOOK_GENERATION|HARNESS_BROKER_CALLBACK_SOCKET/)
  })

  test('buildHookEnvelopeFromEnv rejects non-numeric hook generation', async () => {
    const { buildHookEnvelopeFromEnv } = await loadTarget()
    expect(() =>
      buildHookEnvelopeFromEnv(
        { hook_event_name: 'Stop' },
        {
          HARNESS_BROKER_INVOCATION_ID: 'inv_cc_1',
          HARNESS_BROKER_HOOK_GENERATION: 'not-a-number',
          HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/hook.sock',
        }
      )
    ).toThrow(/HARNESS_BROKER_HOOK_GENERATION/)
  })
})
