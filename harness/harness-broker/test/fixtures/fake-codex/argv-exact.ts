import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

if (process.argv.slice(2).join('\u0000') !== '--literal\u0000$NO_EXPAND\u0000*.ts') {
  throw new Error(`argv was expanded or changed: ${JSON.stringify(process.argv.slice(2))}`)
}

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_argv' })
const turn = await expectMethod(io, 'turn/start')
completeSimpleTurn(io, 'Argv complete.')
io.respond(turn, { ok: true })
