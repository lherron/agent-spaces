// T-09238: a transient reconnect (willRetry: true) that codex recovers from
// must leave the turn running; the turn then completes normally.
import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_retry_recovered' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })
for (const attempt of [2, 3]) {
  io.notify('error', {
    threadId: 'thread_retry_recovered',
    turnId: 'turn_1',
    willRetry: true,
    error: {
      message: `Reconnecting... ${attempt}/5`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    },
  })
}
io.notify('turn/completed', { turnId: 'turn_1', status: 'completed', finalOutput: 'recovered' })
