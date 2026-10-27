import { describe, expect, test } from 'bun:test'
import type {
  HarnessInvocationSpec,
  InvocationInput,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import * as contracts from '../src/index'
import type { HashMaterialPolicy } from '../src/index'
import { inputIdFrom, invocationIdFrom } from './ids'

const { createCanonicalHasher, project } = contracts

const defaultPolicy = {
  hashProjection: 'runtime-contract-semantic/v2',
  timestampMode: 'include-semantic',
} satisfies Partial<HashMaterialPolicy>

function hasher(): contracts.CanonicalHasher {
  expect(createCanonicalHasher, 'createCanonicalHasher must be exported').toBeFunction()
  return createCanonicalHasher()
}

describe('canonical JSON hasher', () => {
  test('reordering object keys leaves the projected plan hash unchanged', () => {
    const planHash = (source: unknown) => (project(source, 'plan') as { planHash: string }).planHash

    expect(planHash({ beta: 2, alpha: { zed: true, one: 1 } })).toBe(
      planHash({ alpha: { one: 1, zed: true }, beta: 2 })
    )
  })

  test('an undefined field drops out of the projected hash while a null field changes it', () => {
    const planHash = (source: unknown) => (project(source, 'plan') as { planHash: string }).planHash

    expect(planHash({ a: undefined, b: 1 })).toBe(planHash({ b: 1 }))
    expect(planHash({ a: null, b: 1 })).not.toBe(planHash({ b: 1 }))
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'projecting a non-finite number (%p) is refused',
    (value) => {
      expect(() => project({ value }, 'plan')).toThrow(
        `canonical hash forbids non-finite number: ${String(value)}`
      )
    }
  )

  test('reordering process args changes the neutral spec hash', () => {
    const withArgs = (args: string[]) =>
      contracts.neutralSpecHash(
        brokerSpec({
          process: {
            command: 'codex',
            args,
            cwd: '/workspace',
            harnessTransport: { kind: 'jsonrpc-stdio' },
          },
        })
      )

    expect(withArgs(['app-server', '--listen'])).not.toBe(withArgs(['--listen', 'app-server']))
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
    // An omitted object key drops its whole pair, so the canonical string stays
    // well-formed JSON.
    expect(h.canonicalize({ dropped: 'x', kept: 1 }, { omitPaths: ['/dropped'] })).toBe(
      '{"kept":1}'
    )
  })

  // wrkq T-10129 attachment BUGS.md (ATT-00153) spaces-runtime-contracts A1: omitting an *array element* via
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

  // wrkq T-10129 attachment BUGS.md (ATT-00153) spaces-runtime-contracts A3: a top-level undefined/function/symbol
  // silently hashes the literal 'null' instead of being rejected. Document the
  // intended post-fix throw as .todo so the suite stays green until A3 is fixed.
  test.todo('top-level non-serializable values are rejected, not coerced to null (BUGS A3)', () => {
    const h = hasher()
    expect(() => h.canonicalize(undefined, defaultPolicy)).toThrow()
    expect(() => h.canonicalize(() => {}, defaultPolicy)).toThrow()
    expect(() => h.canonicalize(Symbol('x'), defaultPolicy)).toThrow()
  })

  test('changing a lockedEnv value or key changes the neutral spec hash', () => {
    const withLockedEnv = (lockedEnv: Record<string, string>) =>
      contracts.neutralSpecHash(brokerSpec({ process: { ...brokerSpec().process, lockedEnv } }))
    const base = withLockedEnv({ CODEX_HOME: '/workspace/.codex-home-a' })

    expect(withLockedEnv({ CODEX_HOME: '/workspace/.codex-home-b' })).not.toBe(base)
    expect(withLockedEnv({ OTHER_HOME: '/workspace/.codex-home-a' })).not.toBe(base)
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
          nested: { updated_at: '2026-05-24T06:00:01.000Z', value: 1 },
          process: { lockedEnv: { CODEX_HOME: '/workspace/.codex-home' } },
        },
        'plan'
      )
    ).toEqual({
      hashProjection: 'runtime-contract-semantic/v2',
      planHash: expect.any(String),
      value: {
        nested: { value: 1 },
        process: { lockedEnv: { CODEX_HOME: '/workspace/.codex-home' } },
      },
    })
  })
})

function brokerSpec(overrides: Partial<HarnessInvocationSpec> = {}): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: invocationIdFrom('invocation_a'),
    correlation: { requestId: 'request_a' },
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
      harnessTransport: { kind: 'jsonrpc-stdio' },
    },
    driver: { kind: 'codex-app-server' },
    ...overrides,
  }
}

