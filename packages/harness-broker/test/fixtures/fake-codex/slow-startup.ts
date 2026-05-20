import { expectMethod, framed } from '../../../src/testing/fake-codex-app-server'

process.on('SIGTERM', () => {
  process.exit(0)
})

const io = framed()
await expectMethod(io, 'initialize')
await new Promise(() => {})
