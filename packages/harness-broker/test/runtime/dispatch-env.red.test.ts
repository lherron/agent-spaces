/**
 * T-04408 RED — tests 1, 4, 5: parseDispatchEnv parser + runtime/projection preservation
 *
 * ALL tests in this file fail at module load with:
 *   SyntaxError: Export named 'parseDispatchEnv' not found in module '.../env.ts'
 *
 * This IS the designed failure reason: parseDispatchEnv does not exist yet.
 * Each test describes what it will assert once green (T-04408 implemented).
 *
 * GREEN: clod adds parseDispatchEnv + DispatchEnv to env.ts → import resolves →
 * all tests flip from SyntaxError to passing assertions.
 *
 * Test 3 (type-level proof) is in src/runtime/dispatch-env-type-contracts.ts —
 * it fails at `bun run typecheck` (tsc reports Unused @ts-expect-error).
 */
import { describe, expect, test } from 'bun:test'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createNoopDriver } from '../../src/drivers/noop-driver'
// T-04408 red: parseDispatchEnv is NOT exported from env.ts yet.
// Bun throws at module load: "Export named 'parseDispatchEnv' not found in module".
// This is the right failure reason for tests 1, 4, 5 — the boundary parser is absent.
import { buildProcessEnv, parseDispatchEnv } from '../../src/runtime/env'
import { noopSpec } from '../helpers'

/** Spec with lockedEnv to verify no-shadow rules in test 1 and compose in test 4. */
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

// ─── Test 1: PARSER red ──────────────────────────────────────────────────────
//
// parseDispatchEnv does not exist → SyntaxError at module load → all tests fail.
// Green assertions (what each test should verify once implemented):
//   - Invalid key/class/non-string → BrokerError(DispatchValidationFailed)
//   - dispatchEnv shadows lockedEnv key → BrokerError(DispatchValidationFailed)
//   - Valid map → DispatchEnv (frozen clone, value-equal to input)
//   - undefined input → undefined (absent → absent)

