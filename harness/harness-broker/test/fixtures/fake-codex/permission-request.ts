import { framed, initializeAndReadThreadRequest } from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_permission' })

// One permission request per turn. The harness may drive several turns through a
// single invocation (e.g. answer-by-respond, then let the next request expire),
// so loop until stdin EOF (the framed() readline exits the process on close).
for (let turnIndex = 1; ; turnIndex++) {
  let turn = await io.read()
  while (turn.method === 'turn/interrupt') {
    io.respond(turn, {})
    turn = await io.read()
  }
  if (turn.method !== 'turn/start') {
    throw new Error(`expected turn/start, got ${turn.method}`)
  }
  const turnId = `turn_permission_${turnIndex}`
  await io.respondAndFlush(turn, { turn: { id: turnId } })
  io.notify('turn/started', { turnId })

  // The JSON-RPC id must be unique per request so the broker's rpc-client can
  // correlate each approval response to the right request.
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: `perm_${turnIndex}`,
      method: 'item/commandExecution/requestApproval',
      params: {
        command: 'rm -rf /tmp/harness-broker-permission-red-test',
        cwd: process.cwd(),
      },
    })}\n`
  )

  let responseFrame = await io.read()
  while (responseFrame.method === 'turn/interrupt') {
    io.respond(responseFrame, {})
    responseFrame = await io.read()
  }
  const response = responseFrame as unknown as {
    result?: { decision?: string; message?: string }
    error?: { message?: string }
  }
  const decision = response.result?.decision ?? 'missing'
  const approved = decision === 'approve' || decision === 'allow'

  io.notify('item/started', {
    turnId,
    item: {
      type: 'commandExecution',
      id: `cmd_permission_${turnIndex}`,
      input: { command: 'rm -rf /tmp/harness-broker-permission-red-test' },
    },
  })
  io.notify('item/completed', {
    turnId,
    item: {
      type: 'commandExecution',
      id: `cmd_permission_${turnIndex}`,
      name: 'command',
      result: { decision, approved },
    },
  })
  io.notify('turn/completed', {
    turnId,
    status: 'completed',
    finalOutput: approved ? 'permission approved' : 'permission denied',
  })
}
