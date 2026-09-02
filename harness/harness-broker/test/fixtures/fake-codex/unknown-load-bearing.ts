import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

// Emits a novel notification under `turn/` — the TURN BRACKET family, which is
// load-bearing. Per T-07853 §6.1 the normalization cursor must halt on it, so
// the two records that follow are committed but held unnormalized until an
// operator release. Their events must then appear in cursor order.
const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_unknown_load_bearing' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('turn/experimentalBracket', { turnId: 'turn_1', detail: 'not-in-the-contract' })
io.notify('thread/tokenUsage/updated', { usage: { inputTokens: 11, outputTokens: 22 } })
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'completed',
  finalOutput: 'Held then released.',
})
