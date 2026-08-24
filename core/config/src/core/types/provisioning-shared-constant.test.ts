/**
 * RED test for T-07398 Wave 2a, scope bullet 1:
 *   "ProvisioningScalars type (single definition) + DENIED_PROVISION_OVERRIDE_KEYS =
 *    ['yolo','sandbox'] shared constant."
 *
 * The agent-scope suite pins that agent-scope OWNS the deny-list. This test pins the
 * other half of the bullet — that spaces-config SHARES that one definition instead of
 * restating it. Reference identity (`toBe`) is what discriminates the two: a
 * re-export yields the same array object, while a second `['yolo','sandbox']` literal
 * declared in spaces-config is a distinct object that only `toEqual` would accept.
 * Structurally-duplicated constants are invisible to typecheck, so this runtime
 * identity assertion is the only guard against the two-definition drift the bullet
 * exists to forbid.
 *
 * Dependency direction forces the ownership: core/config depends on agent-scope
 * (core/config/package.json:69) and agent-scope is zero-dep, so the single
 * definition lives upstream in agent-scope and spaces-config re-exports it.
 *
 * PASS CONDITIONS:
 * 1. agent-scope's entrypoint exports DENIED_PROVISION_OVERRIDE_KEYS.
 * 2. The spaces-config public entrypoint (src/index.ts — package exports["."].bun)
 *    exports the SAME object, not an equal copy.
 * 3. The shared value is exactly ['yolo','sandbox'].
 */

import { describe, expect, test } from 'bun:test'
import { DENIED_PROVISION_OVERRIDE_KEYS as AGENT_SCOPE_DENIED } from 'agent-scope'

import { DENIED_PROVISION_OVERRIDE_KEYS as SPACES_CONFIG_DENIED } from '../../index.js'

describe('provisioning deny-list: one shared definition across packages', () => {
  test('spaces-config re-exports agent-scope deny-list rather than restating it', () => {
    // Reference identity: a copied literal in spaces-config fails here, an
    // re-export of the upstream definition passes.
    expect(SPACES_CONFIG_DENIED).toBe(AGENT_SCOPE_DENIED)
    // The shared constant is pinned on the consumer side too.
    expect(SPACES_CONFIG_DENIED).toEqual(['yolo', 'sandbox'])
  })
})
