import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

process.on('SIGTERM', () => {
  // Exercise stopGraceMs: the broker must escalate to SIGKILL.
})

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_stubborn_stop' })
await expectMethod(io, 'turn/start')
io.notify('turn/started', { turnId: 'turn_stubborn' })
await new Promise(() => {})
