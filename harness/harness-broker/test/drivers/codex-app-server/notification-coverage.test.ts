import { describe, expect, test } from 'bun:test'
import { mapCodexNotification } from '../../../src/drivers/codex-app-server/event-map'
import declared from '../../../testdata/codex-app-server/declared-notification-methods.json'

/**
 * Completeness oracle for the codex-app-server notification mapper (T-07726).
 *
 * The mapper's unknown-method fallback exists for a method the PROVIDER adds
 * after us — not as a resting place for methods codex already declares. Every
 * method in `server_notification_definitions!` must therefore have an explicit
 * disposition: a first-class mapping, a notice, or membership in
 * SUPPRESSED_METHODS. This test fails on the ones we did NOT classify, which is
 * the half a hand-written case list cannot check itself.
 *
 * The fixture is the wire-name list extracted from
 * `codex-rs/app-server-protocol/src/protocol/common.rs`. When bumping codex,
 * re-extract it from that macro block; a red here means the new version added a
 * method that would otherwise start emitting `Unhandled Codex notification`
 * diagnostics into every live pane.
 */
/**
 * `error` is dispositioned one layer up: driver.ts `onNotification` intercepts it
 * and returns BEFORE calling the mapper, converting it to a diagnostic plus a
 * turn/invocation terminal. The mapper is never asked about it. That path is
 * covered by codex-app-server-driver.test.ts, not here.
 */
const DISPOSITIONED_IN_DRIVER = new Set(['error'])

describe('codex-app-server notification coverage', () => {
  const methods: string[] = declared.methods.filter(
    (method: string) => !DISPOSITIONED_IN_DRIVER.has(method)
  )

  test('the fixture actually captured the provider method list', () => {
    // A silently-empty fixture would make every assertion below vacuous.
    expect(methods.length).toBeGreaterThan(50)
    expect(methods).toContain('turn/completed')
  })

  test('no method codex declares falls through to the unhandled diagnostic', () => {
    const undispositioned = methods.filter((method) =>
      mapCodexNotification({ jsonrpc: '2.0', method, params: {} }).some(
        (event) =>
          event.type === 'diagnostic' &&
          typeof (event.payload as { message?: unknown }).message === 'string' &&
          (event.payload as { message: string }).message.startsWith('Unhandled Codex notification')
      )
    )
    expect(undispositioned).toEqual([])
  })

  test('an undeclared method still reaches the unhandled diagnostic', () => {
    // Mutation guard: the assertion above must be able to fail. If the fallback
    // were removed the coverage test would pass for the wrong reason.
    const events = mapCodexNotification({
      jsonrpc: '2.0',
      method: 'thread/methodCodexHasNotInventedYet',
      params: { detail: 'novel' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'diagnostic',
      payload: {
        level: 'debug',
        message: 'Unhandled Codex notification: thread/methodCodexHasNotInventedYet',
        data: { params: { detail: 'novel' } },
      },
    })
  })
})
