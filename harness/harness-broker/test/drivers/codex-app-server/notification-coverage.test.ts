import { beforeEach, describe, expect, test } from 'bun:test'
import { createCodexNotificationMapper } from '../../../src/drivers/codex-app-server/event-map'
import {
  CODEX_METHOD_CLASSIFICATION,
  classifyCodexNotificationMethod,
} from '../../../src/drivers/codex-app-server/notification-methods'
import declared from '../../../testdata/codex-app-server/declared-notification-methods.json'
import { withCodexTui } from './codex-tui-transport-support'

let mapCodexNotification: ReturnType<typeof createCodexNotificationMapper>
beforeEach(() => {
  mapCodexNotification = createCodexNotificationMapper()
})

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
 * covered by app-server-failures.test.ts, not here.
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

  test('every declared method classifies as mapped or ignored-known, never unknown', () => {
    const unclassified = methods.filter(
      (method) => classifyCodexNotificationMethod(method) === 'unknown'
    )
    expect(unclassified).toEqual([])
  })

  test('a method the classifier calls mapped really is mapped', () => {
    // Mutation guard in the other direction: listing a method in MAPPED_METHODS
    // that the switch does not actually handle would silently turn a novel
    // provider method into a `normalized`/`state-only` disposition.
    const lying = [...CODEX_METHOD_CLASSIFICATION.mapped].filter((method) =>
      mapCodexNotification({ jsonrpc: '2.0', method, params: {} }).some(
        (event) =>
          event.type === 'diagnostic' &&
          typeof (event.payload as { message?: unknown }).message === 'string' &&
          (event.payload as { message: string }).message.startsWith('Unhandled Codex notification')
      )
    )
    expect(lying).toEqual([])
  })

  test('a method the classifier calls ignored-known really emits nothing', () => {
    const noisy = [...CODEX_METHOD_CLASSIFICATION.ignoredKnown].filter(
      (method) => mapCodexNotification({ jsonrpc: '2.0', method, params: {} }).length > 0
    )
    expect(noisy).toEqual([])
  })

  // §6.1 through the broker: an undeclared method is blocked_unknown, and its
  // family decides whether the capture is load-bearing. The three prefixes a
  // consumer ACTS on are load-bearing; provider telemetry warns without that.
  test.each([
    ['turn/experimentalBracket', 'turn-bracket', true],
    ['item/experimentalThought', 'conversation', true],
    ['item/commandExecution/experimental', 'tool', true],
    ['thread/queue/experimental', 'input-admission', true],
    ['thread/experimentalSignal', 'diagnostic', false],
    ['account/experimental', 'diagnostic', false],
    ['model/experimental', 'diagnostic', false],
  ])(
    'an undeclared %s is a blocked_unknown capture warning in family %s, load-bearing: %s',
    async (method, family, loadBearing) => {
      await withCodexTui(`inv_unknown_family_${family}_${loadBearing}`, (tui) => {
        tui.emit(method, { detail: 'novel' })
        expect(tui.ofType('capture.warning').map((event) => event.payload)).toMatchObject([
          { kind: 'blocked_unknown', raw: { nativeType: method, family, loadBearing } },
        ])
      })
    }
  )
})
