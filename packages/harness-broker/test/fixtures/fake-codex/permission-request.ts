import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_permission' })
const turn = await expectMethod(io, 'turn/start')
io.notify('turn/started', { turnId: 'turn_permission' })

process.stdout.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 'perm_1',
    method: 'item/commandExecution/requestApproval',
    params: {
      command: 'rm -rf /tmp/harness-broker-permission-red-test',
      cwd: process.cwd(),
    },
  })}\n`
)

const response = (await io.read()) as unknown as {
  result?: { decision?: string; message?: string }
  error?: { message?: string }
}
const decision = response.result?.decision ?? 'missing'
const approved = decision === 'approve' || decision === 'allow'

io.notify('item/started', {
  turnId: 'turn_permission',
  item: {
    type: 'commandExecution',
    id: 'cmd_permission',
    input: { command: 'rm -rf /tmp/harness-broker-permission-red-test' },
  },
})
io.notify('item/completed', {
  turnId: 'turn_permission',
  item: {
    type: 'commandExecution',
    id: 'cmd_permission',
    name: 'command',
    result: { decision, approved },
  },
})
io.notify('turn/completed', {
  turnId: 'turn_permission',
  status: 'completed',
  finalOutput: approved ? 'permission approved' : 'permission denied',
})
io.respond(turn, { ok: true })
