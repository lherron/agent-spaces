import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_provider_death_open_tool' })
const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_1' } })
io.notify('turn/started', { turnId: 'turn_1' })
io.notify('item/started', {
  turnId: 'turn_1',
  item: {
    type: 'commandExecution',
    id: 'cmd_open',
    command: 'sleep 10',
    cwd: process.cwd(),
    status: 'inProgress',
  },
})
io.close(42)
