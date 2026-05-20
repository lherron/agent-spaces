import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_leaky_diagnostic' })
const turn = await expectMethod(io, 'turn/start')

const secret = process.env['HB_RED_SECRET'] ?? 'missing-secret'
const token = process.env['HB_BEARER_TOKEN'] ?? 'missing-token'

process.stderr.write(`Authorization: Bearer ${token}\n`)
process.stderr.write(`X-Api-Token: ${secret}\n`)
io.notify('error', {
  message: `diagnostic leaked env ${secret} and Bearer ${token}`,
  code: 'leaky_diagnostic',
  details: {
    secret,
    authorization: `Authorization: Bearer ${token}`,
    apiToken: `X-Api-Token: ${secret}`,
  },
})
io.respond(turn, { ok: true })
