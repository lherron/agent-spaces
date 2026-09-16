export type ArrisHostLifecycleOwner = 'external' | 'hrc-managed'

/**
 * Readiness states this consumer recognizes by name.
 *
 * The producer's enum is internally tagged (`#[serde(tag = "state")]`), so a
 * state carrying data publishes that data as SIBLING keys of `state` inside the
 * `readiness` block -- `awaiting_approval` adds `class`, `failed` adds `code`
 * and `message`. That is why `readiness` tolerates unknown keys: refusing them
 * would refuse a host for entering a state it is entitled to enter.
 *
 * The union is documentation and autocompletion, not a closed set: the runtime
 * check is "a non-empty string", so a state added by a future producer is read,
 * not refused.
 */
export type ArrisKnownReadinessState =
  | 'starting'
  | 'priming'
  | 'ready'
  | 'rebinding'
  | 'draining'
  | 'awaiting_approval'
  | 'stopped'
  | 'failed'

/** Who answers a native Codex approval right now (`arris.host-descriptor/1`). */
export type ArrisApprovalResponder = 'arris_host' | 'attached_client'

/** A native approval deferred to an attached client, and therefore unanswered. */
export type ArrisPendingApproval = {
  class: string
  codex_turn_id: string
  offered_at_ms: number
}

/**
 * The ledger identity this host answers mail as.
 *
 * Top-level rather than inside `host_incarnation` because a name on a ledger
 * outlives every process. `null` when the host was started without
 * `--participant-principal`/`--participant-scope`, in which case
 * `control.mail_reply` is false and `arris.mail.reply` is not published at all.
 */
export type ArrisParticipantIdentity = {
  principal_ref: string
  scope_ref: string
}

export type ArrisHostDescriptor = {
  schema: 'arris.host-descriptor/1'
  host_incarnation: {
    host_incarnation_id: string
    process: {
      pid: number
      executable: string
      os_started_at: string
      observed_at_ms: number
    }
  }
  /** Added by arris T-08521; absent on hosts published before it. */
  identity?: { participant: ArrisParticipantIdentity | null }
  readiness: {
    state: ArrisKnownReadinessState | (string & {})
    since_ms: number
    accepts_input: boolean
  }
  lifecycle: {
    host_lifecycle_owner: ArrisHostLifecycleOwner
    launch_id: string | null
    accepts_managed_stop: boolean
  }
  control: {
    socket_path: string | null
    admission_classes: string[]
    unsupported_classes: string[]
    /** Added by arris T-08520; absent on hosts published before it. */
    approval_responder?: ArrisApprovalResponder
    /** Added by arris T-08520; absent on hosts published before it. */
    pending_approvals?: ArrisPendingApproval[]
    /** Added by arris T-08521; absent on hosts published before it. */
    mail_reply?: boolean
  }
  events: {
    format: 'application/x-ndjson'
    path: string
    host_incarnation_id: string
    first_sequence: number
    last_sequence_at_publish: number
    tail_is_authoritative_in: 'the journal file itself'
    dropped_records: number
    cursor_field: 'sequence'
  }
  helpers: Array<{ kind: string; id: string; first_seen_ms: number }>
  resident_binding: {
    visibility: 'host-private'
    thread_id: string
    rollout_path: string
    model_id: string
    rebind_count: number
    bound_at_ms: number
  }
}

export type ArrisInputIdentity = {
  platform: string
  input_id: string
  envelope_id: string
  attempt: number
}

export type ArrisControlOutcome =
  | { outcome: 'in_flight' }
  | {
      outcome: 'written'
      neutral_turn_id: string
      codex_turn_id: string | null
    }
  | {
      outcome: 'not_written'
      code: string
      message: string
      eligible_for_retry: boolean
      requeue_as_input_permitted: boolean
    }
  | { outcome: 'indeterminate'; code: string; message: string }

