import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_three_turns' })

for (let turnNumber = 1; turnNumber <= 3; turnNumber += 1) {
  const turn = await expectMethod(io, 'turn/start')
  const turnId = `turn_${turnNumber}`
  const messageId = `msg_${turnNumber}`
  const text = `Three-turn fixture completed turn ${turnNumber}.`

  io.notify('turn/started', { turnId })
  io.notify('item/started', {
    turnId,
    item: { type: 'agentMessage', id: messageId },
  })
  io.notify('item/agentMessage/delta', {
    turnId,
    id: messageId,
    text,
  })
  io.notify('item/completed', {
    turnId,
    item: {
      type: 'agentMessage',
      id: messageId,
      content: [{ type: 'text', text }],
    },
  })
  io.notify('turn/completed', {
    turnId,
    status: 'completed',
    finalOutput: text,
  })
  io.respond(turn, { ok: true })
}
