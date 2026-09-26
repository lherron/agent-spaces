import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_reconnects' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })

for (const attempt of [2, 3, 4]) {
  io.notify('error', {
    threadId: 'thread_reconnects',
    turnId: 'turn_1',
    willRetry: true,
    error: {
      message: `Reconnecting... ${attempt}/5`,
      codexErrorInfo: 'responseStreamDisconnected',
    },
  })
}

await new Promise((resolve) => setTimeout(resolve, 100))
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'completed',
  finalOutput: 'Recovered after reconnect',
})