export type ArrisControlReceipt = {
  receipt_id: string
  host_incarnation_id: string
  identity: ArrisInputIdentity
  kind: 'queue' | 'steer'
  target_neutral_turn_id: string | null
  recorded_at_ms: number
  neutral_turn_id: string | null
  outcome: ArrisControlOutcome
  outcome_at_ms: number
  presentation: { codex_turn_id: string; at_ms: number } | null
  completion: { status: string; at_ms: number } | null
  attempts_seen: number[]
  resolution_note: string | null
  prior_dispositions: Array<{
    attempt: number
    outcome: ArrisControlOutcome
    at_ms: number
  }>
}

export type ArrisJournalRecord = {
  host_incarnation_id: string
  sequence: number
  at_ms: number
  kind: string
  detail: Record<string, unknown>
}

export type ArrisFederationValidationIssue = { path: string; message: string }
export type ArrisFederationValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ArrisFederationValidationIssue[] }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a key is present at all, as opposed to present and wrong.
 *
 * Every `control`/`identity` field added after the first published host is
 * checked through this: absent means "a host from before that field existed",
 * which is admitted; present means the declared type is enforced.
 */
function present(parent: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(parent, key)
}

function objectAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ArrisFederationValidationIssue[]
): Record<string, unknown> | undefined {
  const value = parent[key]
  if (!record(value)) {
    issues.push({ path: `${path}.${key}`, message: 'must be an object' })
    return undefined
  }
  return value
}

function stringAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ArrisFederationValidationIssue[]
): void {
  if (typeof parent[key] !== 'string' || parent[key].length === 0) {
    issues.push({
      path: `${path}.${key}`,
      message: 'must be a non-empty string',
    })
  }
}

function finiteAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ArrisFederationValidationIssue[]
): void {
  if (typeof parent[key] !== 'number' || !Number.isFinite(parent[key])) {
    issues.push({ path: `${path}.${key}`, message: 'must be a finite number' })
  }
}

function integerAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ArrisFederationValidationIssue[],
  minimum = 0
): void {
  if (!Number.isInteger(parent[key]) || (parent[key] as number) < minimum) {
    issues.push({
      path: `${path}.${key}`,
      message: `must be an integer >= ${minimum}`,
    })
  }
}

function booleanAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ArrisFederationValidationIssue[]
): void {
  if (typeof parent[key] !== 'boolean') {
    issues.push({ path: `${path}.${key}`, message: 'must be a boolean' })
  }
}

function stringArrayAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  issues: ArrisFederationValidationIssue[]
): void {
  const value = parent[key]
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    issues.push({
      path: `${path}.${key}`,
      message: 'must be an array of strings',
    })
  }
}

/**
 * Additive parser for the published `arris.host-descriptor/1` document.
 *
 * ADDITIVE, not exact-key. Every block validates the keys this consumer reads
 * and ignores the ones it does not, so a field the producer adds under an
 * unchanged schema string cannot refuse a host.
 *
 * That is not a style preference; it is the defect this function was rewritten
 * to stop. The previous version refused every unknown key. arris T-08520 added
 * `control.approval_responder` and `control.pending_approvals`, and T-08521
 * added `control.mail_reply` and the top-level `identity` block -- all under
 * the same `arris.host-descriptor/1` -- and every current host stopped being
 * joinable, each new key on its own enough to refuse (T-08505 bisect).
 *
 * Nothing is loosened about the fields this consumer depends on: a required
 * field that is absent or mistyped still fails by path, and a misspelled known
 * key fails as the absence of the key it misspells. Only genuinely extra keys
 * are ignored. The `readiness` block in particular MUST tolerate them: the
 * producer's readiness enum is internally tagged, so `awaiting_approval`
 * publishes a sibling `class` key and `failed` publishes `code`/`message`.
 *
 * This loosening is scoped to the descriptor, which is a document the PRODUCER
 * authors. The wire messages this consumer itself constructs -- the invocation
 * start request it composes, the control requests it writes -- are validated
 * elsewhere and are untouched here; an unrecognized key in one of those is the
 * author's mistake, not a producer's new capability. Measured while making this
 * change, and recorded so nobody relies on the opposite: `validateInvocationStartRequest`
 * is not exact-key either today -- it accepts an unknown key at the top level
 * and at `spec.driver`. That is a separate gap, not something this rewrite
 * created or closed.
 */
