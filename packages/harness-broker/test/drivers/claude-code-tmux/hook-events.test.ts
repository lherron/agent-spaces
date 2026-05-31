import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

const invocationId = 'inv_cc_1'
const turnId = 'turn_cc_1'

type ClaudeCodeHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
  normalizeToolCallFailure: (failure: {
    turnId: string
    toolCallId: string
    name: string
    message: string
    code?: string | undefined
    data?: unknown
  }) => InvocationEventEnvelope
}

type NormalizeHookEnvelope = (
  envelope: {
    invocationId: string
    generation: number
    callbackSocket: string
    turnId?: string | undefined
    hookData: unknown
  },
  options: { normalizer: ClaudeCodeHookEventNormalizer }
) => InvocationEventEnvelope[]

const createNormalizer = async (): Promise<ClaudeCodeHookEventNormalizer> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/hook-events')) as {
    createClaudeCodeHookEventNormalizer: (options: {
      invocationId: string
      now: () => Date
    }) => ClaudeCodeHookEventNormalizer
  }

  return target.createClaudeCodeHookEventNormalizer({
    invocationId,
    now: () => new Date('2026-05-26T15:00:00.000Z'),
  })
}

const loadNormalizeHookEnvelope = async (): Promise<NormalizeHookEnvelope> => {
  const target = (await import('../../../src/drivers/claude-code-tmux/hook-events')) as {
    normalizeHookEnvelope: NormalizeHookEnvelope
  }
  return target.normalizeHookEnvelope
}

const single = async (hook: Record<string, unknown>) => {
  const events = (await createNormalizer()).normalizeHook(hook)
  expect(events).toHaveLength(1)
  const event = events[0]
  expect(event?.driver).toEqual({
    kind: 'claude-code-tmux',
    rawType: hook['hook_event_name'],
  })
  return event as InvocationEventEnvelope
}

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

