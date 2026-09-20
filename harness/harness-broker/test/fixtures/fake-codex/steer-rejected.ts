import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

/**
 * T-07155 — the app-server refuses the steer with an error that does not prove
 * the request was rejected before write. The driver must surface this as an
 * error, never retry or resolve as if the order had been delivered.
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

const read = await expectMethod(io, 'thread/read')
io.respond(read, {
  thread: {
    id: 'thread_steer_reject',
    turns: [{ id: 'turn_steer_reject_1', status: 'inProgress' }],
  },
})

const steer = await expectMethod(io, 'turn/steer')
io.reject(steer, -32000, 'upstream unavailable')

await new Promise(() => {})
