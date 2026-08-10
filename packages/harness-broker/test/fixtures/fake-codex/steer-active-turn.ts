import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

/**
 * T-07155 — a turn that stays active long enough to be steered, then completes
 * only after the steer lands. Echoes the observed app-server behaviour: the
 * steer response carries the SAME turnId, and the steered text joins that turn
 * rather than starting a new one.
 */

process.on('SIGTERM', () => {
  process.exit(0)
})

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_steer' })

const start = await expectMethod(io, 'turn/start')
io.notify('turn/started', { turnId: 'turn_steer_1' })
io.respond(start, { turn: { id: 'turn_steer_1', status: 'inProgress' } })

const steer = await expectMethod(io, 'turn/steer')
const params = (steer.params ?? {}) as Record<string, unknown>
// Surface what the driver actually sent so the test can assert the precondition
// and payload without reaching into the driver's internals.
io.notify('item/completed', {
  item: {
    type: 'agentMessage',
    id: 'msg_steer_echo',
    text: JSON.stringify({
      threadId: params['threadId'],
      expectedTurnId: params['expectedTurnId'],
      input: params['input'],
    }),
    phase: 'final_answer',
  },
  threadId: 'thread_steer',
  turnId: 'turn_steer_1',
})
io.respond(steer, { turnId: 'turn_steer_1' })

io.notify('turn/completed', {
  threadId: 'thread_steer',
  turn: { id: 'turn_steer_1', status: 'completed' },
})

await new Promise(() => {})
