import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_sandbox_policy' })

const turn = await expectMethod(io, 'turn/start')
const sandboxPolicy = (turn.params as { sandboxPolicy?: unknown } | undefined)?.sandboxPolicy

if (
  sandboxPolicy === null ||
  typeof sandboxPolicy !== 'object' ||
  Array.isArray(sandboxPolicy) ||
  (sandboxPolicy as { type?: unknown }).type !== 'workspaceWrite'
) {
  io.reject(
    turn,
    -32005,
    'Invalid request: invalid type: string "workspace-write", expected internally tagged enum SandboxPolicyDeserialize'
  )
} else {
  completeSimpleTurn(io, 'Sandbox policy accepted.')
  io.respond(turn, { ok: true })
}
