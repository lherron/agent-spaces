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
  })

  test('getSessionId generates a uuid when none is provided', () => {
    const queue = new PromptQueue()
    const id = queue.getSessionId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test('push-before-iterate: queued prompts are yielded in order', async () => {
    const queue = new PromptQueue('s1')
    queue.push('first')
    queue.push('second')
    expect(queue.pendingCount()).toBe(2)

    const yielded: string[] = []
    for await (const msg of queue) {
      yielded.push(msg.message.content)
      if (yielded.length === 2) {
        queue.close()
      }
    }

    expect(yielded).toEqual(['first', 'second'])
    expect(queue.pendingCount()).toBe(0)
  })

  test('push shapes the SDKUserMessage with the queue session id', async () => {
    const queue = new PromptQueue('sess-shape')
    queue.push('hello')

    const iterator = queue[Symbol.asyncIterator]()
    const { value, done } = await iterator.next()

    expect(done).toBe(false)
    expect(value?.type).toBe('user')
    expect(value?.message).toEqual({ role: 'user', content: 'hello' })
    expect(value?.parent_tool_use_id).toBeNull()
    expect(value?.session_id).toBe('sess-shape')
    expect(typeof value?.uuid).toBe('string')
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
    queue.close('done')
    expect(() => queue.push('late')).toThrow(/Cannot push to closed queue: done/)
  })

  test('isClosed reflects close state', () => {
    const queue = new PromptQueue('s4')
    expect(queue.isClosed()).toBe(false)
    queue.close()
    expect(queue.isClosed()).toBe(true)
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

  // BUGS.md harness-claude A1: close() previously nulled the waiting resolver
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

  test('a consumer parked in for-await terminates cleanly on close()', async () => {
    const queue = new PromptQueue('s7')
    const yielded: string[] = []

    const consumer = (async () => {
      for await (const msg of queue) {
        yielded.push(msg.message.content)
      }
    })()

    // Let the consumer park inside the iterator (no messages queued).
    await Promise.resolve()
    await Promise.resolve()
    queue.close('teardown')

    const timeout = new Promise<'timed-out'>((resolve) =>
      setTimeout(() => resolve('timed-out'), 1000)
    )
    const outcome = await Promise.race([consumer.then(() => 'done' as const), timeout])

    expect(outcome).toBe('done')
    expect(yielded).toEqual([])
  })
})
