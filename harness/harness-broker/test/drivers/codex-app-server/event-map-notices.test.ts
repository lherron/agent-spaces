import { describe, expect, test } from 'bun:test'
import { CODEX_DRIVER_KIND } from '../../../src/drivers/codex-app-server/event-map'
import { withCodexTui } from './codex-tui-transport-support'

// Native notice-shaped notifications pushed through the real codex-tui driver
// (FakeCodexRpc), asserted on the broker events they become. The unknown-method
// fallback is driven headless by app-server-turns; the ignored-known set by
// notification-coverage.

const driver = (rawType: string) => ({ kind: CODEX_DRIVER_KIND, rawType })

describe('codex notices and unknown methods reach the broker as driver events', () => {
  describe('notice-shaped server notifications', () => {
    test.each([
      {
        method: 'deprecationNotice',
        summary: 'The legacy_sandbox config key is deprecated.',
        details: 'Use sandbox_mode instead.',
      },
      {
        method: 'configWarning',
        summary: 'Ignored invalid value for model_reasoning_effort.',
        details: 'Expected low, medium, or high.',
      },
    ])(
      '$method surfaces as a driver.notice carrying summary and details',
      async ({ method, summary, details }) => {
        await withCodexTui(`inv_notice_${method}`, (tui) => {
          tui.emit(method, { summary, details })
          expect(tui.ofType('driver.notice').map((event) => [event.payload, event.driver])).toEqual(
            [[{ message: summary, code: method, data: { details } }, driver(method)]]
          )
        })
      }
    )

    test('windows/worldWritableWarning emits a driver.notice preserving every structured field', async () => {
      await withCodexTui('inv_notice_world_writable', (tui) => {
        tui.emit('windows/worldWritableWarning', {
          extraCount: 2,
          failedScan: true,
          samplePaths: ['C:\\Temp', 'C:\\Shared'],
        })
        const notices = tui.ofType('driver.notice')
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({
          payload: {
            code: 'windows/worldWritableWarning',
            data: {
              extraCount: 2,
              failedScan: true,
              samplePaths: ['C:\\Temp', 'C:\\Shared'],
            },
          },
          driver: driver('windows/worldWritableWarning'),
        })
        const message = (notices[0]?.payload as { message: string }).message
        expect(message).toContain('world-writable')
        expect(message).toContain('C:\\Temp')
        expect(message).toContain('C:\\Shared')
        expect(message).toContain('2')
        expect(message).toMatch(/scan[^.]*fail|fail[^.]*scan/i)
      })
    })
  })

  describe('unknown native notification (H6, T-05219)', () => {
    test('an unknown method with no params carries data.params as an empty object (T-05219)', async () => {
      await withCodexTui('inv_unknown_no_params', (tui) => {
        tui.emit('thread/bareSignal', undefined)
        expect(tui.ofType('diagnostic').map((event) => event.payload)).toEqual([
          {
            level: 'debug',
            message: 'Unhandled Codex notification: thread/bareSignal',
            source: 'driver',
            data: { params: {} },
          },
        ])
      })
    })
  })

  describe('warning channels (T-07726)', () => {
    test.each([
      {
        method: 'warning',
        row: 'a message',
        params: { threadId: 'thread_1', message: 'Blocked.' },
        notice: true,
      },
      {
        method: 'guardianWarning',
        row: 'a message',
        params: { message: 'Blocked.' },
        notice: true,
      },
      { method: 'warning', row: 'no message', params: { threadId: 'thread_1' }, notice: false },
      {
        method: 'guardianWarning',
        row: 'an empty message',
        params: { message: '' },
        notice: false,
      },
    ])(
      '$method with $row → operator-visible notice: $notice (never folded into a debug diagnostic)',
      async ({ method, params, notice }) => {
        await withCodexTui(`inv_warning_${method}_${notice}`, (tui) => {
          tui.emit(method, params)
          expect(tui.ofType('driver.notice').map((event) => [event.payload, event.driver])).toEqual(
            notice ? [[{ message: 'Blocked.', code: method }, driver(method)]] : []
          )
          expect(tui.ofType('diagnostic')).toEqual([])
        })
      }
    )
  })

  describe('model/rerouted (T-07726)', () => {
    test('a model swap is one notice carrying both models and the reason; a half-reported reroute is dropped', async () => {
      await withCodexTui('inv_model_rerouted', (tui) => {
        tui.startTurn('turn_1')
        // Missing either model side: dropped rather than half-reported.
        tui.emit('model/rerouted', { fromModel: 'gpt-5-codex' })
        tui.emit('model/rerouted', {
          threadId: 'thread_test',
          turnId: 'turn_1',
          fromModel: 'gpt-5-codex',
          toModel: 'gpt-5-codex-safe',
          reason: 'highRiskCyberActivity',
        })
        // In-turn codex-tui events carry turn attribution as driver extra; the
        // native method rides on provenance.nativeType.
        expect(
          tui.ofType('driver.notice').map((event) => [event.payload, event.provenance?.nativeType])
        ).toEqual([
          [
            {
              message:
                'Codex rerouted the model gpt-5-codex → gpt-5-codex-safe (highRiskCyberActivity)',
              code: 'model/rerouted',
              data: {
                fromModel: 'gpt-5-codex',
                toModel: 'gpt-5-codex-safe',
                reason: 'highRiskCyberActivity',
              },
            },
            'model/rerouted',
          ],
        ])
      })
    })
  })
})
