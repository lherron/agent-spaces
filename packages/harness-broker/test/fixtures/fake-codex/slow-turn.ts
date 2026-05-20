import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

process.on('SIGTERM', () => {
  process.exit(0)
})

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_slow_turn' })
await expectMethod(io, 'turn/start')
io.notify('turn/started', { turnId: 'turn_slow' })
await new Promise(() => {})
