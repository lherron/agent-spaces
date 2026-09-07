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
await io.respondAndFlush(start, { turn: { id: 'turn_steer_1', status: 'inProgress' } })
io.notify('turn/started', {
  threadId: 'thread_steer',
  turn: { id: 'turn_steer_1', status: 'inProgress', items: [] },
})
// Codex also reports the initiating user item natively. Headless mode already
// minted that row at delivery, so observing this one must not duplicate it.
io.notify('item/started', {
  threadId: 'thread_steer',
  turnId: 'turn_steer_1',
  item: {
    type: 'userMessage',
    id: 'user_initial',
    clientId: 'input_active',
    content: [{ type: 'text', text: 'do the long thing', text_elements: [] }],
  },
})

const steer = await expectMethod(io, 'turn/steer')
const params = (steer.params ?? {}) as Record<string, unknown>
const clientUserMessageId = params['clientUserMessageId']
io.respond(steer, { turnId: 'turn_steer_1' })
io.notify('item/started', {
  threadId: 'thread_steer',
  turnId: 'turn_steer_1',
  item: {
    type: 'userMessage',
    id: 'user_steer',
    clientId: clientUserMessageId,
    content: params['input'],
  },
})
// Surface what the driver actually sent so the test can assert the precondition
// and payload without reaching into the driver's internals.
io.notify('item/completed', {
  item: {
    type: 'agentMessage',
    id: 'msg_steer_echo',
    text: JSON.stringify({
      threadId: params['threadId'],
      expectedTurnId: params['expectedTurnId'],
      clientUserMessageId,
      input: params['input'],
    }),
    phase: 'final_answer',
  },
  threadId: 'thread_steer',
  turnId: 'turn_steer_1',
})

io.notify('turn/completed', {
  threadId: 'thread_steer',
  turn: { id: 'turn_steer_1', status: 'completed' },
})

await new Promise(() => {})
