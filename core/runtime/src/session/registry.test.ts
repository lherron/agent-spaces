import { describe, expect, test } from 'bun:test'
import { createSession, setSessionRegistry } from './factory.js'
import { SessionRegistry } from './registry.js'
import type { UnifiedSession } from './types.js'

function createMockSession(kind: 'agent-sdk' | 'pi' | 'codex'): UnifiedSession {
  return {
    sessionId: 'session-1',
    kind,
    async start() {},
    async stop() {},
    isHealthy() {
      return true
    },
    getState() {
      return 'idle'
    },
    async sendPrompt() {},
    onEvent() {},
    setPermissionHandler() {},
  }
}

describe('createSession', () => {
  test('uses the registered session factory', () => {
    const registry = new SessionRegistry()
    setSessionRegistry(registry)

    const mock = createMockSession('agent-sdk')
    registry.register('agent-sdk', () => mock)

    const session = createSession({ kind: 'agent-sdk', sessionId: 'session-1', cwd: '/tmp' })
    expect(session).toBe(mock)
  })
})
