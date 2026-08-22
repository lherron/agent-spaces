/**
 * T-07314 RED (AC-6): the composition package preserves taskboard's bare
 * `aspc-facade run --transport stdio` global-bin contract byte-for-byte.
 *
 * Every case drives the REAL bin file, spawned exactly the way an out-of-repo
 * consumer spawns the linked executable. The stderr strings and exit codes
 * below ARE the preserved contract — they are asserted verbatim.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import {
  FACADE_BIN,
  type Fixture,
  createFixture,
  removeFixture,
  repoRoot,
  startFacadeClient,
} from './helpers'

const USAGE = 'Usage: aspc-facade run --transport stdio\n'

let fixture: Fixture

beforeEach(() => {
  fixture = createFixture()
})

afterEach(() => {
  removeFixture(fixture)
})

function runFacade(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [FACADE_BIN, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr }
}

describe('aspc-facade global-bin contract', () => {
  test('AC-6: `run --transport stdio` starts a stdio JSON-RPC server', async () => {
    const client = await startFacadeClient(fixture)
    try {
      const hello = await client.hello()
      expect(hello.protocolVersion).toBe(ASPC_PROTOCOL_VERSION)
      expect(hello.facadeInfo.name).toBe('aspc-facade')
    } finally {
      await client.close()
    }
  })

  test('AC-6: unknown or missing transport exits 1 with the exact message', () => {
    const tcp = runFacade(['run', '--transport', 'tcp'])
    expect(tcp.stderr).toBe('Unknown or missing transport: tcp\n')
    expect(tcp.status).toBe(1)

    const missing = runFacade(['run'])
    expect(missing.stderr).toBe('Unknown or missing transport: (none)\n')
    expect(missing.status).toBe(1)
  })

  test('AC-6: unknown or absent command exits 1 with the exact usage message', () => {
    const unknown = runFacade(['serve'])
    expect(unknown.stderr).toBe(`Unknown command: serve\n${USAGE}`)
    expect(unknown.status).toBe(1)

    const absent = runFacade([])
    expect(absent.stderr).toBe(`Unknown command: (none)\n${USAGE}`)
    expect(absent.status).toBe(1)
  })
})
