import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_codex_cli_tmux_1'
const payloadRoot = '/Users/lherron/praesidium/var/wrkq-artifacts/T-01681/payloads'

type CodexCliTmuxHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
}

type NormalizeCodexHookEnvelope = (
  envelope: {
    invocationId?: string | undefined
    generation?: number | undefined
    callbackSocket?: string | undefined
    runtimeId?: string | undefined
    turnId?: string | undefined
    hookData?: unknown
    hookEvent?: unknown
    payload?: unknown
  },
  options?: { normalizer?: CodexCliTmuxHookEventNormalizer | undefined; now?: () => Date }
) => InvocationEventEnvelope[]

const createNormalizer = async (): Promise<CodexCliTmuxHookEventNormalizer> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/hook-events')) as {
    createCodexCliTmuxHookEventNormalizer: (options: {
      invocationId: string
      now: () => Date
    }) => CodexCliTmuxHookEventNormalizer
  }

  return target.createCodexCliTmuxHookEventNormalizer({
    invocationId,
    now: () => new Date('2026-05-27T15:00:00.000Z'),
  })
}

const loadNormalizeCodexHookEnvelope = async (): Promise<NormalizeCodexHookEnvelope> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/hook-events')) as {
    normalizeCodexHookEnvelope: NormalizeCodexHookEnvelope
  }
  return target.normalizeCodexHookEnvelope
}

const readPayload = async (name: string): Promise<Record<string, unknown>> => {
  return (await Bun.file(join(payloadRoot, name)).json()) as Record<string, unknown>
}

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

