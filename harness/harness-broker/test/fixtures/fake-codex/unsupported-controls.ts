import { framed, initializeAndReadThreadRequest } from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_unsupported' })
await new Promise(() => {})
