/**
 * T-04408 — runtime and projection preservation of dispatchEnv.
 *
 * The ingress rejection classes are covered through broker.start in
 * dispatch-env-ingress.red.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createNoopDriver } from '../../src/drivers/noop-driver'
import { buildProcessEnv, parseDispatchEnv } from '../../src/runtime/env'
import { noopSpec } from '../helpers'

/** Spec with a lockedEnv that a disjoint dispatchEnv must compose with. */
const specWithLockedEnv = (): HarnessInvocationSpec => ({
  ...noopSpec(),
  process: {
    command: 'noop-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
    lockedEnv: { CODEX_HOME: '/workspace/.codex-home' },
  },
})

// ─── Test 4: RUNTIME PRESERVATION red ───────────────────────────────────────
//
// buildProcessEnv still rejects cross-channel key collisions (defense-in-depth).

describe('T-04408 red 4 — runtime preservation (setup needs parseDispatchEnv)', () => {
  test('buildProcessEnv four-channel disjoint union still rejects key collisions', () => {
    // SyntaxError at module load → never reaches this line.
    // Green: valid DispatchEnv({ASP_RUN_ID}) + lockedEnv({CODEX_HOME}) compose without collision;
    // raw cross-channel collision still throws (defense-in-depth guard preserved).
    const validDispatch = parseDispatchEnv({ ASP_RUN_ID: 'run_123' })
    // Clean compose (different keys)
    const env = buildProcessEnv({
      lockedEnv: { CODEX_HOME: '/workspace' },
      dispatchEnv: validDispatch,
    })
    expect(env['CODEX_HOME']).toBe('/workspace')
    expect(env['ASP_RUN_ID']).toBe('run_123')
    // Cross-channel collision still detected (defense-in-depth — parseDispatchEnv prevents
    // this at the boundary, but buildProcessEnv's own guard remains)
    expect(() =>
      buildProcessEnv({
        lockedEnv: { MY_KEY: 'locked' },
        // Parsed without the lockedEnv, so the collision reaches buildProcessEnv's own guard.
        dispatchEnv: parseDispatchEnv({ MY_KEY: 'dispatch' }),
      })
    ).toThrow()
  })
})

// ─── Test 5: PROJECTION PRESERVATION ────────────────────────────────────────
//
// dispatchEnv is passed to broker.start() separately and never flows into the
// spec (not hashed/compiled into InvocationStartRequest.spec) or any read surface.

describe('T-04408 red 5 — projection: dispatchEnv stays outside hashed spec', () => {
  test('a dispatchEnv given at start never appears in status, snapshot or list responses', async () => {
    const broker = createBroker({ drivers: [createNoopDriver()] })
    // A lockedEnv spec plus a disjoint dispatchEnv starts cleanly.
    const result = await broker.start({ spec: specWithLockedEnv() }, { ASP_RUN_ID: 'run_abc' })
    expect(result.state).toBe('ready')

    const surfaces = {
      start: result,
      status: await broker.status({ invocationId: result.invocationId }),
      snapshot: await broker.snapshot({ invocationId: result.invocationId }),
      list: await broker.listInvocations({}),
    }
    // The read surfaces really describe this invocation (the lockedEnv spec).
    expect(surfaces.list.invocations.map((row) => row.invocationId)).toEqual([result.invocationId])
    for (const [surface, response] of Object.entries(surfaces)) {
      const wire = JSON.stringify(response)
      expect({ surface, leaksValue: wire.includes('run_abc') }).toEqual({
        surface,
        leaksValue: false,
      })
      expect({ surface, leaksKey: wire.includes('ASP_RUN_ID') }).toEqual({
        surface,
        leaksKey: false,
      })
      expect({ surface, leaksField: wire.includes('dispatchEnv') }).toEqual({
        surface,
        leaksField: false,
      })
    }
  })
})
