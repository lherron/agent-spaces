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
io.respond(thread, { threadId: 'thread_unacknowledged_turn' })
await expectMethod(io, 'turn/start')
await new Promise(() => {})
