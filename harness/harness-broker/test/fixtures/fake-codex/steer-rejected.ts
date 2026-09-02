import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

/**
 * T-07155 — the app-server refuses the steer (e.g. `expectedTurnId` no longer
 * matches because the turn ended in the race window). The driver must surface
 * this as an error, never resolve as if the order had been delivered.
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

const steer = await expectMethod(io, 'turn/steer')
io.reject(steer, -32000, 'expectedTurnId does not match the active turn', {
  code: 'turn_mismatch',
})

await new Promise(() => {})
