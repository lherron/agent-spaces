/**
 * RED tests for T-07398 Wave 2a: provisioning directive grammar in agent-scope.
 *
 * Design authority: hrc-runtime T-07398 specification (daedalus-APPROVED rev 4),
 * Part 2 "Provisioning directives". Campaign record T-07405.
 *
 * Grammar under test:
 *   input     := handle [directive]...
 *   directive := "+" (key "=" value | bare-token)
 * Ordering `agent@project:task/role~lane+directives`; the block from the first
 * "+" is stripped before handle parsing ("+" is outside the segment charset).
 *
 * PASS CONDITIONS:
 * 1. `agent-scope` publicly exports `DENIED_PROVISION_OVERRIDE_KEYS` (`['yolo','sandbox']`),
 *    the `ProvisioningScalars` type (single definition; spaces-config re-exports it),
 *    `ProvisionVocabulary`, and the typed `ProvisionDirectiveError` carrying `.code`.
 * 2. `resolveQualifiedScopeInput` accepts a directive block and returns
 *    `directives?: Partial<ProvisioningScalars>`; it is absent for undirected input.
 * 3. Directives never enter the canonical ScopeRef: the scopeRef/laneRef/parsed of a
 *    directed handle are identical to the undirected form (spec Part 2 core invariant).
 * 4. `key=value` is canonical. Bare-token sugar resolves ONLY inside the closed
 *    namespaces (registered model aliases, reasoning enum); `node=` is explicit-only.
 * 5. A bare token belonging to two closed namespaces is a hard `AMBIGUOUS_DIRECTIVE`.
 * 6. Deny-list `{yolo, sandbox}` is enforced at the sender: `DENIED_PROVISION_KEY`.
 * 7. Keys outside the top-level `[provisioning]` scalars — including dotted keys, which
 *    the grammar cannot express — are `UNKNOWN_PROVISION_KEY`.
 * 8. Values are validated against the resolved harness vocabulary: `INVALID_PROVISION_VALUE`.
 * 9. Strict `parseScopeHandle` REJECTS directives — canonical handles stay pure.
 */

import { describe, expect, test } from 'bun:test'

import {
  DENIED_PROVISION_OVERRIDE_KEYS,
  ProvisionDirectiveError,
  type ProvisionVocabulary,
  parseScopeHandle,
  resolveQualifiedScopeInput,
} from '../index.js'

/** Resolved harness vocabulary: closed namespaces for bare-token sugar. */
const VOCAB: ProvisionVocabulary = {
  models: ['sonnet', 'opus', 'gpt-5.6-sol'],
  reasoning: ['low', 'medium', 'high'],
}

/** Same, but `high` is ALSO a registered model alias — the ambiguity case. */
const AMBIGUOUS_VOCAB: ProvisionVocabulary = {
  models: ['sonnet', 'high'],
  reasoning: ['low', 'medium', 'high'],
}

/** Resolve a directed handle against the standard vocabulary. */
function resolve(input: string, vocabulary: ProvisionVocabulary = VOCAB) {
  return resolveQualifiedScopeInput(input, { provisionVocabulary: vocabulary })
}

/**
 * Run `fn` and return the typed directive error it threw. Re-throws anything
 * that is not a `ProvisionDirectiveError` so an untyped failure is visible.
 */
function directiveError(fn: () => unknown): ProvisionDirectiveError {
  try {
    fn()
  } catch (err) {
    if (err instanceof ProvisionDirectiveError) return err
    throw err
  }
  throw new Error('expected a ProvisionDirectiveError, but nothing was thrown')
}

describe('provisioning directives: canonical scope identity', () => {
  test('directives never enter the ScopeRef — directed round-trips identical to undirected', () => {
    const directed = resolve('cody@hrc-runtime:T-01234/reviewer~repair+model=sonnet+reasoning=high')
    const undirected = resolve('cody@hrc-runtime:T-01234/reviewer~repair')

    // The whole canonical surface is byte-identical with and without the block.
    expect(directed.scopeRef).toBe(undirected.scopeRef)
    expect(directed.scopeRef).toBe('agent:cody:project:hrc-runtime:task:T-01234:role:reviewer')
    expect(directed.parsed).toEqual(undirected.parsed)
    expect(directed.laneId).toBe('repair')
    expect(directed.laneRef).toBe(undirected.laneRef)

    // Only the out-of-band directive channel differs.
    expect(directed.directives).toEqual({ model: 'sonnet', reasoning: 'high' })
    expect(undirected.directives).toBeUndefined()
  })
})

