/**
 * Provisioning directives — the `+`-block of the scope input grammar.
 *
 * Design authority: hrc-runtime T-07398 (daedalus-APPROVED rev 4), Part 2
 * "Provisioning directives". Wave 2a implements the sender-side grammar only.
 *
 *   input     := handle [directive]...
 *   directive := "+" (key "=" value | bare-token)
 *
 * Ordering is `agent@project:task/role~lane+directives`; the block from the
 * FIRST "+" is stripped before handle parsing ("+" is outside the segment token
 * charset, so it can never be part of a handle). Directives are out-of-band:
 * they never enter the canonical ScopeRef.
 *
 * `agent-scope` owns the grammar and therefore owns the single definition of
 * `ProvisioningScalars` and `DENIED_PROVISION_OVERRIDE_KEYS`; spaces-config —
 * which depends on this zero-dependency package — re-exports them rather than
 * restating them.
 */

/**
 * The top-level scalar keys of `[provisioning]` and the value kind each one
 * carries. This table is the SINGLE source of truth: `ProvisioningScalars` is
 * derived from it, the runtime key set used for `UNKNOWN_PROVISION_KEY` is its
 * key list, and value coercion reads its kinds. A future `[provisioning]`
 * scalar becomes directive-overridable by being added here — the spec's
 * deny-list semantics require pass-through out of the box, so this is
 * deliberately not a hand-maintained allow-list beside the type.
 *
 * Nested tables (`provisioning.claude`, `provisioning.codex`) are profile-only
 * and are absent by construction: the grammar has no dotted keys, so a nested
 * spelling can only ever land here as an unknown key.
 */
const PROVISIONING_SCALAR_KINDS = {
  harness: 'string',
  model: 'string',
  reasoning: 'string',
  node: 'string',
  yolo: 'boolean',
  sandbox: 'string',
  approval: 'string',
  remote: 'boolean',
} as const

type ProvisioningScalarKinds = typeof PROVISIONING_SCALAR_KINDS
type ScalarKind = ProvisioningScalarKinds[keyof ProvisioningScalarKinds]

/** The TypeScript value type a scalar of the given kind carries. */
type ScalarValue<K extends ScalarKind> = K extends 'boolean' ? boolean : string

/** The keys of the kinds table whose value kind is `K`. */
type ScalarKeyOfKind<K extends ScalarKind> = {
  [P in keyof ProvisioningScalarKinds]: ProvisioningScalarKinds[P] extends K ? P : never
}[keyof ProvisioningScalarKinds]

/**
 * The structurally overridable, top-level scalar portion of `[provisioning]`.
 * Single definition — spaces-config re-exports this type, and the three homes
 * of the shape (toml base / directive override / intent wire form) all name it.
 */
export type ProvisioningScalars = {
  // `-readonly` strips the modifier the `as const` kinds table would otherwise
  // propagate: these scalars are a mutable settings bag, not a frozen literal.
  -readonly [K in keyof ProvisioningScalarKinds]?:
    | ScalarValue<ProvisioningScalarKinds[K]>
    | undefined
}

/** A top-level `[provisioning]` scalar key. */
export type ProvisioningScalarKey = keyof ProvisioningScalars

/**
 * The runtime key set behind `UNKNOWN_PROVISION_KEY`, derived from the kinds
 * table rather than restated, so it cannot drift from `ProvisioningScalars`.
 */
export const PROVISIONING_SCALAR_KEYS = Object.keys(
  PROVISIONING_SCALAR_KINDS
) as readonly ProvisioningScalarKey[]

/**
 * Keys that may never be overridden per-summon, enforced at the sender (here)
 * and re-validated at the server dispatch boundary (Wave 2b). Deny-list, not
 * allow-list: every other top-level scalar passes through.
 */
export const DENIED_PROVISION_OVERRIDE_KEYS = [
  'yolo',
  'sandbox',
] as const satisfies readonly ProvisioningScalarKey[]

/** Typed failure codes for the sender-side directive grammar (Wave 2a). */
export type ProvisionDirectiveErrorCode =
  | 'AMBIGUOUS_DIRECTIVE'
  | 'UNKNOWN_PROVISION_KEY'
  | 'DENIED_PROVISION_KEY'
  | 'INVALID_PROVISION_VALUE'

