/**
 * A broker life to SIGKILL (peer-delivery.test.ts): it serves the fake desktop
 * session named by argv, admits one steer, prints `written` once the message
 * reached the session's socket, and then waits to be killed.
 */
import { createBroker } from '../../../src/broker'
import { createClaudeDesktopDriver } from '../../../src/drivers/claude-desktop/driver'
import { DESKTOP_SESSION_ID } from './desktop-rows'
import { desktopSpec } from './observer-harness'

const [claudeHome, pid, body] = process.argv.slice(2) as [string, string, string]
const broker = createBroker({
  drivers: [
    createClaudeDesktopDriver({
      sessionId: DESKTOP_SESSION_ID,
      claudeHome,
      pollIntervalMs: 10,
      watchTranscript: false,
      hookSocketPath: false,
      delivery: { env: { CLAUDE_PID: pid } },
    }),
  ],
  onEvent: (event) => {
    if (event.type === 'input.accepted') process.stdout.write('written\n')
  },
})
await broker.start({ spec: desktopSpec('inv-killed') })
const steered = await broker.steer({
  invocationId: 'inv-killed' as never,
  origin: { principalRef: 'agent:mable' },
  body,
})
process.stdout.write(`submission ${steered.submissionId}\n`)
setInterval(() => undefined, 60_000)
