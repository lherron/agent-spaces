import { expect, test } from 'bun:test'
import { AgentSession } from './agent-session.js'

test('fresh agent-sdk metadata exposes identity, idle state, capabilities and no native session', () => {
  const before = Date.now()
  const session = new AgentSession({
    ownerId: 'test-owner',
    cwd: '/tmp',
    model: 'sonnet',
    sessionId: 'my-session',
  })
  const meta = session.getMetadata()
  const after = Date.now()
  expect<unknown>(meta).toEqual({
    sessionId: 'my-session',
    kind: 'agent-sdk',
    state: 'idle',
    lastActivityAt: expect.any(Number),
    capabilities: {
      supportsInterrupt: true,
      supportsInFlightInput: false,
      supportsNativeResume: true,
      supportsAttach: false,
    },
    nativeIdentity: undefined,
    pid: undefined,
  })
  expect(meta.state).toBe(session.getState())
  expect(meta.lastActivityAt).toBeGreaterThanOrEqual(before)
  expect(meta.lastActivityAt).toBeLessThanOrEqual(after)
})
