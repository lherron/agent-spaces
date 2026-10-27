/**
 * Tests for PromptQueue — the AsyncIterable that feeds user prompts to the
 * Claude Agent SDK input loop.
 *
 * WHY: PromptQueue owns the push/park/deliver/close handshake that drives the
 * SDK's multi-turn input iterator. It previously had zero coverage despite being
 * on the hot session path (REFACTOR-BACKLOG harness-claude A6). These tests pin
 * the queued-then-iterated, parked-then-delivered, and close/state semantics.
 */

import { describe, expect, test } from 'bun:test'
import { PromptQueue } from './prompt-queue.js'

describe('PromptQueue', () => {
  test('getSessionId returns the provided session id', () => {
    const queue = new PromptQueue('session-123')
    expect(queue.getSessionId()).toBe('session-123')
    expect(new PromptQueue().getSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  test('push-before-iterate: queued prompts are yielded in order', async () => {
    const queue = new PromptQueue('s1')
    queue.push('first')
    queue.push('second')
    expect(queue.pendingCount()).toBe(2)

    const yielded: string[] = []
    for await (const msg of queue) {
      yielded.push(msg.message.content)
      expect(msg.type).toBe('user')
      expect(msg.message.role).toBe('user')
      expect(msg.parent_tool_use_id).toBeNull()
      expect(msg.session_id).toBe('s1')
      expect(typeof msg.uuid).toBe('string')
      if (yielded.length === 2) {
        queue.close()
      }
    }

    expect(yielded).toEqual(['first', 'second'])
    expect(queue.pendingCount()).toBe(0)
  })

  test('iterate-then-push: a parked consumer is woken by a later push', async () => {
    const queue = new PromptQueue('s2')
    const iterator = queue[Symbol.asyncIterator]()

    // Park the consumer first (no messages queued yet).
    const nextPromise = iterator.next()
    // Deliver after the consumer has parked.
    await Promise.resolve()
    queue.push('delivered')

    const { value, done } = await nextPromise
    expect(done).toBe(false)
    expect(value?.message.content).toBe('delivered')
  })

  test('push throws once the queue is closed', () => {
    const queue = new PromptQueue('s3')
    expect(queue.isClosed()).toBe(false)
    queue.close('done')
    expect(queue.isClosed()).toBe(true)
    expect(() => queue.push('late')).toThrow(/Cannot push to closed queue: done/)
  })

  test('closing before a consumer parks terminates iteration immediately', async () => {
    const queue = new PromptQueue('s5')
    queue.close()

    const yielded: string[] = []
    for await (const msg of queue) {
      yielded.push(msg.message.content)
    }
    expect(yielded).toEqual([])
  })

  // wrkq T-10129 attachment BUGS.md (ATT-00153) harness-claude A1: close() previously nulled the waiting resolver
  // WITHOUT calling it, so a consumer that parked BEFORE close() never resolved
  // — its `await` hung forever, wedging the SDK input loop on normal teardown.
  // close() now resolves the parked waiter with null (the iterator's completion
  // signal) so the await unblocks and iteration terminates cleanly.
  test('close() wakes a consumer that parked first (BUGS harness-claude A1)', async () => {
    const queue = new PromptQueue('s6')
    const iterator = queue[Symbol.asyncIterator]()

    const nextPromise = iterator.next()
    await Promise.resolve()
    queue.close('teardown')

    // Guard against a regression hang: if close() fails to wake the parked
    // consumer, this await never settles, so race it against a timeout.
    const timeout = new Promise<{ done: boolean; timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ done: false, timedOut: true }), 1000)
    )
    const result = await Promise.race([
      nextPromise.then((r) => ({ done: r.done, timedOut: false as const })),
      timeout,
    ])

    expect(result.timedOut).toBe(false)
    expect(result.done).toBe(true)
  })
})
