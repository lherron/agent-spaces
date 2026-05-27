import { expectMethod, framed } from '../../../src/testing/fake-codex-app-server'

// Completes the handshake but exits before the thread is started, i.e. the
// process dies while the invocation is still in startup. The driver must reject
// startup and the broker must emit a terminal invocation.failed.
const io = framed()
const init = await expectMethod(io, 'initialize')
io.respond(init, { protocolVersion: 'codex-app-server/v0' })
await expectMethod(io, 'initialized')
io.close(7)
