import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { delimiter, join } from 'node:path'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createCodexAppServerDriver } from '../../src/drivers/codex-app-server/driver'
import { buildProcessEnv, parseDispatchEnv } from '../../src/runtime/env'
import { invocationIdFrom } from '../ids'

describe('buildProcessEnv — pathPrepend PATH mutation', () => {
  // Computed key dodges biome's noDelete (literal-member) rule while letting us
  // truly remove PATH (assigning `undefined` would coerce to the string "undefined").
  const PATH_KEY = 'PATH'
  let originalPath: string | undefined

  beforeEach(() => {
    originalPath = process.env[PATH_KEY]
  })

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env[PATH_KEY]
    } else {
      process.env[PATH_KEY] = originalPath
    }
  })

  test('prepends directories to the composed PATH in array order', () => {
    process.env[PATH_KEY] = `/usr/bin${delimiter}/bin`
    const env = buildProcessEnv({ pathPrepend: ['/a/bin', '/b/bin'] })
    expect(env['PATH']).toBe(`/a/bin${delimiter}/b/bin${delimiter}/usr/bin${delimiter}/bin`)
  })

  test.each([
    { row: 'absent', ambient: undefined },
    { row: 'empty', ambient: '' },
  ])('uses the joined prepend list when ambient PATH is $row', ({ ambient }) => {
    if (ambient === undefined) delete process.env[PATH_KEY]
    else process.env[PATH_KEY] = ambient
    const env = buildProcessEnv({ pathPrepend: ['/a/bin', '/b/bin'] })
    expect(env['PATH']).toBe(`/a/bin${delimiter}/b/bin`)
  })

  test('a directory already present in ambient PATH is NOT a collision', () => {
    process.env['PATH'] = `/usr/bin${delimiter}/bin`
    // /usr/bin is already in ambient PATH; pathPrepend intentionally mutates PATH.
    const env = buildProcessEnv({ pathPrepend: ['/usr/bin'] })
    expect(env['PATH']).toBe(`/usr/bin${delimiter}/usr/bin${delimiter}/bin`)
  })

  test('absence/empty pathPrepend leaves the composed PATH untouched', () => {
    process.env['PATH'] = `/usr/bin${delimiter}/bin`
    expect(buildProcessEnv({})['PATH']).toBe(`/usr/bin${delimiter}/bin`)
    expect(buildProcessEnv({ pathPrepend: [] })['PATH']).toBe(`/usr/bin${delimiter}/bin`)
  })

  test('PATH mutation applies after the four-channel disjoint-union compose', () => {
    process.env['PATH'] = '/usr/bin'
    const env = buildProcessEnv({
      lockedEnv: { CODEX_HOME: '/workspace/.codex-home' },
      dispatchEnv: parseDispatchEnv({ ASP_RUN_ID: 'run_123' }),
      pathPrepend: ['/agent/tools/bin'],
    })
    expect(env['CODEX_HOME']).toBe('/workspace/.codex-home')
    expect(env['ASP_RUN_ID']).toBe('run_123')
    expect(env['PATH']).toBe(`/agent/tools/bin${delimiter}/usr/bin`)
  })
})

const fakeCodex = join(import.meta.dir, '../fixtures/fake-codex/tool-calls.ts')

const codexSpec = (invocationId: string, pathPrepend: string[]): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom(invocationId),
  harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
  process: {
    command: process.execPath,
    args: [fakeCodex],
    cwd: process.cwd(),
    pathPrepend,
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
  driver: {
    kind: 'codex-app-server',
    resumeFallback: 'start-fresh',
    permissionPolicy: { mode: 'deny' },
  },
})

describe('broker.start — spec.process.pathPrepend validation', () => {
  // The protocol schema only checks `string[]`, so each bad entry reaches the
  // spawn-time env compose and must be refused there, naming the rule.
  test.each([
    { row: 'empty', pathPrepend: [''], rule: 'pathPrepend entry must be a non-empty string' },
    {
      row: 'relative',
      pathPrepend: ['relative/bin'],
      rule: 'pathPrepend entry must be an absolute path: relative/bin',
    },
    {
      row: 'NUL',
      pathPrepend: [`/a/bin${String.fromCharCode(0)}`],
      rule: 'pathPrepend entry must not contain a NUL byte',
    },
    {
      row: 'delimiter',
      pathPrepend: [`/a/bin${delimiter}/b/bin`],
      rule: 'pathPrepend entry must not contain the path delimiter',
    },
    {
      row: 'duplicate',
      pathPrepend: ['/a/bin', '/a/bin'],
      rule: 'pathPrepend contains a duplicate entry: /a/bin',
    },
  ])(
    'an invalid ($row) pathPrepend entry is refused at start with a message naming the rule',
    async ({ row, pathPrepend, rule }) => {
      const broker = createBroker({ drivers: [createCodexAppServerDriver()] })
      await expect(
        broker.start({ spec: codexSpec(`inv_path_prepend_${row}`, [...pathPrepend]) })
      ).rejects.toMatchObject({
        code: BrokerErrorCode.DispatchValidationFailed,
        message: expect.stringContaining(rule),
      })
    }
  )
})
