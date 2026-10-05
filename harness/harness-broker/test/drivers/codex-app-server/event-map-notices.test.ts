import { describe, expect, test } from 'bun:test'
import { CODEX_DRIVER_KIND } from '../../../src/drivers/codex-app-server/event-map'
import { codexMapperPerTest, note } from './codex-notifications'

const { map: mapCodexNotification } = codexMapperPerTest()

describe('mapCodexNotification — notices and unknown methods', () => {
  describe('notice-shaped server notifications', () => {
    test('deprecationNotice emits a driver.notice with migration details', () => {
      const events = mapCodexNotification(
        note('deprecationNotice', {
          summary: 'The legacy_sandbox config key is deprecated.',
          details: 'Use sandbox_mode instead.',
        })
      )

      expect(events).toEqual([
        {
          type: 'driver.notice',
          payload: {
            message: 'The legacy_sandbox config key is deprecated.',
            code: 'deprecationNotice',
            data: { details: 'Use sandbox_mode instead.' },
          },
          extra: {
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'deprecationNotice' },
          },
        },
      ])
    })

    test('configWarning emits a driver.notice with warning details', () => {
      const events = mapCodexNotification(
        note('configWarning', {
          summary: 'Ignored invalid value for model_reasoning_effort.',
          details: 'Expected low, medium, or high.',
        })
      )

      expect(events).toEqual([
        {
          type: 'driver.notice',
          payload: {
            message: 'Ignored invalid value for model_reasoning_effort.',
            code: 'configWarning',
            data: { details: 'Expected low, medium, or high.' },
          },
          extra: {
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'configWarning' },
          },
        },
      ])
    })

    test('windows/worldWritableWarning emits a driver.notice preserving every structured field', () => {
      const events = mapCodexNotification(
        note('windows/worldWritableWarning', {
          extraCount: 2,
          failedScan: true,
          samplePaths: ['C:\\Temp', 'C:\\Shared'],
        })
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'driver.notice',
        payload: {
          code: 'windows/worldWritableWarning',
          data: {
            extraCount: 2,
            failedScan: true,
            samplePaths: ['C:\\Temp', 'C:\\Shared'],
          },
        },
        extra: {
          driver: { kind: CODEX_DRIVER_KIND, rawType: 'windows/worldWritableWarning' },
        },
      })
      const message = (events[0]?.payload as { message: string }).message
      expect(message).toContain('world-writable')
      expect(message).toContain('C:\\Temp')
      expect(message).toContain('C:\\Shared')
      expect(message).toContain('2')
      expect(message).toMatch(/scan[^.]*fail|fail[^.]*scan/i)
    })
  })

  describe('unknown native notification (H6, T-05219)', () => {
    test('unknown method → trace diagnostic carrying params, never leaks native type as normalized type', () => {
      const events = mapCodexNotification(note('thread/somethingNew', { foo: 1 }))
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('diagnostic')
      expect(events[0]?.payload).toEqual({
        level: 'debug',
        message: 'Unhandled Codex notification: thread/somethingNew',
        source: 'driver',
        data: { params: { foo: 1 } },
      })
      expect(events[0]?.extra?.driver).toEqual({
        kind: CODEX_DRIVER_KIND,
        rawType: 'thread/somethingNew',
      })
    })

    test('nested params ride on payload.data.params verbatim; the native method is NOT duplicated there (T-05219)', () => {
      const params = { detail: 'not-in-the-contract', nested: { count: 3, items: ['a', 'b'] } }
      const events = mapCodexNotification(note('thread/experimentalSignal', params))
      expect(events).toHaveLength(1)
      const payload = events[0]?.payload as Record<string, unknown>
      expect(payload['data']).toEqual({ params })
      // driver.rawType is the single method authority — the method never appears in data.
      expect(JSON.stringify(payload['data'])).not.toContain('thread/experimentalSignal')
      expect(events[0]?.extra?.driver?.rawType).toBe('thread/experimentalSignal')
      expect(events[0]?.type).toBe('diagnostic')
    })

    test('an unknown method with no params carries data.params as an empty object (T-05219)', () => {
      const events = mapCodexNotification(note('thread/bareSignal', undefined))
      expect((events[0]?.payload as Record<string, unknown>)['data']).toEqual({ params: {} })
    })

    test.each([
      'account/rateLimits/updated',
      'thread/status/changed',
      'remoteControl/status/changed',
      'mcpServer/startupStatus/updated',
      'hook/started',
      'hook/completed',
      'thread/started',
      // T-07726 — observed live in provider transcripts before the sweep.
      'skills/changed',
      'thread/goal/cleared',
      // T-07726 — representative members of each newly-dispositioned group.
      'thread/archived',
      'thread/compacted',
      'account/updated',
      'model/verification',
      'item/autoApprovalReview/started',
      'item/plan/delta',
      'command/exec/outputDelta',
      'rawResponse/completed',
      'thread/realtime/outputAudio/delta',
      'fuzzyFileSearch/sessionCompleted',
    ])('intentionally-suppressed method %s is dropped (no event, no diagnostic)', (method) => {
      expect(mapCodexNotification(note(method, { foo: 1 }))).toEqual([])
    })
  })

  describe('warning channels (T-07726)', () => {
    test.each(['warning', 'guardianWarning'])(
      '%s becomes an operator-visible driver.notice, not a folded-out debug diagnostic',
      (method) => {
        const events = mapCodexNotification(
          note(method, { threadId: 'thread_1', message: 'Sandbox escape attempt blocked.' })
        )
        expect(events).toEqual([
          {
            type: 'driver.notice',
            payload: { message: 'Sandbox escape attempt blocked.', code: method },
            extra: { driver: { kind: CODEX_DRIVER_KIND, rawType: method } },
          },
        ])
      }
    )

    test('a warning with no message is dropped rather than emitting an empty notice', () => {
      expect(mapCodexNotification(note('warning', { threadId: 'thread_1' }))).toEqual([])
      expect(mapCodexNotification(note('guardianWarning', { message: '' }))).toEqual([])
    })
  })

  describe('model/rerouted (T-07726)', () => {
    test('a model swap under the operator is a notice carrying both models and the reason', () => {
      const events = mapCodexNotification(
        note('model/rerouted', {
          threadId: 'thread_1',
          turnId: 'turn_1',
          fromModel: 'gpt-5-codex',
          toModel: 'gpt-5-codex-safe',
          reason: 'highRiskCyberActivity',
        })
      )
      expect(events).toEqual([
        {
          type: 'driver.notice',
          payload: {
            message:
              'Codex rerouted the model gpt-5-codex → gpt-5-codex-safe (highRiskCyberActivity)',
            code: 'model/rerouted',
            data: {
              fromModel: 'gpt-5-codex',
              toModel: 'gpt-5-codex-safe',
              reason: 'highRiskCyberActivity',
            },
          },
          extra: { driver: { kind: CODEX_DRIVER_KIND, rawType: 'model/rerouted' } },
        },
      ])
    })

    test('a reroute missing either model side is dropped rather than half-reported', () => {
      expect(mapCodexNotification(note('model/rerouted', { fromModel: 'gpt-5-codex' }))).toEqual([])
    })
  })
})
