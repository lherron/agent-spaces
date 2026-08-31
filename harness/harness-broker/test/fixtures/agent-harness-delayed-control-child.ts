import { createConnection } from 'node:net'
import {
  AgentHarnessControlDecoder,
  encodeAgentHarnessControlFrame,
  validateAgentHarnessControlFrame,
} from 'spaces-harness-broker-protocol'

const socketPath = process.argv[2]
const delayMs = Number(process.argv[3] ?? '0')

if (socketPath === undefined || socketPath.length === 0) {
  throw new Error('control socket path is required')
}
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error(`invalid connection delay: ${process.argv[3] ?? ''}`)
}

await Bun.sleep(delayMs)

const socket = createConnection(socketPath)
socket.setEncoding('utf8')
await new Promise<void>((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})

const decoder = new AgentHarnessControlDecoder()
socket.on('data', (chunk: string) => {
  for (const result of decoder.push(chunk)) {
    if (!result.ok) throw result.error
    const frame = validateAgentHarnessControlFrame(result.value)
    if (frame.verb === 'session.config') {
      socket.write(`${JSON.stringify({ ack: true, requestId: frame.requestId })}\n`)
      socket.write(
        encodeAgentHarnessControlFrame({
          verb: 'ready',
          payload: { sessionFile: '/sessions/delayed-control-child.jsonl' },
        })
      )
      continue
    }
    if (frame.verb === 'turn.begin') {
      socket.write(`${JSON.stringify({ ack: true, requestId: frame.requestId })}\n`)
      continue
    }
    throw new Error(`unexpected broker frame: ${frame.verb}`)
  }
})

socket.write(
  encodeAgentHarnessControlFrame({
    verb: 'hello',
    payload: { protocolVersion: 'agent-harness-control/v1' },
  })
)

await new Promise<void>((resolve, reject) => {
  socket.once('close', resolve)
  socket.once('error', reject)
})
