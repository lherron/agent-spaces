export type ArrisHostLifecycleOwner = 'external' | 'hrc-managed'

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
  readiness: {
    state: string
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

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ArrisFederationValidationIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: `${path}.${key}`, message: 'unknown field' })
  }
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

/** Strict parser for the published `arris.host-descriptor/1` fixture. */
export function validateArrisHostDescriptor(
  value: unknown
): ArrisFederationValidationResult<ArrisHostDescriptor> {
  const issues: ArrisFederationValidationIssue[] = []
  if (!record(value)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] }
  validateKeys(
    value,
    [
      'schema',
      'host_incarnation',
      'readiness',
      'lifecycle',
      'control',
      'events',
      'helpers',
      'resident_binding',
    ],
    '$',
    issues
  )
  if (value['schema'] !== 'arris.host-descriptor/1') {
    issues.push({
      path: '$.schema',
      message: 'must equal arris.host-descriptor/1',
    })
  }

  const incarnation = objectAt(value, 'host_incarnation', '$', issues)
  if (incarnation !== undefined) {
    validateKeys(incarnation, ['host_incarnation_id', 'process'], '$.host_incarnation', issues)
    stringAt(incarnation, 'host_incarnation_id', '$.host_incarnation', issues)
    const process = objectAt(incarnation, 'process', '$.host_incarnation', issues)
    if (process !== undefined) {
      validateKeys(
        process,
        ['pid', 'executable', 'os_started_at', 'observed_at_ms'],
        '$.host_incarnation.process',
        issues
      )
      integerAt(process, 'pid', '$.host_incarnation.process', issues, 1)
      stringAt(process, 'executable', '$.host_incarnation.process', issues)
      stringAt(process, 'os_started_at', '$.host_incarnation.process', issues)
      finiteAt(process, 'observed_at_ms', '$.host_incarnation.process', issues)
    }
  }

  const readiness = objectAt(value, 'readiness', '$', issues)
  if (readiness !== undefined) {
    validateKeys(readiness, ['state', 'since_ms', 'accepts_input'], '$.readiness', issues)
    stringAt(readiness, 'state', '$.readiness', issues)
    finiteAt(readiness, 'since_ms', '$.readiness', issues)
    booleanAt(readiness, 'accepts_input', '$.readiness', issues)
  }

  const lifecycle = objectAt(value, 'lifecycle', '$', issues)
  if (lifecycle !== undefined) {
    validateKeys(
      lifecycle,
      ['host_lifecycle_owner', 'launch_id', 'accepts_managed_stop'],
      '$.lifecycle',
      issues
    )
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
    validateKeys(
      control,
      ['socket_path', 'admission_classes', 'unsupported_classes'],
      '$.control',
      issues
    )
    if (control['socket_path'] !== null && typeof control['socket_path'] !== 'string') {
      issues.push({
        path: '$.control.socket_path',
        message: 'must be a string or null',
      })
    }
    stringArrayAt(control, 'admission_classes', '$.control', issues)
    stringArrayAt(control, 'unsupported_classes', '$.control', issues)
  }

  const events = objectAt(value, 'events', '$', issues)
  if (events !== undefined) {
    validateKeys(
      events,
      [
        'format',
        'path',
        'host_incarnation_id',
        'first_sequence',
        'last_sequence_at_publish',
        'tail_is_authoritative_in',
        'dropped_records',
        'cursor_field',
      ],
      '$.events',
      issues
    )
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
      validateKeys(helper, ['kind', 'id', 'first_seen_ms'], path, issues)
      stringAt(helper, 'kind', path, issues)
      stringAt(helper, 'id', path, issues)
      finiteAt(helper, 'first_seen_ms', path, issues)
    }
  }

  const binding = objectAt(value, 'resident_binding', '$', issues)
  if (binding !== undefined) {
    validateKeys(
      binding,
      ['visibility', 'thread_id', 'rollout_path', 'model_id', 'rebind_count', 'bound_at_ms'],
      '$.resident_binding',
      issues
    )
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