describe('T-04408 red 1 — parseDispatchEnv parser (does not exist yet)', () => {
  test('invalid key (starts with digit) → typed parse error', () => {
    // Green: expect(() => parseDispatchEnv({ '9INVALID': 'val' })).toThrow(BrokerError)
    // and BrokerError.code === DispatchValidationFailed
    expect(() =>
      (parseDispatchEnv as unknown as (x: unknown) => unknown)({ '9INVALID': 'val' })
    ).toThrow()
  })

  test('ambient key (HOME) → typed parse error', () => {
    expect(() =>
      (parseDispatchEnv as unknown as (x: unknown) => unknown)({ HOME: '/home' })
    ).toThrow()
  })

  test('credential key (OPENAI_API_KEY) → typed parse error', () => {
    expect(() =>
      (parseDispatchEnv as unknown as (x: unknown) => unknown)({ OPENAI_API_KEY: 'sk-xxx' })
    ).toThrow()
  })

  test('reserved key (NODE_ENV) → typed parse error', () => {
    expect(() =>
      (parseDispatchEnv as unknown as (x: unknown) => unknown)({ NODE_ENV: 'test' })
    ).toThrow()
  })

  test('non-string value → typed parse error', () => {
    expect(() => (parseDispatchEnv as unknown as (x: unknown) => unknown)({ MY_VAR: 42 })).toThrow()
  })

  test('dispatchEnv shadows lockedEnv key → typed parse error', () => {
    // Green: parseDispatchEnv({ CODEX_HOME: '/other' }, { CODEX_HOME: '/workspace' }) throws
    expect(() =>
      (parseDispatchEnv as unknown as (x: unknown, y?: unknown) => unknown)(
        { CODEX_HOME: '/other' },
        { CODEX_HOME: '/workspace/.codex-home' }
      )
    ).toThrow()
  })

  test('valid map → DispatchEnv (frozen, cloned, value-equal)', () => {
    // Green: result is frozen, has correct values, is a safe clone (not caller's mutable map)
    const input = { ASP_RUN_ID: 'run_123', MY_HANDLE: 'handle_1' }
    const result = (parseDispatchEnv as unknown as (x: unknown) => Record<string, string>)(input)
    expect(result).toMatchObject({ ASP_RUN_ID: 'run_123', MY_HANDLE: 'handle_1' })
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('undefined input → undefined (absent → absent)', () => {
    // Green: parseDispatchEnv(undefined) === undefined
    const result = (parseDispatchEnv as unknown as (x: unknown) => unknown)(undefined)
    expect(result).toBeUndefined()
  })
})

// ─── Test 4: RUNTIME PRESERVATION red ───────────────────────────────────────
//
// Uses parseDispatchEnv in test setup → SyntaxError (right failure reason).
// Green assertions:
//   - Valid DispatchEnv + lockedEnv compose cleanly via buildProcessEnv (different keys)
//   - buildProcessEnv still rejects cross-channel key collisions (defense-in-depth)

describe('T-04408 red 4 — runtime preservation (setup needs parseDispatchEnv)', () => {
  test('valid broker dispatch with lockedEnv + DispatchEnv spawns cleanly', async () => {
    // SyntaxError at module load → never reaches this line.
    // Green: parseDispatchEnv({ASP_RUN_ID:'run_123'}) → valid DispatchEnv passed to broker.start
    const validDispatchEnv = (
      parseDispatchEnv as unknown as (x: unknown) => Record<string, string>
    )({ ASP_RUN_ID: 'run_123' })
    const broker = createBroker({ drivers: [createNoopDriver()] })
    const result = await broker.start({ spec: specWithLockedEnv() }, validDispatchEnv)
    expect(result.state).toBe('ready')
  })

  test('buildProcessEnv four-channel disjoint union still rejects key collisions', () => {
    // SyntaxError at module load → never reaches this line.
    // Green: valid DispatchEnv({ASP_RUN_ID}) + lockedEnv({CODEX_HOME}) compose without collision;
    // raw cross-channel collision still throws (defense-in-depth guard preserved).
    const validDispatch = (parseDispatchEnv as unknown as (x: unknown) => Record<string, string>)({
      ASP_RUN_ID: 'run_123',
    })
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
      buildProcessEnv({ lockedEnv: { MY_KEY: 'locked' }, dispatchEnv: { MY_KEY: 'dispatch' } })
    ).toThrow()
  })
})

// ─── Test 5: PROJECTION PRESERVATION red ────────────────────────────────────
//
// Uses parseDispatchEnv in test setup → SyntaxError (right failure reason).
// Green assertion: dispatchEnv is passed to broker.start() separately, never
// flows into the spec (not hashed/compiled into InvocationStartRequest.spec).

describe('T-04408 red 5 — projection: dispatchEnv stays outside hashed spec', () => {
  test('dispatchEnv passed separately to broker.start, not inside spec or status', async () => {
    // SyntaxError at module load → never reaches this line.
    // Green: parseDispatchEnv produces a DispatchEnv; spec has no dispatchEnv field;
    // broker.status does not expose dispatchEnv on the status response.
    const dispatchEnv = (parseDispatchEnv as unknown as (x: unknown) => Record<string, string>)({
      ASP_RUN_ID: 'run_abc',
    })
    const spec = noopSpec()

    // dispatchEnv must NEVER appear inside the spec (not part of the hashed envelope)
    expect('dispatchEnv' in spec).toBe(false)
    expect((spec.process as { dispatchEnv?: unknown }).dispatchEnv).toBeUndefined()

    // broker.start takes dispatchEnv as a SEPARATE positional argument, not in req.spec
    const broker = createBroker({ drivers: [createNoopDriver()] })
    const result = await broker.start({ spec }, dispatchEnv)
    expect(result.invocationId).toBeDefined()

    // The broker's status response must not leak dispatchEnv
    const status = await broker.status({ invocationId: result.invocationId })
    expect((status as { dispatchEnv?: unknown }).dispatchEnv).toBeUndefined()
  })
})
