import { describe, expect, test } from 'bun:test'
import { AgentSession } from '../agent-sdk/agent-session.js'
import { HooksBridge } from '../agent-sdk/hooks-bridge.js'
import { createPermissionHook } from '../pi-session/permission-hook.js'
import { PiSession } from '../pi-session/pi-session.js'
import type { PiAgentSessionEvent } from '../pi-session/types.js'
import { createSession } from './factory.js'
import type { UnifiedSessionEvent } from './types.js'

describe('createSession', () => {
  test('returns agent-sdk and pi sessions', () => {
    const agentSdk = createSession({
      kind: 'agent-sdk',
      sessionId: 'session-a',
      cwd: '/tmp',
      model: 'haiku',
    })
    expect(agentSdk.kind).toBe('agent-sdk')
    expect(agentSdk.sessionId).toBe('session-a')

    const pi = createSession({
      kind: 'pi',
      sessionId: 'session-b',
      cwd: '/tmp',
    })
    expect(pi.kind).toBe('pi')
    expect(pi.sessionId).toBe('session-b')
  })
})

test('HooksBridge uses permission handler decisions', async () => {
  let requested = false
  const handler = {
    isAutoAllowed: () => false,
    requestPermission: async () => {
      requested = true
      return { allowed: true }
    },
  }

  const bridge = new HooksBridge('owner', undefined)
  bridge.setPermissionHandler(handler)

  const callback = bridge.createCanUseToolCallback()
  await callback('bash', { cmd: 'ls' }, { signal: new AbortController().signal })

  expect(requested).toBe(true)
})

test('AgentSession emits tool and message events', () => {
  const session = new AgentSession(
    {
      ownerId: 'owner',
      cwd: '/tmp',
      model: 'haiku',
    },
    undefined
  )

  const events: UnifiedSessionEvent[] = []
  session.onEvent((event) => events.push(event))

  const message = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tool-1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
      ],
    },
  }
  ;(
    session as unknown as {
      handleSdkMessage: (msg: Record<string, unknown>, msgType?: string) => void
    }
  ).handleSdkMessage(message, 'assistant')

  const types = events.map((event) => event.type)
  expect(types).toContain('message_start')
  expect(types).toContain('message_update')
  expect(types).toContain('message_end')
  expect(types).toContain('tool_execution_start')
  expect(types).toContain('tool_execution_end')
})

test('PiSession emits unified events from pi events', () => {
  const session = new PiSession({ ownerId: 'owner', cwd: '/tmp' })
  const events: UnifiedSessionEvent[] = []
  session.onEvent((event) => events.push(event))

  const stub = {
    subscribe: (cb: (event: PiAgentSessionEvent) => void) => {
      cb({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { cmd: 'ls' },
      })
      return () => {}
    },
  }
  ;(session as unknown as { agentSession: typeof stub }).agentSession = stub
  ;(session as unknown as { subscribeToEvents: () => void }).subscribeToEvents()

  const types = events.map((event) => event.type)
  expect(types).toContain('tool_execution_start')
})

test('createPermissionHook uses permission handler', async () => {
  const permissionHandler = {
    isAutoAllowed: () => false,
    requestPermission: async () => ({ allowed: false, reason: 'blocked' }),
  }

  const extension = createPermissionHook({
    ownerId: 'owner',
    permissionHandler,
  })

  let handler:
    | ((event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown)
    | undefined
  extension({
    on: (event: string, callback: typeof handler) => {
      if (event === 'tool_call') {
        handler = callback
      }
    },
  } as unknown as Parameters<typeof extension>[0])

  const result = await handler?.(
    { toolName: 'bash', input: { cmd: 'ls' }, toolCallId: 'tool-1' },
    { cwd: '/tmp' }
  )

  expect(result).toEqual({ block: true, reason: 'blocked' })
})
