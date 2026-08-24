import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_error_rate_limit' })
const turn = await expectMethod(io, 'turn/start')
io.respond(turn, { ok: true })
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('error', {
  threadId: 'thread_error_rate_limit',
  turnId: 'turn_1',
  willRetry: true,
  error: {
    message: 'Too many requests',
    codexErrorInfo: { code: 'rateLimitExceeded' },
  },
})
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'failed',
  finalOutput: 'Too many requests',
})
