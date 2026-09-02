import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

process.on('SIGTERM', () => {
  process.exit(0)
})

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_interrupt' })

const turn = await expectMethod(io, 'turn/start')
await io.respondAndFlush(turn, { turn: { id: 'turn_interrupt_1' } })
io.notify('turn/started', { turnId: 'turn_interrupt_1' })

const interrupt = await expectMethod(io, 'turn/interrupt')
const params = interrupt.params as { threadId?: unknown; turnId?: unknown }
if (params.threadId !== 'thread_interrupt' || params.turnId !== 'turn_interrupt_1') {
  throw new Error(`unexpected turn/interrupt params: ${JSON.stringify(params)}`)
}
io.respond(interrupt, {})
await new Promise(() => {})
