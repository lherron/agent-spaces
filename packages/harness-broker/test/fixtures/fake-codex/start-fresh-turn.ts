import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_fresh' })
const turn = await expectMethod(io, 'turn/start')
completeSimpleTurn(io, 'Fresh turn complete.')
io.respond(turn, { ok: true })
