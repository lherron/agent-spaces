import { expectMethod, framed } from '../../../src/testing/fake-codex-app-server'

// Responds to `initialize` with a protocolVersion the broker cannot support.
// The driver must reject startup predictably (HarnessError) before sending
// `initialized` or starting a thread.
const io = framed()
const init = await expectMethod(io, 'initialize')
io.respond(init, { protocolVersion: 'acp-incompatible/v1' })
