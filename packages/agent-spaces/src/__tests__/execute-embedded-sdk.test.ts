import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import type { UnifiedSession, UnifiedSessionEvent, UnifiedSessionState } from 'spaces-runtime'
import type { EmbeddedSdkExecutionProfile } from 'spaces-runtime-contracts'

import {
  type ExecuteEmbeddedSdkTurnInput,
  executeEmbeddedSdkTurn,
} from '../execute-embedded-sdk.js'

type FakeSessionScript = {
  onPrompt: (session: FakePiSession, prompt: string) => void | Promise<void>
}

const normalizedEventTypes = new Set([
  'invocation.started',
  'invocation.ready',
  'invocation.stopping',
  'invocation.exited',
  'invocation.failed',
  'invocation.disposed',
  'continuation.updated',
  'input.accepted',
  'input.rejected',
  'input.queued',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'assistant.message.started',
  'assistant.message.delta',
  'assistant.message.completed',
  'tool.call.started',
  'tool.call.delta',
  'tool.call.completed',
  'tool.call.failed',
  'usage.updated',
  'diagnostic',
  'driver.notice',
  'terminal.surface.reported',
  'permission.requested',
  'permission.resolved',
])

class FakePiSession implements UnifiedSession {
  readonly kind = 'pi' as const
  readonly sessionId: string
  readonly prompts: string[] = []
  started = false
  stoppedWith: string | undefined
  state: UnifiedSessionState = 'idle'
  #eventCallback: ((event: UnifiedSessionEvent) => void) | undefined

  constructor(
    readonly config: Record<string, unknown>,
    private readonly script: FakeSessionScript
  ) {
    this.sessionId = String(config.sessionId ?? 'fake-pi-session')
  }

  async start(): Promise<void> {
    this.started = true
    this.state = 'running'
  }

  async stop(reason?: string): Promise<void> {
    this.stoppedWith = reason
    this.state = 'stopped'
  }

  isHealthy(): boolean {
    return this.state === 'running' || this.state === 'streaming'
  }

  getState(): UnifiedSessionState {
    return this.state
  }

  getMetadata() {
    return {
      sessionId: this.sessionId,
      kind: this.kind,
      state: this.state,
      lastActivityAt: 1,
      capabilities: {
        supportsInterrupt: false,
        supportsInFlightInput: false,
        supportsNativeResume: false,
        supportsAttach: false,
      },
    }
  }

  async sendPrompt(text: string): Promise<void> {
    this.prompts.push(text)
    this.state = 'streaming'
    await this.script.onPrompt(this, text)
    this.state = 'running'
  }

  onEvent(callback: (event: UnifiedSessionEvent) => void): void {
    this.#eventCallback = callback
  }

  setPermissionHandler(): void {}

  emit(event: UnifiedSessionEvent): void {
    this.#eventCallback?.(event)
  }
}

function profile(
  overrides: Partial<EmbeddedSdkExecutionProfile> = {}
): EmbeddedSdkExecutionProfile {
  return {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile:test-embedded-sdk',
    profileHash: 'profile-hash',
    compatibilityHash: 'compatibility-hash',
    kind: 'embedded-sdk',
    interactionMode: 'nonInteractive',
    expectedCapabilities: {},
    sdk: {
      runtime: 'pi-sdk',
      startupMethod: 'create-sdk-session',
      turnDelivery: 'sdk-turn',
    },
    session: {
      provider: 'openai',
      modelId: 'gpt-5.5',
      cwd: '/tmp/project',
      lockedEnv: { ASP_HOME: '/tmp/asp-home' },
      pathPrepend: ['/tmp/agent/tools/bin'],
    },
    policy: {},
    ...overrides,
  } as EmbeddedSdkExecutionProfile
}

function baseInput(
  script: FakeSessionScript,
  overrides: Partial<ExecuteEmbeddedSdkTurnInput> = {}
): ExecuteEmbeddedSdkTurnInput {
  const sessions: FakePiSession[] = []
  return {
    profile: profile(),
    prompt: 'say hello',
    invocationId: 'inv_embedded_red' as InvocationId,
    inputId: 'input_embedded_red' as ExecuteEmbeddedSdkTurnInput['inputId'],
    turnId: 'turn_embedded_red' as ExecuteEmbeddedSdkTurnInput['turnId'],
    runId: 'run_embedded_red',
    bundleRoot: '/tmp/asp-home/pi-sdk-bundle',
    dispatchEnv: { AGENT_HOST_SESSION_ID: 'host-dispatch' },
    onEvent: () => {},
    dependencies: {
      now: () => '2026-05-27T04:40:00.000Z',
      loadPiSdkBundle: async () => ({
        extensions: [],
        skills: [],
        contextFiles: [],
      }),
      createPiSession: (config: Record<string, unknown>) => {
        const session = new FakePiSession(config, script)
        sessions.push(session)
        return session
      },
    },
    ...overrides,
    testObserver: {
      sessions,
    },
  } as ExecuteEmbeddedSdkTurnInput
}

