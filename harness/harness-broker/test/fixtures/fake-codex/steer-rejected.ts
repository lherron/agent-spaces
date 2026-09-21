import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

/**
 * T-07155 — the app-server refuses the steer with an error that does not prove
 * the request was rejected before write. The driver must fail open by starting
 * the same submission as an own turn, accepting duplicate-delivery risk.
 */

process.on('SIGTERM', () => {
  process.exit(0)
})

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_steer_reject' })

const start = await expectMethod(io, 'turn/start')
await io.respondAndFlush(start, { turn: { id: 'turn_steer_reject_1', status: 'inProgress' } })
io.notify('turn/started', { turnId: 'turn_steer_reject_1' })

const turns = await expectMethod(io, 'thread/turns/list')
io.respond(turns, {
  data: [{ id: 'turn_steer_reject_1', status: 'inProgress' }],
  nextCursor: null,
  backwardsCursor: null,
})

const steer = await expectMethod(io, 'turn/steer')
io.reject(steer, -32000, 'upstream unavailable')

const fallback = await expectMethod(io, 'turn/start')
const fallbackParams = (fallback.params ?? {}) as Record<string, unknown>
await io.respondAndFlush(fallback, {
  turn: { id: 'turn_steer_reject_fallback', status: 'inProgress' },
})
io.notify('turn/started', {
  threadId: 'thread_steer_reject',
  turn: { id: 'turn_steer_reject_fallback', status: 'inProgress', items: [] },
})
io.notify('item/completed', {
  threadId: 'thread_steer_reject',
  turnId: 'turn_steer_reject_fallback',
  item: {
    type: 'agentMessage',
    id: 'msg_fallback_echo',
    text: JSON.stringify({ input: fallbackParams['input'] }),
    phase: 'final_answer',
  },
})
io.notify('turn/completed', {
  threadId: 'thread_steer_reject',
  turn: { id: 'turn_steer_reject_fallback', status: 'completed' },
})

await new Promise(() => {})
