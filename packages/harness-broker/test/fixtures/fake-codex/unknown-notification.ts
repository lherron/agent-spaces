import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

// Emits a native notification the driver does not map. The driver must surface
// it as a trace-level diagnostic (annotated with the native method) rather than
// dropping it silently or leaking the native method as a normalized event type.
const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_unknown' })
const turn = await expectMethod(io, 'turn/start')
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('thread/experimentalSignal', { detail: 'not-in-the-contract' })
io.notify('turn/completed', { turnId: 'turn_1', status: 'completed', finalOutput: 'Done.' })
io.respond(turn, { ok: true })
