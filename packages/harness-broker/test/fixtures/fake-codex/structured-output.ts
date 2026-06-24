/**
 * Fake Codex app-server fixture for the MATRIX structured-output scenario.
 *
 * It records the requested `turn/start.outputSchema` by enforcing the happy path
 * only when a schema was provided, then emits one final JSON assistant message
 * plus one turn.completed. Retry/cap behavior is covered by the claude Stop-hook
 * path; this deterministic app-server fixture pins the normalized successful
 * final-response contract without auth or network.
 */
import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const marker = process.env['ASP_MATRIX_STRUCTURED_MARKER'] ?? 'ASP_MATRIX_STRUCTURED_MARKER'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_structured_matrix' })
const turn = await expectMethod(io, 'turn/start')

const params =
  turn.params !== null && typeof turn.params === 'object' && !Array.isArray(turn.params)
    ? (turn.params as Record<string, unknown>)
    : {}
const outputSchema = params['outputSchema']
if (outputSchema === null || outputSchema === undefined) {
  throw new Error('structured-output fixture expected turn/start.outputSchema')
}

io.notify('turn/started', { turnId: 'turn_structured_1' })
io.notify('item/started', {
  turnId: 'turn_structured_1',
  item: { type: 'agentMessage', id: 'msg_structured' },
})
io.notify('item/agentMessage/delta', {
  turnId: 'turn_structured_1',
  id: 'msg_structured',
  text: JSON.stringify({ status: 'ok', marker }),
})
io.notify('item/completed', {
  turnId: 'turn_structured_1',
  item: {
    type: 'agentMessage',
    id: 'msg_structured',
    content: [{ type: 'text', text: JSON.stringify({ status: 'ok', marker }) }],
  },
})
io.notify('turn/completed', {
  turnId: 'turn_structured_1',
  status: 'completed',
  finalOutput: JSON.stringify({ status: 'ok', marker }),
})
io.respond(turn, { ok: true })
