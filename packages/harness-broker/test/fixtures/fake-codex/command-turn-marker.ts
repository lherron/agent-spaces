/**
 * Fake Codex app-server fixture for the pre-HRC broker MATRIX runner (T-01667).
 *
 * Emits the canonical "command turn": a commandExecution that runs
 * `printf '<MARKER>'` (normalized by the broker to a `command` tool call) plus
 * an assistant message echoing the same marker, so the shared, harness-agnostic
 * assertSharedCommandTurn floor (turn.started -> tool.call.started/.completed ->
 * assistant marker -> exactly one terminal turn) holds against a deterministic,
 * auth-free, network-free process. The marker is read from the environment so
 * each matrix run can drive a unique per-run token.
 */
import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const marker = process.env['ASP_MATRIX_FAKE_MARKER'] ?? 'ASP_MATRIX_FAKE_MARKER'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_matrix' })
const turn = await expectMethod(io, 'turn/start')

io.notify('turn/started', { turnId: 'turn_1' })

io.notify('item/started', {
  turnId: 'turn_1',
  item: {
    type: 'commandExecution',
    id: 'cmd_marker',
    command: `printf '${marker}'`,
    cwd: process.cwd(),
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    status: 'inProgress',
  },
})
io.notify('item/commandExecution/outputDelta', {
  turnId: 'turn_1',
  itemId: 'cmd_marker',
  delta: marker,
})
io.notify('item/completed', {
  turnId: 'turn_1',
  item: {
    type: 'commandExecution',
    id: 'cmd_marker',
    command: `printf '${marker}'`,
    cwd: process.cwd(),
    aggregatedOutput: marker,
    exitCode: 0,
    durationMs: 7,
    status: 'completed',
  },
})

io.notify('item/started', {
  turnId: 'turn_1',
  item: { type: 'agentMessage', id: 'msg_marker' },
})
io.notify('item/agentMessage/delta', {
  turnId: 'turn_1',
  id: 'msg_marker',
  text: marker,
})
io.notify('item/completed', {
  turnId: 'turn_1',
  item: {
    type: 'agentMessage',
    id: 'msg_marker',
    content: [{ type: 'text', text: marker }],
  },
})

io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'completed',
  finalOutput: marker,
})
io.respond(turn, { ok: true })
