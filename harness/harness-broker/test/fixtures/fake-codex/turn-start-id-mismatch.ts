import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_turn_start_id_mismatch' })

const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_acknowledged' } })
io.notify('turn/started', { turnId: 'turn_different' })
io.notify('turn/completed', {
  turnId: 'turn_different',
  status: 'completed',
  finalOutput: 'a terminal for a turn id the broker never acknowledged',
})
