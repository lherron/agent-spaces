import { expectMethod, framed } from '../../../src/testing/fake-codex-app-server'

const io = framed()
const init = await expectMethod(io, 'initialize')
io.respond(init, { protocolVersion: 'codex-app-server/v0' })
io.notify('error', {
  message: 'startup exploded',
  code: 'startup_error',
})
