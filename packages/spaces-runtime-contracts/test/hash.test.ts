import { describe, expect, test } from 'bun:test'
import * as contracts from '../src/index'
import type { HashMaterialPolicy, SecretRef } from '../src/index'

const createCanonicalHasher = (contracts as any).createCanonicalHasher as
  | (() => contracts.CanonicalHasher)
  | undefined
const secretDigest = (contracts as any).secretDigest as
  | ((secret: string, options?: { scope?: string }) => contracts.SecretDigest)
  | undefined

const defaultPolicy = {
  secretMode: 'digest',
  timestampMode: 'include-semantic',
} satisfies Partial<HashMaterialPolicy>

function hasher(): contracts.CanonicalHasher {
  expect(createCanonicalHasher, 'createCanonicalHasher must be exported').toBeFunction()
  return createCanonicalHasher()
}

function digest(secret: string, scope = 'test-scope'): contracts.SecretDigest {
  expect(secretDigest, 'secretDigest must be exported').toBeFunction()
  return secretDigest(secret, { scope })
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

    expect(h.hash({ a: undefined, b: 1 }, defaultPolicy)).toEqual(
      h.hash({ b: 1 }, defaultPolicy),
    )
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

    expect(h.hash(['model', 'driver', 'env'], defaultPolicy).value).not.toBe(
      h.hash(['env', 'driver', 'model'], defaultPolicy).value,
    )
  })

  test('secret values never appear in canonical preimage and are represented by digest', () => {
    const h = hasher()
    const rawSecret = 'sk-live-super-secret-value'
    const secretRef: SecretRef = {
      key: 'OPENAI_API_KEY',
      classification: 'secret',
      digest: digest(rawSecret, 'compiler-a'),
    }

    const canonical = h.canonicalize(
      {
        env: {
          OPENAI_API_KEY: secretRef,
        },
      },
      defaultPolicy,
    )

    expect(canonical).not.toContain(rawSecret)
    expect(canonical).toContain(secretRef.digest.value)
    expect(canonical).toContain('OPENAI_API_KEY')
  })

  test('secret digest scope changes digest value', () => {
    const secret = 'same raw secret'

    expect(digest(secret, 'compiler-a')).toMatchObject({
      algorithm: 'compiler-scoped-secret-digest/v1',
      scope: 'compiler-a',
    })
    expect(digest(secret, 'compiler-a').value).not.toBe(digest(secret, 'compiler-b').value)
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

  test('compatibility policy omits excluded request fields but keeps runtime-affecting fields', () => {
    const h = hasher()
    const policy = {
      ...defaultPolicy,
      timestampMode: 'omit-ephemeral',
      omitFields: [
        'requestId',
        'operationId',
        'runId',
        'invocationId',
        'correlationId',
        'initialPrompt',
        'initialInput',
      ],
    } satisfies Partial<HashMaterialPolicy>

    const base = {
      requestId: 'req-a',
      operationId: 'op-a',
      runId: 'run-a',
      invocationId: 'inv-a',
      correlationId: 'corr-a',
      createdAt: '2026-05-24T06:00:00.000Z',
      initialPrompt: 'do the first thing',
      model: 'gpt-5.3-codex',
      reasoning: 'medium',
      command: 'codex',
      args: ['app-server'],
      cwd: '/Users/lherron/praesidium/agent-spaces',
      env: {
        OPENAI_API_KEY: {
          key: 'OPENAI_API_KEY',
          classification: 'secret',
          digest: digest('secret-a', 'compiler-a'),
        },
      },
      driverConfig: { transport: 'stdio', timeoutMs: 120_000 },
      permissions: { filesystem: 'workspace-write' },
    }

    expect(
      h.hash(
        {
          ...base,
          requestId: 'req-b',
          operationId: 'op-b',
          runId: 'run-b',
          invocationId: 'inv-b',
          correlationId: 'corr-b',
          createdAt: '2026-05-24T07:00:00.000Z',
          initialPrompt: 'do a different thing',
        },
        policy,
      ),
    ).toEqual(h.hash(base, policy))

    expect(h.hash({ ...base, model: 'gpt-5.4' }, policy).value).not.toBe(
      h.hash(base, policy).value,
    )
    expect(
      h.hash(
        {
          ...base,
          env: {
            OPENAI_API_KEY: {
              key: 'OPENAI_API_KEY',
              classification: 'secret',
              digest: digest('secret-b', 'compiler-a'),
            },
          },
        },
        policy,
      ).value,
    ).not.toBe(h.hash(base, policy).value)
  })
})
