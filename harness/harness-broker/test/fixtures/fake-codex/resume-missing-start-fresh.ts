import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const resume = await initializeAndReadThreadRequest(io, 'thread/resume')
io.reject(resume, -32005, 'Thread not found', { code: 'thread_missing' })
const start = await expectMethod(io, 'thread/start')
io.respond(start, { threadId: 'thread_fallback' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
completeSimpleTurn(io, 'Fallback turn complete.')
