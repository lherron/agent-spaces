import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_assistant' })
const turn = await expectMethod(io, 'turn/start')

io.notify('turn/started', { turnId: 'turn_1' })
io.notify('item/started', {
  turnId: 'turn_1',
  item: { type: 'agentMessage', id: 'msg_1' },
})
io.notify('item/agentMessage/delta', {
  turnId: 'turn_1',
  id: 'msg_1',
  text: 'Hello',
})
io.notify('item/agentMessage/delta', {
  turnId: 'turn_1',
  id: 'msg_1',
  text: ', world.',
})
io.notify('item/completed', {
  turnId: 'turn_1',
  item: {
    type: 'agentMessage',
    id: 'msg_1',
    content: [{ type: 'text', text: 'Hello, world.' }],
  },
})
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'completed',
  finalOutput: 'Hello, world.',
})
io.respond(turn, { ok: true })
