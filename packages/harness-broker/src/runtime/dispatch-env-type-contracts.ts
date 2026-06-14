/**
 * T-04408 TYPE-LEVEL RED — test 3: illegal-state-unrepresentable proof
 *
 * The @ts-expect-error directives below are SPURIOUS today because raw
 * Record<string,string> IS assignable to the current dispatchEnv slot types
 * (which are Record<string,string>|undefined, not yet branded DispatchEnv).
 *
 * TypeScript reports "Unused '@ts-expect-error' directive" for each spurious
 * directive → `bun run typecheck` (tsc --noEmit) FAILS. This is the designed
 * typecheck red for T-04408 test 3 (daedalus ruling).
 *
 * GREEN: once DispatchEnv is a branded/opaque type and the slots below change
 * to DispatchEnv|undefined, the raw-map literals are rejected by TypeScript →
 * the ts-expect-error directives become correct → typecheck passes.
 *
 * This file has NO runtime exports or behavior.
 * Remove or transform this file once T-04408 is green.
 */
import type { DriverContext } from '../drivers/driver'
import type { ProcessEnvChannels } from './env'

// ── Proof A: DriverContext.dispatchEnv currently accepts raw Record<string,string> ──
// @ts-expect-error EXCEPTION(T-04408): type-level red — today DriverContext['dispatchEnv'] is
// Record<string,string>|undefined so this literal assignable without error → @ts-expect-error
// is spurious → tsc fails. Becomes correct once dispatchEnv slot is DispatchEnv|undefined.
const _pA: DriverContext['dispatchEnv'] = { TEST_DISPATCH_VAR: 'x' }

// ── Proof B: ProcessEnvChannels.dispatchEnv currently accepts raw Record<string,string> ──
// @ts-expect-error EXCEPTION(T-04408): type-level red — today ProcessEnvChannels['dispatchEnv'] is
// Record<string,string>|undefined so this literal assignable without error → @ts-expect-error
// is spurious → tsc fails. Becomes correct once dispatchEnv slot is DispatchEnv|undefined.
const _pB: ProcessEnvChannels['dispatchEnv'] = { TEST_DISPATCH_VAR: 'x' }

void _pA
void _pB
