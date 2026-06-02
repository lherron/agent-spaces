import { describe, expect, test } from 'bun:test'
import * as contracts from '../src/index'
import type { HashMaterialPolicy } from '../src/index'

const createCanonicalHasher = (contracts as any).createCanonicalHasher as
  | (() => contracts.CanonicalHasher)
  | undefined
const project = (contracts as any).project as
  | ((
      source: unknown,
      kind: contracts.RuntimeContractProjectionKind
    ) => contracts.RuntimeContractProjection)
  | undefined

const defaultPolicy = {
  hashProjection: 'runtime-contract-semantic/v2',
  timestampMode: 'include-semantic',
} satisfies Partial<HashMaterialPolicy>

function hasher(): contracts.CanonicalHasher {
  expect(createCanonicalHasher, 'createCanonicalHasher must be exported').toBeFunction()
  return createCanonicalHasher()
}

describe('canonical JSON hasher', () => {
  test('hash is stable across object key reordering', () => {
    const h = hasher()

    const first = h.hash({ beta: 2, alpha: { zed: true, one: 1 } }, defaultPolicy)
    const second = h.hash({ alpha: { one: 1, zed: true }, beta: 2 }, defaultPolicy)

    expect(first).toEqual({
      algorithm: 'sha256-canonical-json/v1',
      value: second.value,
    })
  })

  test('undefined fields are omitted but null is preserved', () => {
    const h = hasher()

    expect(h.hash({ a: undefined, b: 1 }, defaultPolicy)).toEqual(h.hash({ b: 1 }, defaultPolicy))
    expect(h.hash({ a: null }, defaultPolicy).value).not.toBe(h.hash({}, defaultPolicy).value)
  })

  test('non-finite numbers are forbidden', () => {
    const h = hasher()

    expect(() => h.canonicalize({ value: Number.NaN }, defaultPolicy)).toThrow()
    expect(() => h.canonicalize({ value: Number.POSITIVE_INFINITY }, defaultPolicy)).toThrow()
    expect(() => h.canonicalize({ value: Number.NEGATIVE_INFINITY }, defaultPolicy)).toThrow()
  })

  test('arrays are preserved in order', () => {
    const h = hasher()

    expect(h.hash(['model', 'driver', 'lockedEnv'], defaultPolicy).value).not.toBe(
      h.hash(['lockedEnv', 'driver', 'model'], defaultPolicy).value
    )
  })

  test('omit-ephemeral timestamp mode ignores timestamp fields', () => {
    const h = hasher()
    const policy = {
      ...defaultPolicy,
      timestampMode: 'omit-ephemeral',
    } satisfies Partial<HashMaterialPolicy>

    const first = {
      model: 'gpt-5.3-codex',
      createdAt: '2026-05-24T06:00:00.000Z',
      nested: { updated_at: '2026-05-24T06:00:01.000Z', value: 1 },
    }
    const second = {
      model: 'gpt-5.3-codex',
      createdAt: '2026-05-24T07:00:00.000Z',
      nested: { updated_at: '2026-05-24T07:00:01.000Z', value: 1 },
    }

    expect(h.hash(first, policy)).toEqual(h.hash(second, policy))
  })

  test('omitPaths exclude exact JSON pointer paths only', () => {
    const h = hasher()
    const policy = {
      ...defaultPolicy,
      omitPaths: ['/requestId', '/nested/ephemeral'],
    } satisfies Partial<HashMaterialPolicy>

    const base = { requestId: 'req-a', nested: { ephemeral: 'a', semantic: 'same' } }
    const changed = { requestId: 'req-b', nested: { ephemeral: 'b', semantic: 'same' } }

    expect(h.hash(base, policy)).toEqual(h.hash(changed, policy))
    expect(h.hash(base, policy).value).not.toBe(
      h.hash({ ...changed, nested: { ephemeral: 'b', semantic: 'different' } }, policy).value
    )
  })

  test('omitPaths omitting an object key keeps the canonical string well-formed', () => {
    const h = hasher()
    // Object-key omits are dropped cleanly (the value pair disappears), so the
    // canonical token stays valid JSON. This is the safe, already-exercised path
    // and a baseline for the array-index gap covered by the .todo cases below.
    const policy = {
      ...defaultPolicy,
      omitPaths: ['/dropped'],
    } satisfies Partial<HashMaterialPolicy>

    expect(h.canonicalize({ dropped: 'x', kept: 1 }, policy)).toBe('{"kept":1}')
  })

  // BUGS.md spaces-runtime-contracts A1: omitting an *array element* via
  // omitPaths makes serialize() return '' for that element, so joining with ','
  // yields a malformed canonical token (e.g. `[1,,3]`) and project() then throws
  // on JSON.parse. These document the intended post-fix contract; they are
  // .todo (not failing) so the suite stays green until A1 is fixed.
  test.todo('omitting an array element produces a well-formed canonical string (BUGS A1)', () => {
    const h = hasher()
    const policy = {
      ...defaultPolicy,
      omitPaths: ['/items/1'],
    } satisfies Partial<HashMaterialPolicy>

    // Once A1 is fixed the omitted element must not leave a dangling comma; the
    // canonical string must remain parseable JSON (the exact shape — dropped vs
    // null-filled — depends on the chosen fix).
    const canonical = h.canonicalize({ items: [1, 2, 3] }, policy)
    expect(() => JSON.parse(canonical)).not.toThrow()
  })

  test.todo('project round-trips when an omitPath targets an array index (BUGS A1)', () => {
    expect(project, 'project must be exported').toBeFunction()
    // project() canonicalizes then JSON.parse()s the result; an array-index omit
    // currently corrupts the canonical string and throws here.
    expect(() => project({ items: [1, 2, 3], specVersion: 'x' }, 'spec')).not.toThrow()
  })

  // BUGS.md spaces-runtime-contracts A3: a top-level undefined/function/symbol
  // silently hashes the literal 'null' instead of being rejected. Document the
  // intended post-fix throw as .todo so the suite stays green until A3 is fixed.
  test.todo('top-level non-serializable values are rejected, not coerced to null (BUGS A3)', () => {
    const h = hasher()
    expect(() => h.canonicalize(undefined, defaultPolicy)).toThrow()
    expect(() => h.canonicalize(() => {}, defaultPolicy)).toThrow()
    expect(() => h.canonicalize(Symbol('x'), defaultPolicy)).toThrow()
  })

  test('lockedEnv keys and values are included in hash material', () => {
    const h = hasher()
    const base = {
      process: {
        command: 'codex',
        args: ['app-server'],
        cwd: '/workspace',
        lockedEnv: {
          CODEX_HOME: '/workspace/.codex-home-a',
        },
      },
    }

    expect(
      h.hash({
        ...base,
        process: {
          ...base.process,
          lockedEnv: { CODEX_HOME: '/workspace/.codex-home-b' },
        },
      }).value
    ).not.toBe(h.hash(base).value)

    expect(
      h.hash({
        ...base,
        process: {
          ...base.process,
          lockedEnv: { OTHER_HOME: '/workspace/.codex-home-a' },
        },
      }).value
    ).not.toBe(h.hash(base).value)
  })

  test('process.pathPrepend is included in hash material', () => {
    const h = hasher()
    const base = {
      process: {
        command: 'codex',
        args: ['app-server'],
        cwd: '/workspace',
        lockedEnv: { CODEX_HOME: '/workspace/.codex-home' },
      },
    }

    // Adding pathPrepend changes the hash.
    expect(
      h.hash({ ...base, process: { ...base.process, pathPrepend: ['/agent/tools/bin'] } }).value
    ).not.toBe(h.hash(base).value)

    // Reordering pathPrepend entries changes the hash (order is semantic).
    expect(
      h.hash({ ...base, process: { ...base.process, pathPrepend: ['/a/bin', '/b/bin'] } }).value
    ).not.toBe(
      h.hash({ ...base, process: { ...base.process, pathPrepend: ['/b/bin', '/a/bin'] } }).value
    )
  })

  test('project carries process.pathPrepend into the spec hash', () => {
    expect(project, 'project must be exported').toBeFunction()
    const source = (pathPrepend: string[]) => ({
      specVersion: 'harness-broker.invocation/v1',
      process: { command: 'codex', args: ['app-server'], cwd: '/workspace', pathPrepend },
    })
    const a = project(source(['/a/bin']), 'spec')
    const b = project(source(['/b/bin']), 'spec')
    expect(a).toHaveProperty('specHash')
    expect((a as { specHash: string }).specHash).not.toBe((b as { specHash: string }).specHash)
    // pathPrepend survives into the projected value (not omitted).
    expect((a.value as { process: { pathPrepend: string[] } }).process.pathPrepend).toEqual([
      '/a/bin',
    ])
  })

  test('lockedEnv cannot be omitted by hash policy', () => {
    const h = hasher()

    expect(() =>
      h.hash(
        { process: { lockedEnv: { CODEX_HOME: '/workspace/.codex-home' } } },
        { omitPaths: ['/process/lockedEnv'] }
      )
    ).toThrow('Hash omitPaths must not omit process.lockedEnv')

    expect(() =>
      h.hash(
        { spec: { process: { lockedEnv: { CODEX_HOME: '/workspace/.codex-home' } } } },
        { omitPaths: ['/spec/process/lockedEnv'] }
      )
    ).toThrow('Hash omitPaths must not omit process.lockedEnv')
  })
})

describe('canonical projection helper', () => {
  test('projects to the named runtime contract hash projection', () => {
    expect(project, 'project must be exported').toBeFunction()

    expect(
      project(
        {
          planHash: 'plan_a',
          createdAt: '2026-05-24T06:00:00.000Z',
          process: { lockedEnv: { CODEX_HOME: '/workspace/.codex-home' } },
        },
        'plan'
      )
    ).toEqual({
      hashProjection: 'runtime-contract-semantic/v2',
      planHash: expect.any(String),
      value: {
        process: { lockedEnv: { CODEX_HOME: '/workspace/.codex-home' } },
      },
    })
  })
})