describe('codex-cli-tmux hook event normalization', () => {
  test('normalizeCodexHookEnvelope unwraps flat hookData and merges envelope turnId', async () => {
    const normalize = await loadNormalizeCodexHookEnvelope()
    const events = normalize(
      {
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/codex-hooks.sock',
        turnId: 'turn_from_envelope',
        hookData: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'sess_from_hook',
          prompt: 'start from flat hookData',
        },
      },
      { now: () => new Date('2026-05-27T15:00:00.000Z') }
    )

    expect(eventTypes(events)).toEqual(['turn.started', 'user.message'])
    expect(events).toMatchObject([
      {
        invocationId,
        turnId: 'turn_from_envelope',
        type: 'turn.started',
        driver: { kind: 'codex-cli-tmux', rawType: 'UserPromptSubmit' },
        payload: {
          turnId: 'turn_from_envelope',
          sessionId: 'sess_from_hook',
          prompt: 'start from flat hookData',
        },
      },
      {
        invocationId,
        turnId: 'turn_from_envelope',
        type: 'user.message',
        payload: { content: 'start from flat hookData', turnId: 'turn_from_envelope' },
      },
    ])
  })

  test('normalizeCodexHookEnvelope unwraps top-level hookEvent and preserves event order', async () => {
    const normalize = await loadNormalizeCodexHookEnvelope()
    const events = normalize(
      {
        invocationId,
        generation: 1,
        turnId: 'turn_from_hook_event_envelope',
        hookEvent: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'sess_hook_event',
          prompt: 'start from top-level hookEvent',
        },
      },
      { now: () => new Date('2026-05-27T15:00:00.000Z') }
    )

    expect(eventTypes(events)).toEqual(['turn.started', 'user.message'])
    expect(events.map((event) => event.turnId)).toEqual([
      'turn_from_hook_event_envelope',
      'turn_from_hook_event_envelope',
    ])
    expect(events.map((event) => event.driver?.rawType)).toEqual([
      'UserPromptSubmit',
      'UserPromptSubmit',
    ])
    expect(events[1]).toMatchObject({
      type: 'user.message',
      payload: {
        content: 'start from top-level hookEvent',
        turnId: 'turn_from_hook_event_envelope',
      },
    })
  })

  test('UserPromptSubmit emits turn.started then user.message with Codex turn and prompt fields preserved', async () => {
    const hook = await readPayload('UserPromptSubmit-mpo5qmxg103.json')
    const events = (await createNormalizer()).normalizeHook(hook)

    expect(events.map((event) => event.type)).toEqual(['turn.started', 'user.message'])
    expect(events[0]).toMatchObject({
      invocationId,
      turnId: hook.turn_id,
      type: 'turn.started',
      driver: { kind: 'codex-cli-tmux', rawType: 'UserPromptSubmit' },
      payload: {
        turnId: hook.turn_id,
        sessionId: hook.session_id,
        prompt: hook.prompt,
      },
    })
    expect(events[1]).toMatchObject({
      invocationId,
      turnId: hook.turn_id,
      type: 'user.message',
      driver: { kind: 'codex-cli-tmux', rawType: 'UserPromptSubmit' },
      payload: {
        content: hook.prompt,
        turnId: hook.turn_id,
      },
    })
  })

  test('PreToolUse emits tool.call.started with Codex tool fields mapped to broker fields', async () => {
    const hook = await readPayload('PreToolUse-mpo5qoty431.json')
    const events = (await createNormalizer()).normalizeHook(hook)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      turnId: hook.turn_id,
      type: 'tool.call.started',
      itemId: hook.tool_use_id,
      driver: { kind: 'codex-cli-tmux', rawType: 'PreToolUse' },
      payload: {
        toolCallId: hook.tool_use_id,
        name: 'Bash',
        input: { command: "printf 'SPIKE_T01681_OK'" },
      },
    })
  })

  test('PostToolUse command errors still emit tool.call.completed and preserve command result data', async () => {
    const normalizer = await createNormalizer()
    const pre = await readPayload('PreToolUse-mpo5wugp5r0.json')
    const post = await readPayload('PostToolUse-mpo5x66q0q9.json')

    const events = [...normalizer.normalizeHook(pre), ...normalizer.normalizeHook(post)]

    expect(eventTypes(events)).toEqual(['tool.call.started', 'tool.call.completed'])
    expect(events[1]).toMatchObject({
      turnId: post.turn_id,
      type: 'tool.call.completed',
      itemId: post.tool_use_id,
      driver: { kind: 'codex-cli-tmux', rawType: 'PostToolUse' },
      payload: {
        toolCallId: post.tool_use_id,
        name: 'Bash',
        isError: false,
        result: {
          content: [{ type: 'text', text: '' }],
          details: {
            command: 'touch /tmp/spike_perm_marker_T01681.txt',
            response: '',
          },
        },
      },
    })
    expect(eventTypes(events)).not.toContain('tool.call.failed')
  })

  test('PermissionRequest without tool_use_id correlates to the active tool by turn_id and command', async () => {
    const normalizer = await createNormalizer()
    const pre = await readPayload('PreToolUse-mpo5wugp5r0.json')
    const permission = await readPayload('PermissionRequest-mpo5wuhj1j9.json')

    const events = [...normalizer.normalizeHook(pre), ...normalizer.normalizeHook(permission)]

    expect(eventTypes(events)).toEqual(['tool.call.started', 'permission.requested'])
    expect(permission).not.toHaveProperty('tool_use_id')
    expect(events[1]).toMatchObject({
      turnId: permission.turn_id,
      type: 'permission.requested',
      driver: { kind: 'codex-cli-tmux', rawType: 'PermissionRequest' },
      correlation: {
        toolCallId: pre.tool_use_id,
      },
      payload: {
        permissionRequestId: expect.any(String),
        kind: 'command',
        subjectDisplay: {
          command: 'touch /tmp/spike_perm_marker_T01681.txt',
        },
        defaultDecision: 'deny',
      },
    })
  })

  test('Stop emits turn.completed and continuation.updated from session_id', async () => {
    const hook = await readPayload('Stop-mpo5x77d3i2.json')
    const events = (await createNormalizer()).normalizeHook(hook)

    expect(eventTypes(events)).toEqual(['turn.completed', 'continuation.updated'])
    expect(events[0]).toMatchObject({
      turnId: hook.turn_id,
      type: 'turn.completed',
      payload: {
        turnId: hook.turn_id,
        status: 'completed',
        finalOutput: hook.last_assistant_message,
        producedContent: true,
      },
    })
    expect(events[1]).toMatchObject({
      type: 'continuation.updated',
      payload: {
        provider: 'openai',
        kind: 'session',
        key: hook.session_id,
      },
    })
    expect(eventTypes(events)).not.toContain('assistant.message.completed')
  })

  test('synthetic SessionEnd reason=prompt_input_exit emits continuation.cleared (operator /quit)', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'continuation.cleared',
      payload: { reason: 'prompt_input_exit' },
      driver: { kind: 'codex-cli-tmux', rawType: 'SessionEnd' },
    })
  })

  test('synthetic SessionEnd reason=other (crash/external kill) keeps the continuation', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'SessionEnd',
      reason: 'other',
    })

    expect(events).toHaveLength(0)
  })
})
