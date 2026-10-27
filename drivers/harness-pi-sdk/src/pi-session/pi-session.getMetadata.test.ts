/**
 * RED test: PiSession.getMetadata() — T-00940
 *
 * Tests that PiSession implements getMetadata() returning a
 * SessionMetadataSnapshot with correct capability flags.
 *
 * Expected capabilities for pi:
 *   supportsInterrupt: false
 *   supportsInFlightInput: false
 *   supportsNativeResume: false
 *   supportsAttach: false
 *
 * Pass conditions:
 *   1. getMetadata() exists and returns a SessionMetadataSnapshot
 *   2. capabilities flags match pi profile (all false)
 *   3. kind === 'pi', sessionId matches, state reflects getState()
 *   4. nativeIdentity is always undefined (pi has no external session id)
 *   5. lastActivityAt is a recent timestamp
 *   6. pid is always undefined
 */
import { describe, expect, test } from 'bun:test'
import { PiSession } from './pi-session.js'

function makeSession(overrides: { sessionId: string }) {
  return new PiSession({
    ownerId: 'test-owner',
    cwd: '/tmp',
    sessionId: overrides.sessionId,
  })
}

describe('PiSession.getMetadata (T-00940)', () => {
  test('a fresh pi session snapshot carries its id, idle state, all-false capabilities and no native identity or pid', () => {
    const before = Date.now()
    const session = makeSession({ sessionId: 'pi-session-99' })
    const meta = session.getMetadata()
    const after = Date.now()

    expect<unknown>(meta).toEqual({
      sessionId: 'pi-session-99',
      kind: 'pi',
      state: 'idle',
      lastActivityAt: expect.any(Number),
      capabilities: {
        supportsInterrupt: false,
        supportsInFlightInput: false,
        supportsNativeResume: false,
        supportsAttach: false,
      },
      nativeIdentity: undefined,
      pid: undefined,
    })
    expect(meta.state).toBe(session.getState())
    expect(meta.lastActivityAt).toBeGreaterThanOrEqual(before)
    expect(meta.lastActivityAt).toBeLessThanOrEqual(after)
  })
})
