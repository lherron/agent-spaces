import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'
import type { ClaudeCodeHookEventNormalizer } from '../../../src/drivers/claude-code-tmux/hook-events'
import { type HookDriverRun, startHookDriver } from './driver-red.helpers'

const invocationId = 'inv_cc_1'
const turnId = 'turn_cc_1'

const createNormalizer = async (): Promise<ClaudeCodeHookEventNormalizer> => {
  const target = await import('../../../src/drivers/claude-code-tmux/hook-events')

  return target.createClaudeCodeHookEventNormalizer({
    invocationId,
    now: () => new Date('2026-05-26T15:00:00.000Z'),
  })
}

const single = async (hook: Record<string, unknown>) => {
  const events = (await createNormalizer()).normalizeHook(hook)
  expect(events).toHaveLength(1)
  const event = events[0]
  expect<{ kind: string; rawType?: unknown } | undefined>(event?.driver).toEqual({
    kind: 'claude-code-tmux',
    rawType: hook['hook_event_name'],
  })
  return event as InvocationEventEnvelope
}

const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

/** The events one hook envelope made the driver emit. */
const emittedBy = async (
  run: HookDriverRun,
  hookData: Record<string, unknown>,
  hookTurnId?: string
): Promise<InvocationEventEnvelope[]> => {
  const before = run.events.length
  await run.hook(hookData, hookTurnId)
  return run.events.slice(before)
}

/** Start the driver and open turn `turn_1` with a prompt hook. */
const startWithOpenTurn = async (): Promise<HookDriverRun> => {
  const run = await startHookDriver()
  await run.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 'turn_1')
  expect(run.ofType('turn.started').map((event) => event.turnId as string | undefined)).toEqual([
    'turn_1',
  ])
  return run
}

describe('claude-code-tmux hook events through the driver', () => {
  test('a SessionStart hook reports the Claude session id as the anthropic session continuation', async () => {
    const run = await startHookDriver({ sessionStart: false })
    try {
      const events = await emittedBy(run, {
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-01769',
        transcript_path: run.transcriptPath,
      })

      expect(events).toEqual([
        expect.objectContaining({
          type: 'continuation.updated',
          payload: { provider: 'anthropic', kind: 'session', key: 'claude-session-01769' },
          driver: expect.objectContaining({ kind: 'claude-code-tmux', rawType: 'SessionStart' }),
        }),
      ])
    } finally {
      await run.cleanup()
    }
  })

  test.each([
    {
      hook: 'names a tool call',
      hookData: {
        hook_event_name: 'Notification',
        tool_use_id: 'toolu_bash_1',
        message: 'running command',
        severity: 'info',
      },
      expected: {
        type: 'tool.call.delta',
        payload: {
          toolCallId: 'toolu_bash_1',
          text: 'running command',
          data: {
            rawHook: {
              hook_event_name: 'Notification',
              tool_use_id: 'toolu_bash_1',
              message: 'running command',
              severity: 'info',
            },
          },
        },
      },
    },
    {
      hook: 'names no tool call',
      hookData: { hook_event_name: 'Notification', message: 'Claude Code is still working' },
      expected: {
        type: 'driver.notice',
        payload: {
          message: 'Claude Code is still working',
          data: { rawHook: { hook_event_name: 'Notification' } },
        },
      },
    },
  ])(
    'a Notification hook becomes a tool.call.delta when it names a tool call and a driver.notice otherwise ($hook)',
    async ({ hookData, expected }) => {
      const run = await startWithOpenTurn()
      try {
        const events = await emittedBy(run, hookData, 'turn_1')

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          ...expected,
          turnId: 'turn_1',
          driver: { kind: 'claude-code-tmux', rawType: 'Notification' },
        })
      } finally {
        await run.cleanup()
      }
    }
  )

  test('a repeated Stop hook completes the turn once and never exits the invocation', async () => {
    const run = await startWithOpenTurn()
    try {
      const first = await emittedBy(run, { hook_event_name: 'Stop' }, 'turn_1')
      const second = await emittedBy(run, { hook_event_name: 'Stop' }, 'turn_1')

      expect(eventTypes(first)).toEqual(['turn.completed'])
      expect(first[0]).toMatchObject({
        turnId: 'turn_1',
        payload: { turnId: 'turn_1', status: 'completed' },
        driver: { kind: 'claude-code-tmux', rawType: 'Stop' },
      })
      expect(second).toEqual([])
      expect(eventTypes(run.events)).not.toContain('invocation.exited')
    } finally {
      await run.cleanup()
    }
  })

  test.each([
    ...['prompt_input_exit', 'logout', 'clear'].map((reason) => ({
      end: `SessionEnd reason=${reason}`,
      hookData: { hook_event_name: 'SessionEnd', reason },
      expected: [
        { type: 'continuation.cleared', payload: { reason }, driver: { rawType: 'SessionEnd' } },
        {
          type: 'turn.completed',
          turnId: 'turn_1',
          payload: { turnId: 'turn_1', status: 'completed' },
          driver: { rawType: 'SessionEnd' },
        },
      ],
    })),
    {
      end: 'SessionEnd reason=other (external pane-kill)',
      hookData: { hook_event_name: 'SessionEnd', reason: 'other' },
      expected: [
        {
          type: 'turn.interrupted',
          turnId: 'turn_1',
          payload: { turnId: 'turn_1', status: 'interrupted', reason: 'other' },
          driver: { rawType: 'SessionEnd' },
        },
      ],
    },
    {
      end: 'SessionEnd with no reason',
      hookData: { hook_event_name: 'SessionEnd' },
      expected: [
        {
          type: 'turn.interrupted',
          turnId: 'turn_1',
          payload: { turnId: 'turn_1', status: 'interrupted', reason: 'session_end' },
          driver: { rawType: 'SessionEnd' },
        },
      ],
    },
    {
      end: 'Stop with a user-exit reason',
      hookData: { hook_event_name: 'Stop', reason: 'prompt_input_exit' },
      expected: [
        {
          type: 'turn.completed',
          turnId: 'turn_1',
          payload: { turnId: 'turn_1', status: 'completed' },
          driver: { rawType: 'Stop' },
        },
      ],
    },
  ])(
    'a user-initiated SessionEnd drops the continuation and completes the turn; any other end keeps it and interrupts ($end)',
    async ({ hookData, expected }) => {
      const run = await startWithOpenTurn()
      try {
        const events = await emittedBy(run, hookData, 'turn_1')

        expect(events).toHaveLength(expected.length)
        expected.forEach((event, index) => {
          expect(events[index]).toMatchObject(event)
        })
      } finally {
        await run.cleanup()
      }
    }
  )
})

describe('claude-code-tmux hook event normalization', () => {
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
})
