// Child process for aspd.test.ts: serves a slow, large compile and, like the
// aspd CLI, exits the moment retirement resolves after SIGTERM.
import type { AspcService } from 'spaces-aspc'
import { startAspdServer } from '../../src/aspd.js'

const socketPath = process.argv[2] as string
let release: (() => void) | undefined
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const service = {
  hello: async () => ({ protocolVersion: 'aspc/0.1', capabilities: {} }),
  compileHarnessInvocation: async () => {
    await gate
    return {
      schemaVersion: 'aspc-compile-harness-invocation-response/v2',
      ok: false,
      diagnostics: Array.from({ length: 4000 }, (_, i) => ({
        code: `padding_${i}`,
        message: 'x'.repeat(500),
      })),
    }
  },
} as unknown as AspcService
const server = await startAspdServer({
  socketPath,
  service,
  log: (line) => process.stderr.write(`${line}\n`),
})
process.stderr.write('ready\n')
process.on('SIGTERM', () => {
  const retired = server.retire()
  release?.()
  void retired.then(() => process.exit(0))
})
