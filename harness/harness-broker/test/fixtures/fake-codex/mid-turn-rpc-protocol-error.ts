import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_rpc_protocol_error' })
const turn = await expectMethod(io, 'turn/start')
io.respond(turn, { ok: true })
io.notify('turn/started', { turnId: 'turn_1' })
process.stdout.write('{malformed-json-rpc\n')
