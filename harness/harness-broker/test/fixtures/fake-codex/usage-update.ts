import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_usage' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
// Yield a macrotask before the first notification. `turn.started` is minted
// from the turn/start RESPONSE through an await chain, while a notification is
// mapped synchronously as its line is read — so when the response and the
// notification land in ONE pipe read, `usage.updated` overtakes `turn.started`
// and the golden's event order flips. That flake predates T-07883 (reproduced
// on the unchanged capture gate, 3 of 6 runs); the fixture is where it is
// fixable, because the interleaving is a property of the write, not the broker.
await new Promise((resolve) => setTimeout(resolve, 25))
// Real codex wire shape (v2 ThreadTokenUsageUpdatedNotification): the
// breakdown rides under `tokenUsage` as {total, last, modelContextWindow},
// mirroring a payload stored in HRC on 2026-10-14 (T-10927).
io.notify('thread/tokenUsage/updated', {
  threadId: 'thread_usage',
  turnId: 'turn_1',
  tokenUsage: {
    total: {
      totalTokens: 44094,
      inputTokens: 43937,
      cachedInputTokens: 39680,
      cacheWriteInputTokens: 0,
      outputTokens: 157,
      reasoningOutputTokens: 64,
    },
    last: {
      totalTokens: 44094,
      inputTokens: 43937,
      cachedInputTokens: 39680,
      cacheWriteInputTokens: 0,
      outputTokens: 157,
      reasoningOutputTokens: 64,
    },
    modelContextWindow: 258400,
  },
})
completeSimpleTurn(io, 'Usage complete.')
