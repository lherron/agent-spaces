// T-09238: codex reports each reconnect attempt as an `error` with willRetry:
// true on the SAME turn, then a final willRetry:false error once it gives up
// (recorded on max3 2026-09-25, inv-3b639fd0). Only the final error may fail
// the turn; the retries are diagnostics.
import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_retry_exhausted' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })
for (const attempt of [2, 3]) {
  io.notify('error', {
    threadId: 'thread_retry_exhausted',
    turnId: 'turn_1',
    willRetry: true,
    error: {
      message: `Reconnecting... ${attempt}/5`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    },
  })
}
io.notify('error', {
  threadId: 'thread_retry_exhausted',
  turnId: 'turn_1',
  willRetry: false,
  error: {
    message: 'unexpected status 401 Unauthorized',
    codexErrorInfo: 'other',
  },
})