/**
 * A directive block that cannot be honoured. Carries a machine-readable `code`
 * so callers can distinguish the failure modes without matching on prose.
 */
export class ProvisionDirectiveError extends Error {
  readonly code: ProvisionDirectiveErrorCode

  constructor(message: string, code: ProvisionDirectiveErrorCode) {
    super(message)
    this.name = 'ProvisionDirectiveError'
    this.code = code
    Error.captureStackTrace?.(this, this.constructor)
  }
}

/**
 * The closed namespaces a bare token may resolve inside, as resolved for the
 * summoned agent's harness. This is the injection seam for sender-side value
 * validation: `agent-scope` is zero-dependency and cannot reach the profile
 * merge layer itself, so the caller that owns the merge supplies the vocabulary.
 *
 * Omitted namespaces close no values: a bare token cannot resolve without one,
 * and `key=value` for that key passes through unvalidated.
 */
export type ProvisionVocabulary = {
  /** Registered model aliases for the resolved harness. */
  models?: readonly string[] | undefined
  /** Legal `reasoning` enum members for the resolved harness. */
  reasoning?: readonly string[] | undefined
}

/** The character that opens the directive block. Outside the token charset. */
export const DIRECTIVE_SEPARATOR = '+'

/**
 * Split a scope input into its handle and its raw directive tokens.
 * `directiveTokens` is `undefined` when the input carries no block at all —
 * distinct from an empty block (`"cody@p:t+"`), which is a grammar error.
 */
export function splitProvisionDirectiveBlock(input: string): {
  handle: string
  directiveTokens: readonly string[] | undefined
} {
  const index = input.indexOf(DIRECTIVE_SEPARATOR)
  if (index === -1) {
    return { handle: input, directiveTokens: undefined }
  }
  return {
    handle: input.slice(0, index),
    directiveTokens: input.slice(index + DIRECTIVE_SEPARATOR.length).split(DIRECTIVE_SEPARATOR),
  }
}

function isScalarKey(key: string): key is ProvisioningScalarKey {
  return (PROVISIONING_SCALAR_KEYS as readonly string[]).includes(key)
}

/**
 * Reject denied and unknown keys. Deny is checked first: a denied key IS a
 * known scalar, and the operator needs to hear that it is refused, not missing.
 */
function assertOverridableKey(key: string, token: string): asserts key is ProvisioningScalarKey {
  if ((DENIED_PROVISION_OVERRIDE_KEYS as readonly string[]).includes(key)) {
    throw new ProvisionDirectiveError(
      `provisioning directive "${token}" is denied: "${key}" can only be set in the agent profile ` +
        `(denied keys: ${DENIED_PROVISION_OVERRIDE_KEYS.join(', ')})`,
      'DENIED_PROVISION_KEY'
    )
  }

  if (isScalarKey(key)) {
    return
  }

  const nested = key.includes('.')
    ? ' — nested harness tables are profile-only and the grammar has no dotted keys'
    : ''
  throw new ProvisionDirectiveError(
    `unknown provisioning key "${key}" in directive "${token}"${nested}; ` +
      `overridable keys: ${PROVISIONING_SCALAR_KEYS.filter((candidate) => !(DENIED_PROVISION_OVERRIDE_KEYS as readonly string[]).includes(candidate)).join(', ')}`,
    'UNKNOWN_PROVISION_KEY'
  )
}

/**
 * Resolve a bare token inside the closed namespaces. A token that belongs to
 * two namespaces is a hard error rather than a precedence puzzle; a token that
 * belongs to none is unknown — `node=` and every other open-valued key are
 * reachable only as explicit `key=value`.
 */
