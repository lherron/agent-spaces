import { describe, expect, test } from 'bun:test'
import {
  type BrokerLifecyclePolicyOverlayInput,
  canonicalLifecyclePolicyJson,
  conservativeDefaultLifecyclePolicyOverlay,
  lifecyclePolicyHash,
} from '../src/lifecycle'

/**
 * Direct coverage for the canonical-JSON serializer behind `lifecyclePolicyHash`
 * / `canonicalLifecyclePolicyJson`. The first-pass suite only exercised the
 * hash on the conservative-default overlay; these assert the determinism and
 * value-coercion contract on adversarial inputs (REFACTOR-BACKLOG A5).
 *
 * `canonicalLifecyclePolicyJson` strips `policyHash` and canonicalizes the rest,
 * so it is the cleanest window onto the private `canonicalizeJson`.
 */
describe('canonical lifecycle policy JSON', () => {
  const base = conservativeDefaultLifecyclePolicyOverlay('policy_canon')

  test('is stable regardless of object key insertion order', () => {
    const ordered = {
      schemaVersion: base.schemaVersion,
      policyId: base.policyId,
      retention: base.retention,
      harnessRecovery: base.harnessRecovery,
      turnRetry: base.turnRetry,
    } satisfies BrokerLifecyclePolicyOverlayInput

    // Same content, keys inserted in a different order.
    const reordered = {
      turnRetry: base.turnRetry,
      harnessRecovery: base.harnessRecovery,
      retention: base.retention,
      policyId: base.policyId,
      schemaVersion: base.schemaVersion,
    } satisfies BrokerLifecyclePolicyOverlayInput

    expect(canonicalLifecyclePolicyJson(reordered)).toBe(canonicalLifecyclePolicyJson(ordered))
    expect(lifecyclePolicyHash(reordered)).toBe(lifecyclePolicyHash(ordered))
  })

  test('the embedded policyHash does not affect the canonical material', () => {
    const withoutHash = {
      schemaVersion: base.schemaVersion,
      policyId: base.policyId,
      retention: base.retention,
      harnessRecovery: base.harnessRecovery,
      turnRetry: base.turnRetry,
    } satisfies BrokerLifecyclePolicyOverlayInput

    // `base` carries a computed policyHash; it must be stripped before hashing.
    expect(canonicalLifecyclePolicyJson(base)).toBe(canonicalLifecyclePolicyJson(withoutHash))
    expect(lifecyclePolicyHash(base)).toBe(lifecyclePolicyHash(withoutHash))
  })

  test('skips object values that are explicitly undefined', () => {
    const present = {
      schemaVersion: base.schemaVersion,
      policyId: base.policyId,
      retention: base.retention,
      harnessRecovery: base.harnessRecovery,
      turnRetry: base.turnRetry,
    } satisfies BrokerLifecyclePolicyOverlayInput

    // An explicit `extra: undefined` object value is skipped, matching the
    // load-bearing `if (child === undefined) continue` in canonicalizeJson, so
    // it produces the same canonical material as omitting the key.
    const withUndefined = {
      ...present,
      extra: undefined,
    } as unknown as BrokerLifecyclePolicyOverlayInput

    expect(canonicalLifecyclePolicyJson(withUndefined)).toBe(canonicalLifecyclePolicyJson(present))
  })

  test('throws RangeError on a non-finite number in the hash material', () => {
    const nonFinite = {
      schemaVersion: base.schemaVersion,
      policyId: base.policyId,
      retention: { mode: 'keep-alive', idleTtlMs: Number.POSITIVE_INFINITY },
      harnessRecovery: base.harnessRecovery,
      turnRetry: base.turnRetry,
    } as unknown as BrokerLifecyclePolicyOverlayInput

    expect(() => canonicalLifecyclePolicyJson(nonFinite)).toThrow(RangeError)
    expect(() => lifecyclePolicyHash(nonFinite)).toThrow(RangeError)
  })

  test('produces a stable hex digest for the conservative default overlay', () => {
    // Determinism guard: the same input always yields the same digest.
    expect(lifecyclePolicyHash(base)).toBe(lifecyclePolicyHash(base))
    expect(lifecyclePolicyHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