describe('provisioning directives: grammar', () => {
  test('sugar precedence — bare tokens resolve only in closed namespaces; node= is explicit-only', () => {
    // Registered model alias → the `model` key.
    expect(resolve('cody@hrc-runtime:T-1+sonnet').directives).toEqual({ model: 'sonnet' })
    // Reasoning enum member → the `reasoning` key.
    expect(resolve('cody@hrc-runtime:T-1+low').directives).toEqual({ reasoning: 'low' })
    // `high` is unambiguous under a vocabulary where it is only a reasoning value.
    expect(resolve('cody@hrc-runtime:T-1+high').directives).toEqual({ reasoning: 'high' })

    // key=value is the canonical spelling of the same directives.
    expect(resolve('cody@hrc-runtime:T-1+model=sonnet+reasoning=low').directives).toEqual({
      model: 'sonnet',
      reasoning: 'low',
    })
    // Sugar and canonical form compose in one block.
    expect(resolve('cody@hrc-runtime:T-1+sonnet+reasoning=high').directives).toEqual({
      model: 'sonnet',
      reasoning: 'high',
    })

    // `node` is not a closed namespace: it is reachable ONLY as an explicit key=value.
    expect(resolve('cody@hrc-runtime:T-1+node=svc').directives).toEqual({ node: 'svc' })
  })

  test('a bare token in two closed namespaces is a hard AMBIGUOUS_DIRECTIVE error', () => {
    const err = directiveError(() => resolve('cody@hrc-runtime:T-1+high', AMBIGUOUS_VOCAB))
    expect(err.code).toBe('AMBIGUOUS_DIRECTIVE')
  })

  test('strict parseScopeHandle rejects directives — canonical handles stay pure', () => {
    expect(() => parseScopeHandle('cody@hrc-runtime:T-01234+model=sonnet')).toThrow(/directive/i)
    // The undirected handle still parses exactly as before.
    expect(parseScopeHandle('cody@hrc-runtime:T-01234').scopeRef).toBe(
      'agent:cody:project:hrc-runtime:task:T-01234'
    )
  })
})

describe('provisioning directives: sender-side validation', () => {
  test('deny at sender — yolo/sandbox are DENIED_PROVISION_KEY', () => {
    expect(DENIED_PROVISION_OVERRIDE_KEYS).toEqual(['yolo', 'sandbox'])

    for (const directive of ['yolo=true', 'sandbox=danger-full-access']) {
      const err = directiveError(() => resolve(`cody@hrc-runtime:T-1+${directive}`))
      expect(err.code).toBe('DENIED_PROVISION_KEY')
    }
  })

  test('keys outside the top-level provisioning scalars are UNKNOWN_PROVISION_KEY', () => {
    for (const directive of [
      'banana=3', // not a provisioning scalar at all
      'codex.sandbox_mode=danger-full-access', // nested tables are inexpressible: no dotted keys
      'claude.permission_mode=bypassPermissions',
      'svc', // bare token outside every closed namespace (node= is explicit-only)
    ]) {
      const err = directiveError(() => resolve(`cody@hrc-runtime:T-1+${directive}`))
      expect(err.code).toBe('UNKNOWN_PROVISION_KEY')
    }
  })

  test('values validate against the resolved harness vocabulary — INVALID_PROVISION_VALUE', () => {
    for (const directive of ['reasoning=turbo', 'model=not-a-registered-alias']) {
      const err = directiveError(() => resolve(`cody@hrc-runtime:T-1+${directive}`))
      expect(err.code).toBe('INVALID_PROVISION_VALUE')
    }
  })
})
