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

  test("UserPromptSubmit emits turn.started ONLY; the prompt fact is the transcript's", async () => {
    // T-07873 scope A: `conversation` is transcript-primary for this driver.
    // The hook still opens the bracket (`turn-bracket` stays hook), but the
    // prompt text it carries is a duplicate of the `user` row that records it.
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'UserPromptSubmit',
      turn_id: turnId,
      prompt: 'implement the broker hook substrate',
    })

    expect(eventTypes(events)).toEqual(['turn.started'])
    expect(events[0]).toMatchObject({
      invocationId,
      turnId,
      type: 'turn.started',
      payload: { turnId },
    })
    expect(eventTypes(events)).not.toContain('user.message')
    expect(eventTypes(events)).not.toContain('assistant.message.delta')
  })

  test('UserPromptSubmit without a prompt emits only turn.started', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'UserPromptSubmit',
      turn_id: turnId,
    })

    expect(eventTypes(events)).toEqual(['turn.started'])
  })

  test('PreToolUse / PostToolUse / MessageDisplay mint NOTHING: the transcript owns those facts', async () => {
    // T-07873 scope A. These hooks are still registered and still load-bearing —
    // `PreToolUse` is the synchronous permission-decision bridge and
    // `MessageDisplay` drives the TUI — but `tool.call.started`,
    // `tool.call.completed` and the assistant prose are minted from the
    // `tool_use` / `tool_result` / `assistant` rows that ARE the evidence.
    // Their records reach the `duplicate` disposition instead (see
    // `CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS` and the driver's `mintOutcome`).
    const normalizer = await createNormalizer()

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'PreToolUse',
        turn_id: turnId,
        tool_use_id: 'toolu_read_1',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/notes.md' },
      })
    ).toEqual([])

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'PostToolUse',
        turn_id: turnId,
        tool_use_id: 'toolu_read_1',
        tool_name: 'Read',
        tool_response: { stdout: 'contents', stderr: '', exit_code: 0 },
      })
    ).toEqual([])

    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_1',
        index: 0,
        final: true,
        delta: 'anything',
      })
    ).toEqual([])
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

  test('Stop emits idempotent turn.completed and never invocation.exited', async () => {
    const normalizer = await createNormalizer()
    const first = normalizer.normalizeHook({ hook_event_name: 'Stop', turn_id: turnId })
    const second = normalizer.normalizeHook({ hook_event_name: 'Stop', turn_id: turnId })

    expect(eventTypes(first)).toEqual(['turn.completed'])
    expect(first[0]).toMatchObject({
      type: 'turn.completed',
      turnId,
      payload: { turnId, status: 'completed' },
      driver: { kind: 'claude-code-tmux', rawType: 'Stop' },
    })
    expect(second).toEqual([])
    expect(eventTypes([...first, ...second])).not.toContain('invocation.exited')
  })

  test('SubagentStop preserves the live parent turn until its genuine Stop', async () => {
    const normalizer = await createNormalizer()

    expect(
      eventTypes(
        normalizer.normalizeHook({
          hook_event_name: 'UserPromptSubmit',
          turn_id: turnId,
          prompt: 'coordinate the room',
        })
      )
    ).toEqual(['turn.started'])
    expect(
      normalizer.normalizeHook({
        hook_event_name: 'MessageDisplay',
        turn_id: turnId,
        message_id: 'msg_parent_progress',
        index: 0,
        final: true,
        delta: 'Parent is still coordinating.',
      })
    ).toEqual([])

    const subagentStop = normalizer.normalizeHook({
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-child',
      agent_type: 'Explore',
    })
    expect(eventTypes(subagentStop)).toEqual(['driver.notice'])
    expect(subagentStop[0]).toMatchObject({
      type: 'driver.notice',
      turnId,
      payload: {
        message: 'Subagent stop: Explore (agent-child)',
        code: 'subagent_stop',
      },
      driver: { kind: 'claude-code-tmux', rawType: 'SubagentStop' },
    })
    expect(eventTypes(subagentStop)).not.toContain('assistant.message.completed')
    expect(eventTypes(subagentStop)).not.toContain('turn.completed')

    const nextParentTool = normalizer.normalizeHook({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'toolu_parent_next',
      tool_name: 'Bash',
      tool_input: { command: 'wrkf-crank --task T-07315' },
    })
    expect(nextParentTool).toEqual([])

    // The parent's own Stop still closes the bracket. The terminal prose comes
    // from the transcript; `last_assistant_message` is only the named fallback
    // for a turn the transcript reader had no prose for, which is this case.
    const parentStop = normalizer.normalizeHook({
      hook_event_name: 'Stop',
      last_assistant_message: 'Parent turn complete.',
    })
    expect(eventTypes(parentStop)).toEqual(['assistant.message.completed', 'turn.completed'])
    expect(parentStop[1]).toMatchObject({
      turnId,
      driver: { kind: 'claude-code-tmux', rawType: 'Stop' },
    })
  })

  test.each(['prompt_input_exit', 'logout', 'clear'])(
    'SessionEnd reason=%s drops the continuation (continuation.cleared before turn.completed)',
    async (reason) => {
      const events = (await createNormalizer()).normalizeHook({
        hook_event_name: 'SessionEnd',
        turn_id: turnId,
        reason,
      })

      expect(eventTypes(events)).toEqual(['continuation.cleared', 'turn.completed'])
      expect(events[0]).toMatchObject({
        type: 'continuation.cleared',
        payload: { reason },
        driver: { kind: 'claude-code-tmux', rawType: 'SessionEnd' },
      })
    }
  )

  test('SessionEnd reason=other (external pane-kill) keeps the continuation and interrupts the turn', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'SessionEnd',
      turn_id: turnId,
      reason: 'other',
    })

    expect(eventTypes(events)).not.toContain('continuation.cleared')
    expect(eventTypes(events)).toEqual(['turn.interrupted'])
    expect(events[0]).toMatchObject({
      payload: { turnId, status: 'interrupted', reason: 'other' },
      driver: { kind: 'claude-code-tmux', rawType: 'SessionEnd' },
    })
  })

  test('SessionEnd with no reason keeps the continuation and interrupts the turn', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'SessionEnd',
      turn_id: turnId,
    })

    expect(eventTypes(events)).not.toContain('continuation.cleared')
    expect(eventTypes(events)).toEqual(['turn.interrupted'])
  })

  test('Stop never emits continuation.cleared even with a user-exit reason', async () => {
    const events = (await createNormalizer()).normalizeHook({
      hook_event_name: 'Stop',
      turn_id: turnId,
      reason: 'prompt_input_exit',
    })

    expect(eventTypes(events)).not.toContain('continuation.cleared')
  })

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

    // The PreToolUse that carries the permission subject mints no tool event of
    // its own any more (T-07873) — but the permission events still correlate to
    // the transcript-minted call, because the hook's `tool_use_id` and the
    // `tool_use` block id are ONE id space (verified on a real session).
    expect(
      normalizer.normalizeHook({
        hook_event_name: 'PreToolUse',
        turn_id: turnId,
        tool_use_id: 'toolu_bash_2',
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      })
    ).toEqual([])

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

  test('Stop yields to the transcript terminal and never mints a second final', async () => {
    // The driver flushes the transcript's held assistant message on Stop (so the
    // message names the `assistant` row that said it) and reports that through
    // `noteTranscriptTerminalMessage`. The hook's `last_assistant_message` must
    // then stay silent — otherwise the turn carries two finals.
    const normalizer = await createNormalizer()
    normalizer.normalizeHook({ hook_event_name: 'UserPromptSubmit', turn_id: turnId })
    normalizer.noteTranscriptTerminalMessage()

    const events = normalizer.normalizeHook({
      hook_event_name: 'Stop',
      turn_id: turnId,
      last_assistant_message: 'Successfully inspected the directory.',
    })

    expect(eventTypes(events)).toEqual(['turn.completed'])
  })

  test('Stop mints the fallback final when the transcript held NOTHING for the turn', async () => {
    // The named exception in AUTHORITY.md: a turn that really answered but whose
    // prose the reader never saw would otherwise redden on HRC's
    // `final_message_count`. It fires only in that case, never as a second
    // opinion, and the claim is scoped to one turn.
    const normalizer = await createNormalizer()
    normalizer.normalizeHook({ hook_event_name: 'UserPromptSubmit', turn_id: turnId })

    const events = normalizer.normalizeHook({
      hook_event_name: 'Stop',
      turn_id: turnId,
      last_assistant_message: 'Successfully inspected the directory.',
    })

    expect(eventTypes(events)).toEqual(['assistant.message.completed', 'turn.completed'])
    expect(events[0]).toMatchObject({
      payload: {
        final: true,
        content: [{ type: 'text', text: 'Successfully inspected the directory.' }],
      },
    })
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