function resolveBareToken(
  token: string,
  vocabulary: ProvisionVocabulary | undefined
): { key: ProvisioningScalarKey; raw: string } {
  const isModel = vocabulary?.models?.includes(token) ?? false
  const isReasoning = vocabulary?.reasoning?.includes(token) ?? false

  if (isModel && isReasoning) {
    throw new ProvisionDirectiveError(
      `ambiguous provisioning directive "${token}": it is both a registered model alias and a ` +
        `reasoning value; spell it as "model=${token}" or "reasoning=${token}"`,
      'AMBIGUOUS_DIRECTIVE'
    )
  }
  if (isModel) {
    return { key: 'model', raw: token }
  }
  if (isReasoning) {
    return { key: 'reasoning', raw: token }
  }

  throw new ProvisionDirectiveError(
    `unknown provisioning directive "${token}": bare tokens resolve only inside the closed namespaces (registered model aliases, reasoning values); every other key must be spelled "key=value" (node= is explicit-only)`,
    'UNKNOWN_PROVISION_KEY'
  )
}

/** Decompose one directive token into the scalar key it sets and its raw value. */
function resolveDirectiveToken(
  token: string,
  vocabulary: ProvisionVocabulary | undefined
): { key: ProvisioningScalarKey; raw: string } {
  if (token.length === 0) {
    throw new ProvisionDirectiveError(
      'empty provisioning directive: expected "+key=value" or a bare token from a closed namespace',
      'UNKNOWN_PROVISION_KEY'
    )
  }

  const equals = token.indexOf('=')
  if (equals === -1) {
    return resolveBareToken(token, vocabulary)
  }

  const key = token.slice(0, equals)
  const raw = token.slice(equals + 1)
  assertOverridableKey(key, token)

  if (raw.length === 0) {
    throw new ProvisionDirectiveError(
      `provisioning directive "${token}" has an empty value`,
      'INVALID_PROVISION_VALUE'
    )
  }

  return { key, raw }
}

/**
 * Validate a value against the resolved harness vocabulary. Only the closed
 * namespaces are checkable here; open-valued keys (`node`, `harness`,
 * `approval`, …) are validated by their own registries downstream (Wave 2b).
 */
function assertValueInVocabulary(
  key: ProvisioningScalarKey,
  raw: string,
  vocabulary: ProvisionVocabulary | undefined
): void {
  const allowed =
    key === 'model' ? vocabulary?.models : key === 'reasoning' ? vocabulary?.reasoning : undefined

  if (allowed !== undefined && !allowed.includes(raw)) {
    throw new ProvisionDirectiveError(
      `invalid value "${raw}" for provisioning key "${key}": expected one of ${allowed.join(', ')}`,
      'INVALID_PROVISION_VALUE'
    )
  }
}

/** Coerce and record one resolved directive against its declared value kind. */
function assignScalar(
  directives: Partial<ProvisioningScalars>,
  key: ProvisioningScalarKey,
  raw: string
): void {
  if (PROVISIONING_SCALAR_KINDS[key] === 'boolean') {
    if (raw !== 'true' && raw !== 'false') {
      throw new ProvisionDirectiveError(
        `invalid value "${raw}" for provisioning key "${key}": expected true or false`,
        'INVALID_PROVISION_VALUE'
      )
    }
    // Safe by construction: the kinds table says this key carries a boolean.
    directives[key as ScalarKeyOfKind<'boolean'>] = raw === 'true'
    return
  }

  directives[key as ScalarKeyOfKind<'string'>] = raw
}

/**
 * Parse the raw tokens of a directive block into provisioning scalars.
 *
 * Every failure is a hard, typed error at the sender — before any session or
 * message row exists. Setting one key twice in a block (whether by sugar,
 * canonical spelling, or both) is refused as `AMBIGUOUS_DIRECTIVE`: the block
 * is unordered intent, so there is no defensible "last wins".
 */
export function parseProvisionDirectives(
  tokens: readonly string[],
  vocabulary?: ProvisionVocabulary
): Partial<ProvisioningScalars> {
  const directives: Partial<ProvisioningScalars> = {}

  for (const token of tokens) {
    const { key, raw } = resolveDirectiveToken(token, vocabulary)

    if (Object.hasOwn(directives, key)) {
      throw new ProvisionDirectiveError(
        `provisioning key "${key}" is set more than once in the directive block`,
        'AMBIGUOUS_DIRECTIVE'
      )
    }

    assertValueInVocabulary(key, raw, vocabulary)
    assignScalar(directives, key, raw)
  }

  return directives
}