function payload<T extends Record<string, unknown>>(event: InvocationEventEnvelope): T {
  return event.payload as T
}

function eventTypes(events: InvocationEventEnvelope[]): string[] {
  return events.map((event) => event.type)
}

describe('executeEmbeddedSdkTurn', () => {
  test('runs pi-sdk in-process and produces assistant output through normalized events', async () => {
    const input = baseInput({
      onPrompt(session) {
        session.emit({ type: 'agent_start', sessionId: 'pi-session-1' })
        session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
        session.emit({
          type: 'message_start',
          messageId: 'msg_1',
          message: { role: 'assistant', content: '' },
        })
        session.emit({ type: 'message_update', messageId: 'msg_1', textDelta: 'hello from pi' })
        session.emit({
          type: 'message_end',
          messageId: 'msg_1',
          message: { role: 'assistant', content: 'hello from pi' },
        })
        session.emit({ type: 'turn_end', turnId: 'turn_embedded_red' })
        session.emit({ type: 'agent_end', sessionId: 'pi-session-1' })
      },
    })

    const result = await executeEmbeddedSdkTurn(input)
    const sessions = (input as { testObserver: { sessions: FakePiSession[] } }).testObserver.sessions

    expect(sessions).toHaveLength(1)
    expect(sessions[0].started).toBe(true)
    expect(sessions[0].stoppedWith).toBe('complete')
    expect(sessions[0].prompts).toEqual(['say hello'])
    expect(sessions[0].config).toEqual(
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'openai',
        model: 'gpt-5.5',
        agentDir: '/tmp/asp-home/pi-sdk-bundle',
      })
    )

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        finalOutput: 'hello from pi',
        producedContent: true,
      })
    )
    expect(eventTypes(result.events)).toEqual(
      expect.arrayContaining([
        'invocation.started',
        'invocation.ready',
        'input.accepted',
        'turn.started',
        'assistant.message.delta',
        'assistant.message.completed',
        'turn.completed',
        'invocation.exited',
      ])
    )
    const turnCompleted = result.events.find((event) => event.type === 'turn.completed')
    expect(turnCompleted).toBeDefined()
    expect(payload(turnCompleted!).producedContent).toBe(true)
  })

  test('treats tool-only turns as produced content without empty_response failure', async () => {
    const result = await executeEmbeddedSdkTurn(
      baseInput({
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-tool' })
          session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
          session.emit({
            type: 'tool_execution_start',
            toolUseId: 'tool_1',
            toolName: 'spark',
            input: { command: 'true' },
          })
          session.emit({
            type: 'tool_execution_end',
            toolUseId: 'tool_1',
            toolName: 'spark',
            result: { content: [{ type: 'text', text: 'ok' }] },
          })
          session.emit({ type: 'turn_end', turnId: 'turn_embedded_red' })
          session.emit({ type: 'agent_end', sessionId: 'pi-session-tool' })
        },
      })
    )

    expect(result.success).toBe(true)
    expect(result.producedContent).toBe(true)
    expect(result.finalOutput).toBeUndefined()
    expect(result.error?.code).not.toBe('empty_response')
    expect(result.error?.code).not.toBe('runtime_unavailable')
    expect(eventTypes(result.events)).toEqual(
      expect.arrayContaining(['tool.call.started', 'tool.call.completed', 'turn.completed'])
    )
    const turnCompleted = result.events.find((event) => event.type === 'turn.completed')
    expect(payload(turnCompleted!).producedContent).toBe(true)
  })

  test('emits only normalized InvocationEventEnvelope events without SDK taxonomy leaks', async () => {
    const result = await executeEmbeddedSdkTurn(
      baseInput({
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-normalized' })
          session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
          session.emit({ type: 'message_update', messageId: 'msg_1', textDelta: 'normalized' })
          session.emit({ type: 'turn_end', turnId: 'turn_embedded_red' })
          session.emit({ type: 'agent_end', sessionId: 'pi-session-normalized' })
        },
      })
    )

    for (const event of result.events) {
      expect(normalizedEventTypes.has(event.type)).toBe(true)
      expect(event).toEqual(
        expect.objectContaining({
          invocationId: 'inv_embedded_red',
          seq: expect.any(Number),
          time: '2026-05-27T04:40:00.000Z',
          payload: expect.any(Object),
        })
      )
      expect(event.type).not.toMatch(/^(agent_|turn_|message_|tool_execution_|sdk_)/)
      expect((event.driver as { rawType?: string } | undefined)?.rawType).toBeUndefined()
    }
  })

  test('persists sessionKey on success and emits continuation.updated after proof', async () => {
    const result = await executeEmbeddedSdkTurn(
      baseInput({
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-continuation' })
          session.emit({ type: 'sdk_session_id', sdkSessionId: '/tmp/pi-sessions/session-123' })
          session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
          session.emit({ type: 'message_update', messageId: 'msg_1', textDelta: 'continued' })
          session.emit({ type: 'turn_end', turnId: 'turn_embedded_red' })
          session.emit({ type: 'agent_end', sessionId: 'pi-session-continuation' })
        },
      })
    )

    expect(result.success).toBe(true)
    expect(result.sessionKey).toBe('/tmp/pi-sessions/session-123')
    expect(result.continuation).toEqual({
      provider: 'openai',
      key: '/tmp/pi-sessions/session-123',
      kind: 'session',
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'continuation.updated',
        payload: {
          provider: 'openai',
          key: '/tmp/pi-sessions/session-123',
          kind: 'session',
        },
      })
    )
  })

  test('uses explicit SessionManager sessionPath as pi-sdk continuation when no SDK session id event is emitted', async () => {
    const sessionPath = '/tmp/asp-home/sessions/pi/host-session-123'
    const input = baseInput(
      {
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-no-sdk-session-event' })
          session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
          session.emit({ type: 'message_update', messageId: 'msg_1', textDelta: 'continued' })
          session.emit({ type: 'turn_end', turnId: 'turn_embedded_red' })
          session.emit({ type: 'agent_end', sessionId: 'pi-session-no-sdk-session-event' })
        },
      },
      { sessionPath }
    )

    const result = await executeEmbeddedSdkTurn(input)
    const sessions = (input as { testObserver: { sessions: FakePiSession[] } }).testObserver.sessions

    expect(input.sessionPath).toBe(sessionPath)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].config).toEqual(
      expect.objectContaining({
        sessionPath,
      })
    )

    expect(result.success).toBe(true)
    expect(result.sessionKey).toBe(sessionPath)
    expect(result.continuation).toEqual({
      provider: 'openai',
      key: sessionPath,
      kind: 'session',
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'continuation.updated',
        payload: {
          provider: 'openai',
          key: sessionPath,
          kind: 'session',
        },
      })
    )
  })

  test('passes reuse-existing continuation key as pi-sdk sessionPath and re-emits it after success without SDK session id', async () => {
    const existingSessionPath = '/tmp/asp-home/sessions/pi/existing-host-session'
    const input = baseInput(
      {
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-reuse-existing' })
          session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
          session.emit({ type: 'message_update', messageId: 'msg_1', textDelta: 'reused' })
          session.emit({ type: 'turn_end', turnId: 'turn_embedded_red' })
          session.emit({ type: 'agent_end', sessionId: 'pi-session-reuse-existing' })
        },
      },
      {
        profile: profile({
          sdk: {
            runtime: 'pi-sdk',
            startupMethod: 'reuse-existing',
            turnDelivery: 'sdk-turn',
          },
          continuation: {
            hrc: {
              provider: 'openai',
              key: existingSessionPath,
              continuationId: existingSessionPath,
              kind: 'session',
            },
          },
        } as Partial<EmbeddedSdkExecutionProfile>),
      }
    )

    const result = await executeEmbeddedSdkTurn(input)
    const sessions = (input as { testObserver: { sessions: FakePiSession[] } }).testObserver.sessions

    expect(sessions).toHaveLength(1)
    expect(sessions[0].config).toEqual(
      expect.objectContaining({
        sessionPath: existingSessionPath,
      })
    )
    expect(result.success).toBe(true)
    expect(result.sessionKey).toBe(existingSessionPath)
    expect(result.continuation).toEqual({
      provider: 'openai',
      key: existingSessionPath,
      kind: 'session',
    })
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'continuation.updated',
        payload: {
          provider: 'openai',
          key: existingSessionPath,
          kind: 'session',
        },
      })
    )
  })

  test('does not advance explicit SessionManager sessionPath when a no-sdk-session-id turn fails', async () => {
    const sessionPath = '/tmp/asp-home/sessions/pi/failed-host-session'
    const result = await executeEmbeddedSdkTurn(
      baseInput(
        {
          onPrompt(session) {
            session.emit({ type: 'agent_start', sessionId: 'pi-session-failed-no-sdk-id' })
            session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
            throw new Error('pi turn crashed before continuation proof')
          },
        },
        { sessionPath }
      )
    )

    expect(result.success).toBe(false)
    expect(result.sessionKey).toBeUndefined()
    expect(result.continuation).toBeUndefined()
    expect(result.events.some((event) => event.type === 'continuation.updated')).toBe(false)
  })

  test('rejects reuse-existing when the compiled profile has no validated continuation key', async () => {
    const input = baseInput(
      { onPrompt: () => {} },
      {
        profile: profile({
          sdk: {
            runtime: 'pi-sdk',
            startupMethod: 'reuse-existing',
            turnDelivery: 'sdk-turn',
          },
          continuation: undefined,
        } as Partial<EmbeddedSdkExecutionProfile>),
      }
    )

    const result = await executeEmbeddedSdkTurn(input)
    const sessions = (input as { testObserver: { sessions: FakePiSession[] } }).testObserver.sessions

    expect(result.success).toBe(false)
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'missing_continuation_key',
      })
    )
    expect(sessions).toHaveLength(0)
  })

  test('collapses multi-round Pi turns into ONE broker turn and propagates held-latest final flags', async () => {
    const completed = (
      messageId: string,
      text: string,
      final: boolean
    ): UnifiedSessionEvent => ({
      type: 'message_end',
      messageId,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      payload: { final },
    })

    const result = await executeEmbeddedSdkTurn(
      baseInput({
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-multi' })
          // Round 1
          session.emit({ type: 'turn_start', turnId: 'pi-native-1' })
          session.emit({
            type: 'tool_execution_start',
            toolUseId: 'tool_1',
            toolName: 'spark',
            input: { command: 'true' },
          })
          session.emit({
            type: 'tool_execution_end',
            toolUseId: 'tool_1',
            toolName: 'spark',
            result: { content: [{ type: 'text', text: 'ok' }] },
          })
          session.emit(completed('msg_1', 'first note', false))
          session.emit({ type: 'turn_end', turnId: 'pi-native-1' })
          // Round 2
          session.emit({ type: 'turn_start', turnId: 'pi-native-2' })
          session.emit(completed('msg_2', 'second note', false))
          session.emit({ type: 'turn_end', turnId: 'pi-native-2' })
          // Round 3 (terminal)
          session.emit({ type: 'turn_start', turnId: 'pi-native-3' })
          session.emit(completed('msg_3', 'final note', true))
          session.emit({ type: 'turn_end', turnId: 'pi-native-3' })
          session.emit({ type: 'agent_end', sessionId: 'pi-session-multi' })
        },
      })
    )

    expect(result.success).toBe(true)
    expect(result.finalOutput).toBe('final note')

    // Exactly ONE broker turn.started + ONE turn.completed for the whole prompt.
    const starts = result.events.filter((event) => event.type === 'turn.started')
    const completes = result.events.filter((event) => event.type === 'turn.completed')
    expect(starts).toHaveLength(1)
    expect(completes).toHaveLength(1)

    // No synthetic -t2/-t3 ids: every turn-scoped envelope carries the broker id.
    const brokerTurnId = 'turn_embedded_red'
    const turnScoped = result.events.filter((event) =>
      [
        'turn.started',
        'turn.completed',
        'assistant.message.completed',
        'tool.call.started',
        'tool.call.completed',
      ].includes(event.type)
    )
    for (const event of turnScoped) {
      expect(event.turnId).toBe(brokerTurnId)
    }

    // Held-latest final flags propagate verbatim: N-1 final:false + 1 final:true.
    const finals = result.events
      .filter((event) => event.type === 'assistant.message.completed')
      .map((event) => payload<{ final: boolean }>(event).final)
    expect(finals).toEqual([false, false, true])

    // The terminal final:true precedes the single broker turn.completed.
    const terminalIdx = result.events.findIndex(
      (event) =>
        event.type === 'assistant.message.completed' &&
        payload<{ final: boolean }>(event).final === true
    )
    const completedIdx = result.events.findIndex((event) => event.type === 'turn.completed')
    expect(terminalIdx).toBeGreaterThanOrEqual(0)
    expect(terminalIdx).toBeLessThan(completedIdx)
  })

  test('does not advance continuation when the turn fails after an SDK session id is observed', async () => {
    const result = await executeEmbeddedSdkTurn(
      baseInput({
        onPrompt(session) {
          session.emit({ type: 'agent_start', sessionId: 'pi-session-failed' })
          session.emit({ type: 'sdk_session_id', sdkSessionId: '/tmp/pi-sessions/failed' })
          session.emit({ type: 'turn_start', turnId: 'turn_embedded_red' })
          throw new Error('pi turn crashed')
        },
      })
    )

    expect(result.success).toBe(false)
    expect(result.sessionKey).toBeUndefined()
    expect(result.continuation).toBeUndefined()
    expect(result.events.some((event) => event.type === 'continuation.updated')).toBe(false)
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'invocation.failed',
        payload: expect.objectContaining({
          message: expect.stringContaining('pi turn crashed'),
        }),
      })
    )
  })
})
