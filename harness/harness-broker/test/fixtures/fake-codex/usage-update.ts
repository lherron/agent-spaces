import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_usage' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
// Yield a macrotask before the first notification. `turn.started` is minted
// from the turn/start RESPONSE through an await chain, while a notification is
// mapped synchronously as its line is read — so when the response and the
// notification land in ONE pipe read, `usage.updated` overtakes `turn.started`
// and the golden's event order flips. That flake predates T-07883 (reproduced
// on the unchanged capture gate, 3 of 6 runs); the fixture is where it is
// fixable, because the interleaving is a property of the write, not the broker.
await new Promise((resolve) => setTimeout(resolve, 25))
io.notify('thread/tokenUsage/updated', {
  usage: {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
  },
})
completeSimpleTurn(io, 'Usage complete.')
