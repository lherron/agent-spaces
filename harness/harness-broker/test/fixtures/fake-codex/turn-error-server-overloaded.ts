import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_error_server_overloaded' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('error', {
  threadId: 'thread_error_server_overloaded',
  turnId: 'turn_1',
  willRetry: false,
  error: {
    message: 'Selected model is at capacity',
    codexErrorInfo: 'serverOverloaded',
  },
})
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'failed',
  finalOutput: 'Selected model is at capacity',
})
