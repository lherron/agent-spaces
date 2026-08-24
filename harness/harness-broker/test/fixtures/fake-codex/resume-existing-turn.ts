import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/resume')
io.respond(thread, { threadId: 'thread_existing' })
const turn = await expectMethod(io, 'turn/start')
completeSimpleTurn(io, 'Resumed turn complete.')
io.respond(turn, { ok: true })
