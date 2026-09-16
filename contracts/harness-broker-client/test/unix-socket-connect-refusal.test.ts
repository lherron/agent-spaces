import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './helpers'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// Bun reports a connect failure to a missing unix socket synchronously when
// connect() runs inside a Bun.serve request handler. A listener attached after
// connect() returns never sees it and the host process dies on an uncaught
// `error`. A child process isolates that crash from the test runner.
const probeScript = (serverSocket: string, missingSocket: string): string => `
import { UnixSocketTransport } from 'spaces-harness-broker-client'
const server = Bun.serve({
  unix: ${JSON.stringify(serverSocket)},
  async fetch() {
    try {
      await UnixSocketTransport.connect({ socketPath: ${JSON.stringify(missingSocket)}, timeoutMs: 1000 })
      return new Response('connected')
    } catch (error) {
      return new Response('refused: ' + (error instanceof Error ? error.message : String(error)))
    }
  },
})
for (let i = 0; i < 3; i++) {
  const response = await fetch('http://transport/', { unix: ${JSON.stringify(serverSocket)} })
  console.log(await response.text())
}
await Bun.sleep(50)
server.stop(true)
console.log('survived')
`

describe('UnixSocketTransport.connect refusal', () => {
  test('a missing socket rejects inside a Bun.serve handler without an uncaught error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uds-refusal-'))
    tmpDirs.push(dir)
    const scriptPath = join(
      repoRoot,
      'contracts/harness-broker-client/test',
      `.refusal-probe-${process.pid}.ts`
    )
    await Bun.write(scriptPath, probeScript(join(dir, 'http.sock'), join(dir, 'missing.sock')))
    try {
      const proc = Bun.spawn(['bun', scriptPath], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect({ exitCode, stderr: stderr.trim() }).toEqual({ exitCode: 0, stderr: '' })
      const lines = stdout.trim().split('\n')
      expect(lines).toEqual([
        'refused: Failed to connect to broker unix socket',
        'refused: Failed to connect to broker unix socket',
        'refused: Failed to connect to broker unix socket',
        'survived',
      ])
    } finally {
      await rm(scriptPath, { force: true })
    }
  }, 15_000)
})