function brokerStartRequest(
  initialInput: InvocationInput = {
    inputId: inputIdFrom('input_a'),
    kind: 'user',
    content: [{ type: 'text', text: 'first prompt' }],
    responseFormat: { kind: 'text' },
    metadata: { source: 'test' },
  }
): InvocationStartRequest {
  return { spec: brokerSpec(), initialInput }
}

describe('broker start-request neutral hash authority', () => {
  test.each<[string, Partial<HarnessInvocationSpec>]>([
    ['labels', { labels: { lane: 'b' } }],
    ['harness', { harness: { frontend: 'codex', provider: 'openai', driver: 'codex-cli' } }],
    [
      'process',
      {
        process: {
          command: 'codex-next',
          args: ['app-server'],
          cwd: '/workspace',
          harnessTransport: { kind: 'jsonrpc-stdio' },
        },
      },
    ],
    ['driver', { driver: { kind: 'muse-serve' } as HarnessInvocationSpec['driver'] }],
  ])('changing the spec %s changes the neutral spec hash', (_field, change) => {
    expect(contracts.neutralSpecHash(brokerSpec(change))).not.toBe(
      contracts.neutralSpecHash(brokerSpec())
    )
  })

  test('invocationId and correlation changes do not change the neutral spec hash', () => {
    const first = contracts.neutralSpecHash(brokerSpec())
    const second = contracts.neutralSpecHash(
      brokerSpec({
        invocationId: invocationIdFrom('invocation_b'),
        correlation: { requestId: 'request_b', traceId: 'trace_b' },
      })
    )

    expect(second).toBe(first)
  })

  test('the neutral start-request hash ignores spec dispatch identity but follows spec semantics', () => {
    const withSpec = (spec: HarnessInvocationSpec) =>
      contracts.neutralStartRequestHash({ ...brokerStartRequest(), spec })
    const base = withSpec(brokerSpec())

    expect(
      withSpec(
        brokerSpec({
          invocationId: invocationIdFrom('invocation_b'),
          correlation: { requestId: 'request_b' },
        })
      )
    ).toBe(base)
    expect(withSpec(brokerSpec({ labels: { lane: 'b' } }))).not.toBe(base)
  })

  test('inputId and responseFormat each change the neutral start-request hash', () => {
    const base = contracts.neutralStartRequestHash(brokerStartRequest())
    const changedInputId = contracts.neutralStartRequestHash(
      brokerStartRequest({
        inputId: inputIdFrom('input_b'),
        kind: 'user',
        content: [{ type: 'text', text: 'first prompt' }],
        responseFormat: { kind: 'text' },
      })
    )
    const changedResponseFormat = contracts.neutralStartRequestHash(
      brokerStartRequest({
        inputId: inputIdFrom('input_a'),
        kind: 'user',
        content: [{ type: 'text', text: 'first prompt' }],
        responseFormat: {
          kind: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      })
    )

    expect(changedInputId).not.toBe(base)
    expect(changedResponseFormat).not.toBe(base)
  })

  test('content and all other initial-input payload fields are excluded', () => {
    const base = brokerStartRequest()
    // futurePayloadField is deliberately unknown to InvocationInput: it proves
    // payload fields the type does not model are excluded from the hash too.
    const evolvedInput = {
      inputId: inputIdFrom('input_a'),
      kind: 'steer' as const,
      content: [{ type: 'text' as const, text: 'different prompt' }],
      responseFormat: { kind: 'text' as const },
      metadata: { source: 'different' },
      futurePayloadField: { nested: true },
    }
    const evolvedPayload = brokerStartRequest(evolvedInput)

    expect(contracts.neutralStartRequestHash(evolvedPayload)).toBe(
      contracts.neutralStartRequestHash(base)
    )
    expect(contracts.hashNeutralStartRequest(evolvedPayload)).toEqual(
      contracts.hashNeutralStartRequest(base)
    )
  })

  test('raw project semantics remain payload-sensitive', () => {
    const base = brokerStartRequest()
    const changedContent = brokerStartRequest({
      inputId: inputIdFrom('input_a'),
      kind: 'user',
      content: [{ type: 'text', text: 'different prompt' }],
      responseFormat: { kind: 'text' },
      metadata: { source: 'test' },
    })

    expect(
      (contracts.project(changedContent, 'start-request') as { startRequestHash: string })
        .startRequestHash
    ).not.toBe(
      (contracts.project(base, 'start-request') as { startRequestHash: string }).startRequestHash
    )
  })
})
