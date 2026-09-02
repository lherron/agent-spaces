import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_error_auth' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('error', {
  threadId: 'thread_error_auth',
  turnId: 'turn_1',
  willRetry: false,
  reason: 'authentication',
  error: {
    message: 'Authentication failed',
    codexErrorInfo: { code: 'authenticationFailed' },
  },
})
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'failed',
  finalOutput: 'Authentication failed',
})
