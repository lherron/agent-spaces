import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_exit' })
await expectMethod(io, 'turn/start')
io.notify('turn/started', { turnId: 'turn_1' })
io.close(42)
