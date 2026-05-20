import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_attachment_echo' })
const turn = await expectMethod(io, 'turn/start')

io.notify('turn/started', { turnId: 'turn_attachment' })
io.notify('item/started', {
  turnId: 'turn_attachment',
  item: {
    type: 'imageView',
    id: 'img_attachment',
    input: { observedInput: turn.params },
  },
})
io.notify('item/completed', {
  turnId: 'turn_attachment',
  item: {
    type: 'imageView',
    id: 'img_attachment',
    name: 'image_view',
    result: { observedInput: turn.params },
  },
})
io.notify('turn/completed', {
  turnId: 'turn_attachment',
  status: 'completed',
  finalOutput: 'attachment observed',
})
io.respond(turn, { ok: true })
