import { framed, initializeAndReadThreadRequest } from '../../../src/testing/fake-codex-app-server'

const io = framed()
const resume = await initializeAndReadThreadRequest(io, 'thread/resume')
io.reject(resume, -32005, 'Thread not found', { code: 'thread_missing' })
