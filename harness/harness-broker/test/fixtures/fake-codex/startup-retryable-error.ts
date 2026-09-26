import { expectMethod, framed } from '../../../src/testing/fake-codex-app-server'

const io = framed()
const init = await expectMethod(io, 'initialize')
io.respond(init, { protocolVersion: 'codex-app-server/v0' })
io.notify('error', {
  message: 'Reconnecting during startup',
  willRetry: true,
  error: {
    message: 'Reconnecting during startup',
    codexErrorInfo: 'responseStreamDisconnected',
  },
})