export function validateArrisHostDescriptor(
  value: unknown
): ArrisFederationValidationResult<ArrisHostDescriptor> {
  const issues: ArrisFederationValidationIssue[] = []
  if (!record(value)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] }
  if (value['schema'] !== 'arris.host-descriptor/1') {
    issues.push({
      path: '$.schema',
      message: 'must equal arris.host-descriptor/1',
    })
  }

  const incarnation = objectAt(value, 'host_incarnation', '$', issues)
  if (incarnation !== undefined) {
    stringAt(incarnation, 'host_incarnation_id', '$.host_incarnation', issues)
    const process = objectAt(incarnation, 'process', '$.host_incarnation', issues)
    if (process !== undefined) {
      integerAt(process, 'pid', '$.host_incarnation.process', issues, 1)
      stringAt(process, 'executable', '$.host_incarnation.process', issues)
      stringAt(process, 'os_started_at', '$.host_incarnation.process', issues)
      finiteAt(process, 'observed_at_ms', '$.host_incarnation.process', issues)
    }
  }

  // arris T-08521. Absent on every host published before it, so the block is
  // optional; present, it must say who the host is or say plainly that it is
  // nobody. `null` is the identity-less host -- the one whose `mail_reply` is
  // false and whose `arris.mail.reply` capability is not published at all.
  if (present(value, 'identity')) {
    const identity = objectAt(value, 'identity', '$', issues)
    if (identity !== undefined) {
      const participant = identity['participant']
      if (participant === null) {
        // Identity-less host, stated rather than implied. Nothing to check.
      } else if (!record(participant)) {
        issues.push({
          path: '$.identity.participant',
          message: 'must be an object or null',
        })
      } else {
        stringAt(participant, 'principal_ref', '$.identity.participant', issues)
        stringAt(participant, 'scope_ref', '$.identity.participant', issues)
      }
    }
  }

  const readiness = objectAt(value, 'readiness', '$', issues)
  if (readiness !== undefined) {
    stringAt(readiness, 'state', '$.readiness', issues)
    finiteAt(readiness, 'since_ms', '$.readiness', issues)
    booleanAt(readiness, 'accepts_input', '$.readiness', issues)
  }

  const lifecycle = objectAt(value, 'lifecycle', '$', issues)
  if (lifecycle !== undefined) {
    if (
      lifecycle['host_lifecycle_owner'] !== 'external' &&
      lifecycle['host_lifecycle_owner'] !== 'hrc-managed'
    ) {
      issues.push({
        path: '$.lifecycle.host_lifecycle_owner',
        message: 'must be external or hrc-managed',
      })
    }
    if (lifecycle['launch_id'] !== null && typeof lifecycle['launch_id'] !== 'string') {
      issues.push({
        path: '$.lifecycle.launch_id',
        message: 'must be a string or null',
      })
    }
    booleanAt(lifecycle, 'accepts_managed_stop', '$.lifecycle', issues)
  }

  const control = objectAt(value, 'control', '$', issues)
  if (control !== undefined) {
    if (control['socket_path'] !== null && typeof control['socket_path'] !== 'string') {
      issues.push({
        path: '$.control.socket_path',
        message: 'must be a string or null',
      })
    }
    stringArrayAt(control, 'admission_classes', '$.control', issues)
    stringArrayAt(control, 'unsupported_classes', '$.control', issues)
    // arris T-08520: who answers a native Codex approval right now.
    if (
      present(control, 'approval_responder') &&
      control['approval_responder'] !== 'arris_host' &&
      control['approval_responder'] !== 'attached_client'
    ) {
      issues.push({
        path: '$.control.approval_responder',
        message: 'must be arris_host or attached_client',
      })
    }
    // arris T-08520: the approvals deferred to an attached client. Empty is the
    // ordinary case; a non-empty list is why `readiness.state` is not `ready`.
    if (present(control, 'pending_approvals')) {
      const pending = control['pending_approvals']
      if (!Array.isArray(pending)) {
        issues.push({
          path: '$.control.pending_approvals',
          message: 'must be an array',
        })
      } else {
        for (const [index, entry] of pending.entries()) {
          const path = `$.control.pending_approvals[${index}]`
          if (!record(entry)) {
            issues.push({ path, message: 'must be an object' })
            continue
          }
          stringAt(entry, 'class', path, issues)
          stringAt(entry, 'codex_turn_id', path, issues)
          finiteAt(entry, 'offered_at_ms', path, issues)
        }
      }
    }
    // arris T-08521: whether `arris.mail.reply` is published to the resident.
    if (present(control, 'mail_reply')) booleanAt(control, 'mail_reply', '$.control', issues)
  }

  const events = objectAt(value, 'events', '$', issues)
  if (events !== undefined) {
    if (events['format'] !== 'application/x-ndjson') {
      issues.push({
        path: '$.events.format',
        message: 'must equal application/x-ndjson',
      })
    }
    stringAt(events, 'path', '$.events', issues)
    stringAt(events, 'host_incarnation_id', '$.events', issues)
    integerAt(events, 'first_sequence', '$.events', issues, 1)
    integerAt(events, 'last_sequence_at_publish', '$.events', issues)
    if (events['tail_is_authoritative_in'] !== 'the journal file itself') {
      issues.push({
        path: '$.events.tail_is_authoritative_in',
        message: 'must name the journal file as authoritative',
      })
    }
    integerAt(events, 'dropped_records', '$.events', issues)
    if (events['cursor_field'] !== 'sequence') {
      issues.push({
        path: '$.events.cursor_field',
        message: 'must equal sequence',
      })
    }
  }

  const helpers = value['helpers']
  if (!Array.isArray(helpers)) {
    issues.push({ path: '$.helpers', message: 'must be an array' })
  } else {
    for (const [index, helper] of helpers.entries()) {
      const path = `$.helpers[${index}]`
      if (!record(helper)) {
        issues.push({ path, message: 'must be an object' })
        continue
      }
      stringAt(helper, 'kind', path, issues)
      stringAt(helper, 'id', path, issues)
      finiteAt(helper, 'first_seen_ms', path, issues)
    }
  }

  const binding = objectAt(value, 'resident_binding', '$', issues)
  if (binding !== undefined) {
    if (binding['visibility'] !== 'host-private') {
      issues.push({
        path: '$.resident_binding.visibility',
        message: 'must equal host-private',
      })
    }
    stringAt(binding, 'thread_id', '$.resident_binding', issues)
    stringAt(binding, 'rollout_path', '$.resident_binding', issues)
    stringAt(binding, 'model_id', '$.resident_binding', issues)
    integerAt(binding, 'rebind_count', '$.resident_binding', issues)
    finiteAt(binding, 'bound_at_ms', '$.resident_binding', issues)
  }

  if (
    incarnation !== undefined &&
    events !== undefined &&
    incarnation['host_incarnation_id'] !== events['host_incarnation_id']
  ) {
    issues.push({
      path: '$.events.host_incarnation_id',
      message: 'must match host_incarnation.host_incarnation_id',
    })
  }
  if (
    control !== undefined &&
    Array.isArray(control['admission_classes']) &&
    (!control['admission_classes'].includes('queue') ||
      !control['admission_classes'].includes('steer'))
  ) {
    issues.push({
      path: '$.control.admission_classes',
      message: 'must include queue and steer',
    })
  }
  if (
    control !== undefined &&
    Array.isArray(control['unsupported_classes']) &&
    (!control['unsupported_classes'].includes('interrupt') ||
      !control['unsupported_classes'].includes('preempt'))
  ) {
    issues.push({
      path: '$.control.unsupported_classes',
      message: 'must explicitly include interrupt and preempt',
    })
  }

  return issues.length === 0
    ? { ok: true, value: value as ArrisHostDescriptor }
    : { ok: false, issues }
}
