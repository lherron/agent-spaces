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

    expect(lifecyclePolicyHash(withUndefined)).toBe(lifecyclePolicyHash(present))
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

  test('the conservative default overlay hashes to its pinned golden digest', () => {
    // hrc-runtime persists policyHash, so any change to canonicalization (key
    // order, value coercion, the digest itself) must show up here, not in stored
    // comparisons. Update the digest only for a deliberate, migrated change.
    expect(lifecyclePolicyHash(conservativeDefaultLifecyclePolicyOverlay('policy_canon'))).toBe(
      '3e3bcd72dd2dfec646b3205f6a02ce5fbb5191e3856d51ed0069881cc6876862'
    )
  })
})