describe('claude-code-tmux hook event normalization', () => {
  test('SessionStart emits continuation.updated from the authoritative Claude session_id', async () => {
    const event = await single({
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-01769',
    })

    expect(event).toMatchObject({
      invocationId,
      type: 'continuation.updated',
      payload: {
        provider: 'anthropic',
        kind: 'session',
        key: 'claude-session-01769',
      },
    })
  })

  test('UserPromptSubmit emits turn.started with turnId in the envelope and payload', async () => {
    const event = await single({
      hook_event_name: 'UserPromptSubmit',
      turn_id: turnId,
      prompt: 'implement the broker hook substrate',
    })

    expect(event).toMatchObject({
      invocationId,
      turnId,
      type: 'turn.started',
      payload: { turnId },
    })
    expect(eventTypes([event])).not.toContain('assistant.message.delta')
  })

  test('PreToolUse emits tool.call.started with Claude tool fields mapped to broker fields', async () => {
    const event = await single({
      hook_event_name: 'PreToolUse',
      turn_id: turnId,
      tool_use_id: 'toolu_read_1',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/notes.md' },
    })

    expect(event).toMatchObject({
      type: 'tool.call.started',
      turnId,
      payload: {
        toolCallId: 'toolu_read_1',
        name: 'Read',
        input: { file_path: '/tmp/notes.md' },
      },
    })
  })

  test('PostToolUse normal emits tool.call.completed with structured result', async () => {
    const event = await single({
      hook_event_name: 'PostToolUse',
      turn_id: turnId,
      tool_use_id: 'toolu_read_1',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/notes.md' },
      tool_response: { content: [{ type: 'text', text: 'hello' }], line_count: 1 },
    })

    expect(event).toMatchObject({
      type: 'tool.call.completed',
      payload: {
        toolCallId: 'toolu_read_1',
        name: 'Read',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'hello' }],
          details: { content: [{ type: 'text', text: 'hello' }], line_count: 1 },
        },
      },
    })
  })

  test('PostToolUse tool-result errors still emit tool.call.completed, not tool.call.failed', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'PostToolUse',
      turn_id: turnId,
      tool_use_id: 'toolu_write_1',
      tool_name: 'Write',
      tool_input: { file_path: '/root/locked.txt', content: 'x' },
      is_error: true,
      tool_response: { stderr: 'permission denied', exit_code: 1 },
    })

    expect(eventTypes(events)).toEqual(['tool.call.completed'])
    expect(events[0]).toMatchObject({
      payload: {
        toolCallId: 'toolu_write_1',
        name: 'Write',
        isError: true,
        result: {
          content: [{ type: 'text', text: 'permission denied' }],
          details: { stderr: 'permission denied', exit_code: 1 },
        },
      },
    })
  })

  test('Bash PostToolUse with a nonzero exit is command result data, not tool.call.failed', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'PostToolUse',
      turn_id: turnId,
      tool_use_id: 'toolu_bash_1',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { stdout: '', stderr: '', exit_code: 1 },
    })

    expect(eventTypes(events)).toEqual(['tool.call.completed'])
    expect(events[0]).toMatchObject({
      payload: {
        toolCallId: 'toolu_bash_1',
        name: 'Bash',
        isError: false,
        result: {
          content: [{ type: 'text', text: '' }],
          details: { stdout: '', stderr: '', exit_code: 1 },
        },
      },
    })
  })

  test('tool.call.failed is reserved for driver or normalization failures with no PostToolUse result', async () => {
    const event = (await createNormalizer()).normalizeToolCallFailure({
      turnId,
      toolCallId: 'toolu_driver_1',
      name: 'Read',
      message: 'hook payload could not be normalized',
      code: 'hook_normalization_failed',
      data: { rawType: 'PostToolUse' },
    })

    expect(event).toMatchObject({
      type: 'tool.call.failed',
      driver: { kind: 'claude-code-tmux', rawType: 'driver.failure' },
      payload: {
        toolCallId: 'toolu_driver_1',
        name: 'Read',
        message: 'hook payload could not be normalized',
        code: 'hook_normalization_failed',
        data: { rawType: 'PostToolUse' },
      },
    })
  })

  test('Notification tied to a tool emits tool.call.delta with text and raw details', async () => {
    const event = await single({
      hook_event_name: 'Notification',
      turn_id: turnId,
      tool_use_id: 'toolu_bash_1',
      message: 'running command',
      severity: 'info',
    })

    expect(event).toMatchObject({
      type: 'tool.call.delta',
      payload: {
        toolCallId: 'toolu_bash_1',
        text: 'running command',
        data: {
          rawHook: {
            hook_event_name: 'Notification',
            turn_id: turnId,
            tool_use_id: 'toolu_bash_1',
            message: 'running command',
            severity: 'info',
          },
        },
      },
    })
  })

  test('untied Notification emits driver.notice', async () => {
    const event = await single({
      hook_event_name: 'Notification',
      turn_id: turnId,
      message: 'Claude Code is still working',
    })

    expect(event).toMatchObject({
      type: 'driver.notice',
      payload: {
        message: 'Claude Code is still working',
        data: { rawHook: { hook_event_name: 'Notification', turn_id: turnId } },
      },
    })
  })

  test('MessageDisplay emits a held interim assistant message before the next tool event', async () => {
    const normalizer = await createNormalizer()

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_intro',
        index: 0,
        final: true,
        delta: "I'll inspect the directory first.",
      })
    ).toEqual([])

    const events = normalizer.normalizeHook({
      hook_event_name: 'PreToolUse',
      turn_id: turnId,
      tool_use_id: 'toolu_ls_1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    })

    expect(eventTypes(events)).toEqual(['assistant.message.completed', 'tool.call.started'])
    expect(events[0]).toMatchObject({
      type: 'assistant.message.completed',
      turnId,
      itemId: 'msg_intro',
      driver: { kind: 'claude-code-tmux', rawType: 'MessageDisplay' },
      payload: {
        messageId: 'msg_intro',
        content: [{ type: 'text', text: "I'll inspect the directory first." }],
        final: false,
      },
    })
    expect(events[1]).toMatchObject({
      type: 'tool.call.started',
      payload: { toolCallId: 'toolu_ls_1', name: 'Bash' },
    })
  })

  test('MessageDisplay chunks with the same message_id emit one terminal assistant message on Stop', async () => {
    const normalizer = await createNormalizer()

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_summary',
        index: 0,
        final: false,
        delta: 'Count: 33 entries.\n\n',
      })
    ).toEqual([])
    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_summary',
        index: 1,
        final: false,
        delta: '| # | Command |\n',
      })
    ).toEqual([])
    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_summary',
        index: 2,
        final: true,
        delta: '| 1 | ls |\n',
      })
    ).toEqual([])

    const events = normalizer.normalizeHook({ hook_event_name: 'Stop', turn_id: turnId })

    expect(eventTypes(events)).toEqual(['assistant.message.completed', 'turn.completed'])
    expect(events[0]).toMatchObject({
      type: 'assistant.message.completed',
      turnId,
      itemId: 'msg_summary',
      payload: {
        messageId: 'msg_summary',
        content: [{ type: 'text', text: 'Count: 33 entries.\n\n| # | Command |\n| 1 | ls |\n' }],
        final: true,
      },
    })
    expect(events[1]).toMatchObject({
      type: 'turn.completed',
      payload: { turnId, status: 'completed' },
    })
  })

  test('MessageDisplay envelope turn id overrides Claude raw turn_id', async () => {
    const normalizer = await createNormalizer()
    const normalizeHookEnvelope = await loadNormalizeHookEnvelope()

    expect(
      normalizeHookEnvelope(
        {
          invocationId,
          generation: 1,
          callbackSocket: '/tmp/claude-hooks.sock',
          turnId,
          hookData: {
            hook_event_name: 'MessageDisplay',
            turn_id: 'claude-code-turn-id',
            message_id: 'msg_env',
            index: 0,
            final: true,
            delta: 'broker turn id wins',
          },
        },
        { normalizer }
      )
    ).toEqual([])

    const events = normalizeHookEnvelope(
      {
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/claude-hooks.sock',
        turnId,
        hookData: {
          hook_event_name: 'Stop',
          turn_id: 'claude-code-turn-id',
        },
      },
      { normalizer }
    )

    expect(events[0]).toMatchObject({
      type: 'assistant.message.completed',
      turnId,
      payload: { messageId: 'msg_env', final: true },
    })
    expect(events[1]).toMatchObject({
      type: 'turn.completed',
      turnId,
      payload: { turnId, status: 'completed' },
    })
  })

  test('MessageDisplay without an envelope broker turn id does not use Claude raw turn_id', async () => {
    const normalizer = await createNormalizer()
    const normalizeHookEnvelope = await loadNormalizeHookEnvelope()

    const events = normalizeHookEnvelope(
      {
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/claude-hooks.sock',
        hookData: {
          hook_event_name: 'MessageDisplay',
          turn_id: 'claude-code-turn-id',
          message_id: 'msg_unmapped',
          index: 0,
          final: true,
          delta: 'late unmapped display',
        },
      },
      { normalizer }
    )

    expect(events).toEqual([])
  })

  test.each(['Stop', 'SessionEnd', 'SubagentStop'])(
    '%s emits idempotent turn.completed and never invocation.exited',
    async (hookName) => {
      const normalizer = await createNormalizer()
      const first = normalizer.normalizeHook({ hook_event_name: hookName, turn_id: turnId })
      const second = normalizer.normalizeHook({ hook_event_name: hookName, turn_id: turnId })

      expect(eventTypes(first)).toEqual(['turn.completed'])
      expect(first[0]).toMatchObject({
        type: 'turn.completed',
        turnId,
        payload: { turnId, status: 'completed' },
        driver: { kind: 'claude-code-tmux', rawType: hookName },
      })
      expect(second).toEqual([])
      expect(eventTypes([...first, ...second])).not.toContain('invocation.exited')
    }
  )

  test('PreCompact emits diagnostic with harness source and compaction details', async () => {
    const event = await single({
      hook_event_name: 'PreCompact',
      turn_id: turnId,
      trigger: 'manual',
      custom_instructions: 'preserve task context',
      retained_messages: 4,
    })

    expect(event).toMatchObject({
      type: 'diagnostic',
      payload: {
        level: 'info',
        source: 'harness',
        message: 'Context compaction (manual)',
        data: {
          trigger: 'manual',
          customInstructions: 'preserve task context',
          details: { retained_messages: 4 },
        },
      },
    })
  })

  test('SubagentStart emits driver.notice, not diagnostic', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'SubagentStart',
      turn_id: turnId,
      agent_id: 'agent-smokey',
      agent_type: 'validator',
    })

    expect(eventTypes(events)).toEqual(['driver.notice'])
    expect(events[0]).toMatchObject({
      payload: {
        message: 'Subagent start: validator (agent-smokey)',
        code: 'subagent_start',
        data: {
          agentId: 'agent-smokey',
          agentType: 'validator',
          rawHook: {
            hook_event_name: 'SubagentStart',
            turn_id: turnId,
            agent_id: 'agent-smokey',
            agent_type: 'validator',
          },
        },
      },
    })
  })

  test('permission hooks emit requested and resolved only when Claude surfaces actionable fields', async () => {
    const normalizer = await createNormalizer()

    expect(
      eventTypes([
        ...normalizer.normalizeHook({
          hook_event_name: 'PreToolUse',
          turn_id: turnId,
          tool_use_id: 'toolu_bash_2',
          tool_name: 'Bash',
          tool_input: { command: 'pwd' },
        }),
      ])
    ).toEqual(['tool.call.started'])

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'PermissionRequest',
        turn_id: turnId,
        permission_request_id: 'perm_1',
        kind: 'command',
        subject_display: { command: 'rm -rf build' },
        default_decision: 'deny',
      })[0]
    ).toMatchObject({
      type: 'permission.requested',
      payload: {
        permissionRequestId: 'perm_1',
        kind: 'command',
        subjectDisplay: { command: 'rm -rf build' },
        defaultDecision: 'deny',
      },
    })

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'PermissionResolved',
        turn_id: turnId,
        permission_request_id: 'perm_1',
        decision: 'allow',
        decided_by: 'user',
        message: 'approved by operator',
      })[0]
    ).toMatchObject({
      type: 'permission.resolved',
      payload: {
        permissionRequestId: 'perm_1',
        decision: 'allow',
        decidedBy: 'user',
        message: 'approved by operator',
      },
    })
  })

  test('a non-string last_assistant_message is ignored and emits no terminal message', async () => {
    const normalizer = await createNormalizer()
    // Only the string form of last_assistant_message (the real Claude shape) is
    // used; a malformed object form falls back to the held-flush path (no held
    // message here → nothing emitted). Also asserts no spurious delta/usage.
    const events = [
      ...normalizer.normalizeHook({ hook_event_name: 'UserPromptSubmit', turn_id: turnId }),
      ...normalizer.normalizeHook({
        hook_event_name: 'Stop',
        turn_id: turnId,
        last_assistant_message: { content: [{ type: 'text', text: 'object form ignored' }] },
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    ]

    expect(eventTypes(events)).not.toContain('assistant.message.delta')
    expect(eventTypes(events)).not.toContain('assistant.message.completed')
    expect(eventTypes(events)).not.toContain('usage.updated')
  })

  // T-01722 Phase G race fix: Claude fires the terminal MessageDisplay{final:true}
  // and Stop at end-of-turn as two SEPARATE racing hook-bridge processes; the
  // MessageDisplay was observed landing 2–44ms AFTER Stop ~40% of runs. The Stop
  // payload's authoritative `last_assistant_message` (a string) is the race-free
  // source for the terminal assistant message.
  test('Stop emits the terminal final message from last_assistant_message even when no MessageDisplay was held (race-won-by-Stop)', async () => {
    const normalizer = await createNormalizer()
    // No MessageDisplay arrived before Stop (its delivery lost the race).
    const events = normalizer.normalizeHook({
      hook_event_name: 'Stop',
      turn_id: turnId,
      last_assistant_message: 'Successfully inspected the agent-spaces project directory.',
    })

    expect(eventTypes(events)).toEqual(['assistant.message.completed', 'turn.completed'])
    expect(events[0]).toMatchObject({
      type: 'assistant.message.completed',
      turnId,
      payload: {
        content: [
          { type: 'text', text: 'Successfully inspected the agent-spaces project directory.' },
        ],
        final: true,
      },
    })
  })

  test('Stop with both a held terminal MessageDisplay and last_assistant_message emits exactly one final (no double)', async () => {
    const normalizer = await createNormalizer()
    // Terminal MessageDisplay WON the race (arrived before Stop) and is held.
    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_final',
        index: 0,
        final: true,
        delta: 'Successfully inspected the directory.',
      })
    ).toEqual([])

    const events = normalizer.normalizeHook({
      hook_event_name: 'Stop',
      turn_id: turnId,
      last_assistant_message: 'Successfully inspected the directory.',
    })

    const finals = events.filter(
      (event) =>
        event.type === 'assistant.message.completed' &&
        (event.payload as { final?: boolean }).final === true
    )
    expect(finals).toHaveLength(1)
    expect(eventTypes(events)).toEqual(['assistant.message.completed', 'turn.completed'])
    expect(finals[0]).toMatchObject({ itemId: 'msg_final', payload: { messageId: 'msg_final' } })
  })

  test('a terminal MessageDisplay delivered AFTER Stop (race-lost) is dropped, not double-counted', async () => {
    const normalizer = await createNormalizer()
    const normalizeHookEnvelope = await loadNormalizeHookEnvelope()

    // Live turn opens, then Stop arrives first (won the race) carrying the text.
    normalizer.normalizeHook({ hook_event_name: 'UserPromptSubmit', turn_id: turnId })
    const stopEvents = normalizer.normalizeHook({
      hook_event_name: 'Stop',
      turn_id: turnId,
      last_assistant_message: 'Done.',
    })
    expect(eventTypes(stopEvents)).toEqual(['assistant.message.completed', 'turn.completed'])

    // The terminal MessageDisplay arrives AFTER Stop. With the turn already
    // completed there is no active turn id, so the envelope path resolves it to
    // undefined and the late display is dropped — no second final.
    const lateEvents = normalizeHookEnvelope(
      {
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/claude-hooks.sock',
        hookData: {
          hook_event_name: 'MessageDisplay',
          turn_id: turnId,
          message_id: 'msg_late',
          index: 0,
          final: true,
          delta: 'Done.',
        },
      },
      { normalizer }
    )
    expect(lateEvents).toEqual([])
  })
})
