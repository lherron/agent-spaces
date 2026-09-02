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
io.notify('thread/tokenUsage/updated', {
  usage: {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
  },
})
completeSimpleTurn(io, 'Usage complete.')
