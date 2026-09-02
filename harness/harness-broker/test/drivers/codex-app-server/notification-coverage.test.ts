import { describe, expect, test } from 'bun:test'
import { isLoadBearingEventFamily } from 'spaces-harness-broker-protocol'
import {
  CODEX_METHOD_CLASSIFICATION,
  classifyCodexNotificationMethod,
  codexUnknownMethodFamily,
  mapCodexNotification,
} from '../../../src/drivers/codex-app-server/event-map'
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

  /**
   * T-07868 — the same completeness question, now asked of the §6.1
   * DISPOSITION classifier the driver reads. The mapper and the classifier are
   * two hand-written lists over one vocabulary; nothing but this test stops
   * them from drifting apart.
   */
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

  test('no method is in both classification sets', () => {
    const both = [...CODEX_METHOD_CLASSIFICATION.mapped].filter((method) =>
      CODEX_METHOD_CLASSIFICATION.ignoredKnown.has(method)
    )
    expect(both).toEqual([])
  })

  test('an undeclared method classifies unknown, and only load-bearing prefixes halt', () => {
    expect(classifyCodexNotificationMethod('thread/methodCodexHasNotInventedYet')).toBe('unknown')
    // The three prefixes a consumer ACTS on halt the cursor (§6.1)...
    expect(codexUnknownMethodFamily('turn/experimentalBracket')).toBe('turn-bracket')
    expect(codexUnknownMethodFamily('item/experimentalThought')).toBe('conversation')
    expect(codexUnknownMethodFamily('item/commandExecution/experimental')).toBe('tool')
    expect(codexUnknownMethodFamily('thread/queue/experimental')).toBe('input-admission')
    for (const method of [
      'turn/experimentalBracket',
      'item/experimentalThought',
      'item/commandExecution/experimental',
      'thread/queue/experimental',
    ]) {
      expect(isLoadBearingEventFamily(codexUnknownMethodFamily(method))).toBe(true)
    }
    // ...and provider telemetry warns without stopping the seat.
    for (const method of [
      'thread/experimentalSignal',
      'account/experimental',
      'model/experimental',
    ]) {
      expect(codexUnknownMethodFamily(method)).toBe('diagnostic')
      expect(isLoadBearingEventFamily(codexUnknownMethodFamily(method))).toBe(false)
    }
  })
})
