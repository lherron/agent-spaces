import { expect, test } from 'bun:test'
import { CodexSession } from './codex-session.js'

test('fresh Codex metadata exposes identity, idle state, capabilities and no native session', () => {
  const before = Date.now()
  const session = new CodexSession({
    ownerId: 'test-owner',
    cwd: '/tmp',
    homeDir: '/tmp',
    sessionId: 'codex-session-42',
  })
  const meta = session.getMetadata()
  const after = Date.now()
  expect<unknown>(meta).toEqual({
    sessionId: 'codex-session-42',
    kind: 'codex',
    state: 'idle',
    lastActivityAt: expect.any(Number),
    capabilities: {
      supportsInterrupt: false,
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
