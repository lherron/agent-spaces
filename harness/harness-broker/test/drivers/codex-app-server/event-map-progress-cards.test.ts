import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { withCodexTui } from './codex-tui-transport-support'

// Native plan, reasoning and diff notifications pushed through the real
// codex-tui driver (FakeCodexRpc), asserted on the broker diagnostics the
// renderer draws as progress cards.

const T = 'thread_test'

const cards = (events: InvocationEventEnvelope[], kind: string) =>
  events.filter(
    (event) =>
      event.type === 'diagnostic' &&
      ('kind' in event.payload ? event.payload.kind : undefined) === kind
  )

describe('codex plan, reasoning and diff cards reach the broker', () => {
  describe('turn/plan/updated (T-06325)', () => {
    test('a plan update is one plan diagnostic carrying structured steps; an empty plan yields none', async () => {
      await withCodexTui('inv_plan_card', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('turn/plan/updated', { threadId: T, turnId: 'turn_1', plan: [] })
        expect(cards(tui.since(), 'plan')).toEqual([])

        tui.emit('turn/plan/updated', {
          threadId: T,
          turnId: 'turn_1',
          explanation: null,
          plan: [
            { step: 'Add failing tests', status: 'inProgress' },
            { step: 'Implement', status: 'pending' },
          ],
        })
        const plans = cards(tui.since(), 'plan')
        expect(plans).toHaveLength(1)
        expect((plans[0]?.payload as Record<string, unknown>)['data']).toEqual({
          steps: [
            { step: 'Add failing tests', status: 'inProgress' },
            { step: 'Implement', status: 'pending' },
          ],
        })
        expect(plans[0]?.provenance?.nativeType).toBe('turn/plan/updated')
      })
    })
  })

  describe('reasoning summary capture (T-06380)', () => {
    test('collapses streamed summary churn into one durable diagnostic at item completion', async () => {
      await withCodexTui('inv_reasoning_summary', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('item/started', {
          threadId: T,
          turnId: 'turn_1',
          item: { type: 'reasoning', id: 'reason_1', summary: [], content: [] },
        })
        tui.emit('item/reasoning/summaryPartAdded', {
          threadId: T,
          turnId: 'turn_1',
          itemId: 'reason_1',
          summaryIndex: 0,
        })
        tui.emit('item/reasoning/summaryTextDelta', {
          threadId: T,
          turnId: 'turn_1',
          itemId: 'reason_1',
          summaryIndex: 0,
          delta: '**Planning the inspection**',
        })
        expect(cards(tui.since(), 'reasoning')).toEqual([])

        tui.emit('item/completed', {
          threadId: T,
          turnId: 'turn_1',
          item: {
            type: 'reasoning',
            id: 'reason_1',
            summary: ['**Planning the inspection**', 'Checking the package name'],
            content: [],
          },
        })
        const reasoning = cards(tui.since(), 'reasoning')
        expect(reasoning).toHaveLength(1)
        expect(reasoning[0]).toMatchObject({
          turnId: 'turn_1',
          payload: {
            level: 'debug',
            source: 'driver',
            kind: 'reasoning',
            message: 'Codex reasoning summary captured',
            data: {
              summary: '**Planning the inspection**\n\nChecking the package name',
              truncated: false,
            },
          },
          provenance: { nativeType: 'item/completed' },
        })
      })
    })

    test('never persists raw reasoning text when no provider summary is present', async () => {
      await withCodexTui('inv_reasoning_raw_text', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('item/reasoning/textDelta', {
          threadId: T,
          turnId: 'turn_1',
          itemId: 'reason_1',
          contentIndex: 0,
          delta: 'raw chain of thought',
        })
        tui.emit('item/completed', {
          threadId: T,
          turnId: 'turn_1',
          item: {
            type: 'reasoning',
            id: 'reason_1',
            summary: [],
            content: ['raw chain of thought'],
          },
        })
        expect(cards(tui.since(), 'reasoning')).toEqual([])
        expect(JSON.stringify(tui.since())).not.toContain('raw chain of thought')
      })
    })

    test('bounds a captured summary by both part count and character count', async () => {
      await withCodexTui('inv_reasoning_bounded', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('item/completed', {
          threadId: T,
          turnId: 'turn_1',
          item: {
            type: 'reasoning',
            id: 'reason_1',
            summary: ['x'.repeat(5_000), ...Array.from({ length: 9 }, (_, i) => `part ${i}`)],
          },
        })
        const payload = cards(tui.since(), 'reasoning')[0]?.payload as {
          data: { summary: string; truncated: boolean }
        }
        expect(payload.data.summary).toHaveLength(4_096)
        expect(payload.data.truncated).toBe(true)
      })
    })
  })

  describe('turn/diff/updated (T-06325)', () => {
    test('summarizes a unified diff into compact per-file add/remove counts; a blank diff yields none', async () => {
      const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 000..111 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,3 @@',
        ' context',
        '-old line',
        '+new line',
        '+extra line',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        '-removed',
      ].join('\n')
      await withCodexTui('inv_diff_card', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff: '   ' })
        expect(cards(tui.since(), 'diff')).toEqual([])

        tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
        const diffs = cards(tui.since(), 'diff')
        expect(diffs).toHaveLength(1)
        expect((diffs[0]?.payload as Record<string, unknown>)['data']).toEqual({
          files: [
            { path: 'src/a.ts', added: 2, removed: 1 },
            { path: 'src/b.ts', added: 0, removed: 1 },
          ],
          totalAdded: 2,
          totalRemoved: 2,
          truncated: 0,
        })
      })
    })
  })

  describe('turn/diff/updated dedupe (T-06350)', () => {
    // Codex re-emits the whole turn's CUMULATIVE diff on every rate-limit telemetry
    // heartbeat, unchanged. Measured over real captures: 822/822 heartbeat-triggered
    // fires carried a byte-identical diff, so the pane repainted the same card.
    const diffFor = (added: string[]) =>
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -0,0 +1 @@',
        ...added.map((l) => `+${l}`),
      ].join('\n')

    test('an unchanged cumulative diff re-sent on heartbeats renders once, and a grown diff renders again', async () => {
      await withCodexTui('inv_diff_dedupe_heartbeat', (tui) => {
        tui.startTurn('turn_1')
        const diff = diffFor(['one'])
        // The real firing pattern: heartbeat, then the same diff again, over and over.
        tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
        for (let i = 0; i < 5; i++) {
          tui.emit('account/rateLimits/updated', { rateLimits: { used: 1 } })
          tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
        }
        expect(cards(tui.since(), 'diff')).toHaveLength(1)
        // An edit lands: the cumulative diff grows, so the summary changes.
        tui.emit('turn/diff/updated', {
          threadId: T,
          turnId: 'turn_1',
          diff: diffFor(['one', 'two']),
        })
        expect(cards(tui.since(), 'diff')).toHaveLength(2)
      })
    })

    test('a new turn re-renders its first diff even if identical to the previous turn', async () => {
      await withCodexTui('inv_diff_dedupe_new_turn', (tui) => {
        const diff = diffFor(['one'])
        tui.startTurn('turn_1')
        tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
        tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
        expect(cards(tui.since(), 'diff')).toHaveLength(1)
        // Dedupe is keyed by turn id, so the reset must come from turn/started
        // itself: re-start the SAME id rather than a fresh one.
        tui.startTurn('turn_1')
        tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
        expect(cards(tui.since(), 'diff')).toHaveLength(2)
      })
    })

    test('dedupe is per-invocation, so a second invocation renders the same first diff', async () => {
      const diff = diffFor(['one'])
      for (const id of ['inv_diff_dedupe_first', 'inv_diff_dedupe_second']) {
        await withCodexTui(id, (tui) => {
          tui.startTurn('turn_1')
          tui.emit('turn/diff/updated', { threadId: T, turnId: 'turn_1', diff })
          expect(cards(tui.since(), 'diff')).toHaveLength(1)
        })
      }
    })
  })
})
