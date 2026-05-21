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
const turnParams = (turn.params ?? {}) as { input?: Array<Record<string, unknown>> }
const localImage = (turnParams.input ?? []).find((item) => item['type'] === 'localImage')
const attachmentPath = typeof localImage?.['path'] === 'string' ? localImage['path'] : ''
io.notify('item/started', {
  turnId: 'turn_attachment',
  item: {
    type: 'imageView',
    id: 'img_attachment',
    path: attachmentPath,
  },
})
io.notify('item/completed', {
  turnId: 'turn_attachment',
  item: {
    type: 'imageView',
    id: 'img_attachment',
    path: attachmentPath,
  },
})
io.notify('turn/completed', {
  turnId: 'turn_attachment',
  status: 'completed',
  finalOutput: 'attachment observed',
})
io.respond(turn, { ok: true })
