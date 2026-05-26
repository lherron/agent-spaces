import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { buildHookEnvelopeFromEnv } from '../../../src/drivers/claude-code-tmux/hook-ingestion'

type NormalizeHookEnvelope = (envelope: {
  invocationId: string
  generation: number
  callbackSocket: string
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData: unknown
}) => InvocationEventEnvelope[]

const loadNormalizeHookEnvelope = async (): Promise<NormalizeHookEnvelope> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/hook-events')) as {
    normalizeHookEnvelope?: NormalizeHookEnvelope | undefined
  }
  if (target.normalizeHookEnvelope === undefined) {
    throw new Error('normalizeHookEnvelope export is required')
  }
  return target.normalizeHookEnvelope
}

describe('claude-code-tmux hook envelope turn_id seam RED', () => {
  test('UserPromptSubmit without raw turn_id uses HARNESS_BROKER_TURN_ID from the envelope', async () => {
    const normalizeHookEnvelope = await loadNormalizeHookEnvelope()
    const envelope = buildHookEnvelopeFromEnv(
      { hook_event_name: 'UserPromptSubmit', prompt: 'next turn' },
      {
        HARNESS_BROKER_INVOCATION_ID: 'inv_envelope_turn_id_1',
        HARNESS_BROKER_HOOK_GENERATION: '2',
        HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/harness-broker-hooks.sock',
        HARNESS_BROKER_TURN_ID: 'turn_from_env_1',
      }
    )

    expect(normalizeHookEnvelope(envelope)).toContainEqual(
      expect.objectContaining({
        invocationId: 'inv_envelope_turn_id_1',
        type: 'turn.started',
        turnId: 'turn_from_env_1',
        payload: { turnId: 'turn_from_env_1' },
        driver: { kind: 'claude-code-tmux', rawType: 'UserPromptSubmit' },
      })
    )
  })

  test('Stop without raw turn_id completes the envelope turn', async () => {
    const normalizeHookEnvelope = await loadNormalizeHookEnvelope()
    const startEnvelope = buildHookEnvelopeFromEnv(
      { hook_event_name: 'UserPromptSubmit', prompt: 'next turn' },
      {
        HARNESS_BROKER_INVOCATION_ID: 'inv_envelope_turn_id_2',
        HARNESS_BROKER_HOOK_GENERATION: '3',
        HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/harness-broker-hooks.sock',
        HARNESS_BROKER_TURN_ID: 'turn_from_env_2',
      }
    )
    const stopEnvelope = buildHookEnvelopeFromEnv(
      { hook_event_name: 'Stop' },
      {
        HARNESS_BROKER_INVOCATION_ID: 'inv_envelope_turn_id_2',
        HARNESS_BROKER_HOOK_GENERATION: '3',
        HARNESS_BROKER_CALLBACK_SOCKET: '/tmp/harness-broker-hooks.sock',
        HARNESS_BROKER_TURN_ID: 'turn_from_env_2',
      }
    )

    normalizeHookEnvelope(startEnvelope)

    expect(normalizeHookEnvelope(stopEnvelope)).toContainEqual(
      expect.objectContaining({
        invocationId: 'inv_envelope_turn_id_2',
        type: 'turn.completed',
        turnId: 'turn_from_env_2',
        payload: { turnId: 'turn_from_env_2', status: 'completed' },
        driver: { kind: 'claude-code-tmux', rawType: 'Stop' },
      })
    )
  })
})
