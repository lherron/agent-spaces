import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

process.on('SIGTERM', () => {
  process.exit(0)
})

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_delayed_live_after_turn_response' })

const turn = await expectMethod(io, 'turn/start')
io.respond(turn, { ok: true })

setTimeout(() => {
  completeSimpleTurn(io, 'Delayed live event complete.')
}, 250)

await new Promise(() => {})
