import type { ValidationIssue } from 'spaces-harness-broker-protocol'

/** Canonical schema discriminants for the compiled-agent inspection contracts. */
export const AGENT_INSPECTION_SCHEMA_VERSION = 'agent-inspection/v1' as const
export const AGENT_INSPECTION_REQUEST_SCHEMA_VERSION = 'agent-inspection-request/v1' as const
export const AGENT_INSPECTION_EVALUATION_CONTEXT_SCHEMA_VERSION =
  'agent-inspection-evaluation-context/v1' as const

/** JSON-compatible data carried by viewer parts and declared overrides. */
export type AgentInspectionJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentInspectionJsonValue[]
  | { [key: string]: AgentInspectionJsonValue }

/**
 * Producer-owned semantic identity of a viewer part.
 *
 * The exact field name is `partId`; its v1 shape is a colon-delimited semantic
 * namespace, `<part-kind>:<semantic-key>[:<semantic-key>...]` (for example
 * `prompt:prompt:soul` or `runtime-setting:permissions`). It is stable across
 * recompiles while the declared part retains the same meaning. It MUST NOT be a
 * content hash, plan hash, lock hash, bundle identity, or compile id.
 */
export type AgentInspectionPartId = string

export type AgentInspectionIdentity = {
  agentId: string
  agentName?: string | undefined
  projectId: string
  mode: string
  scope: string
  taskId?: string | undefined
  lane: string
  harness: string
  frontend: string
  interaction: string
}

export type AgentInspectionContribution =
  | { kind: 'agent'; sourceId: string; sourceRef: string }
  | { kind: 'project'; sourceId: string; sourceRef: string }
  | { kind: 'space'; sourceId: string; sourceRef: string }
  | { kind: 'template'; sourceId: string; sourceRef: string }
  | { kind: 'override'; sourceId: string; sourceRef: string }
  | { kind: 'runtime-plan'; sourceId: string; sourceRef: string }
  | { kind: 'compiler'; sourceId: string; sourceRef: string }

export type AgentInspectionProvenance = {
  contributions: AgentInspectionContribution[]
}

export type AgentInspectionFailureSource =
  | { kind: 'file'; ref: string }
  | { kind: 'inline'; name: string }
  | { kind: 'exec'; command: string }
  | { kind: 'slot'; source: string }
  | { kind: 'service-probe'; services: string[] }
  | { kind: 'compiler'; stage: string }

/**
 * Closed v1 disposition vocabulary.
 *
 * `effective`, `overridden`, `deduplicated`, `skipped`, and `failed` match the
 * consumer vocabulary. `skipped` is closed to predicate and empty reasons;
 * `failed` retains its declared source and reason. Override and dedup arms are
 * emitted only where the compiler has real candidate-chain/root-dedup semantics.
 * V1 deliberately declines hollow `shadowed`, `suppressed`, or generic
 * `inactive` states where no producer model exists.
 */
export type AgentInspectionDisposition =
  | { kind: 'effective' }
  | { kind: 'overridden'; byPartId: AgentInspectionPartId }
  | { kind: 'deduplicated'; canonicalPartId: AgentInspectionPartId }
  | { kind: 'skipped'; reason: 'predicate' | 'empty' }
  | { kind: 'failed'; source: AgentInspectionFailureSource; reason: string }

type AgentInspectionPartBase = {
  partId: AgentInspectionPartId
  disposition: AgentInspectionDisposition
  provenance: AgentInspectionProvenance
}

export type AgentInspectionPromptPart = AgentInspectionPartBase & {
  kind: 'prompt'
  value: {
    zone: 'prompt' | 'reminder'
    name: string
    sourceType: 'file' | 'inline' | 'exec' | 'slot' | 'service-probe'
    order: number
    content?: string | undefined
  }
}

export type AgentInspectionCapabilityPart = AgentInspectionPartBase & {
  kind: 'capability'
  value: { capabilityId: string; enabled: boolean; configuration?: AgentInspectionJsonValue }
}

export type AgentInspectionRuntimeSettingPart = AgentInspectionPartBase & {
  kind: 'runtime-setting'
  value: { settingId: string; value: AgentInspectionJsonValue }
}

export type AgentInspectionHarnessPart = AgentInspectionPartBase & {
  kind: 'harness'
  value: { family: string; runtime: string; provider: string }
}

export type AgentInspectionModelPart = AgentInspectionPartBase & {
  kind: 'model'
  value: { provider: string; modelId: string; reasoningEffort?: string | undefined }
}

export type AgentInspectionExecutionProfilePart = AgentInspectionPartBase & {
  kind: 'execution-profile'
  value: {
    profileId: string
    controllerKind: string
    configuration?: AgentInspectionJsonValue | undefined
  }
}

export type AgentInspectionArtifactPart = AgentInspectionPartBase & {
  kind: 'artifact'
  value: { artifactKind: string; bundleIdentity: string; identity?: string | undefined }
}

/** Every viewer-relevant Layer A and Layer B part in v1. */
export type AgentInspectionPart =
  | AgentInspectionPromptPart
  | AgentInspectionCapabilityPart
  | AgentInspectionRuntimeSettingPart
  | AgentInspectionHarnessPart
  | AgentInspectionModelPart
  | AgentInspectionExecutionProfilePart
  | AgentInspectionArtifactPart

type AgentInspectionDiagnosticBase = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export type AgentInspectionDiagnostic =
  | (AgentInspectionDiagnosticBase & {
      kind: 'compile'
      partId?: AgentInspectionPartId | undefined
    })
  | (AgentInspectionDiagnosticBase & {
      kind: 'resolution'
      partId?: AgentInspectionPartId | undefined
    })
  | (AgentInspectionDiagnosticBase & { kind: 'validation'; path?: string | undefined })

export type AgentInspectionCompleteness =
  | { kind: 'complete' }
  | { kind: 'partial'; missingPartIds: AgentInspectionPartId[] }

export type AgentInspectionFreshness =
  | {
      kind: 'fresh'
      evaluatedAt: string
      compileId: string
      planHash: string
      lockHash: string
      bundleIdentity: string
      contextHash: string
    }
  | {
      kind: 'stale'
      evaluatedAt: string
      reason: string
      expectedLockHash?: string | undefined
      actualLockHash?: string | undefined
    }
  | { kind: 'unknown'; reason: string }

/**
 * Complete consumer-independent result for one fully compiled agent.
 *
 * V1 intentionally carries no retention, history, permalink, or immutable
 * inspection identity fields. Context-reproducible reload is the v1 contract;
 * durable history remains a future ASP-owned capability per C-10913.
 */
export type AgentInspectionResult = {
  schemaVersion: typeof AGENT_INSPECTION_SCHEMA_VERSION
  identity: AgentInspectionIdentity
  parts: AgentInspectionPart[]
  completeness: AgentInspectionCompleteness
  freshness: AgentInspectionFreshness
  diagnostics: AgentInspectionDiagnostic[]
}

/** Consumer-selectable values; raw host state and secrets are not overrides. */
export type AgentInspectionDeclaredOverrides = {
  modelId?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  executionProfileId?: string | undefined
}

/** Consumer boundary: validated identifiers plus declared, non-secret overrides only. */
export type AgentInspectionRequest = {
  schemaVersion: typeof AGENT_INSPECTION_REQUEST_SCHEMA_VERSION
  identifiers: AgentInspectionIdentity
  declaredOverrides: AgentInspectionDeclaredOverrides
}

export type AgentInspectionServiceProbeResponse = {
  name: string
  endpoint: string
  up: boolean
}

export type AgentInspectionScaffoldPacket = {
  slot: string
  content?: string | undefined
  ref?: string | undefined
}

export type AgentInspectionCompileContext = {
  nowIso: string
  idSalt: string
  toolchainManifest: {
    schemaVersion: string
    tools?: ReadonlyArray<{ name: string; version: string }> | undefined
    modelCatalog?: Record<string, unknown> | undefined
  }
}

/**
 * ASP-owned, fully explicit evaluation inputs used to reproduce an inspection.
 * Inspection operations construct and validate this value before resolution;
 * consumers never supply its raw paths, environment, exec, probe, or credential
 * inputs directly.
 */
export type AgentInspectionEvaluationContext = {
  schemaVersion: typeof AGENT_INSPECTION_EVALUATION_CONTEXT_SCHEMA_VERSION
  identifiers: AgentInspectionIdentity
  paths: {
    agentRoot: string
    agentsRoot: string
    projectRoot: string
    cwd: string
  }
  nowIso: string
  environment: Record<string, string>
  predicateInputs: { cwd: string; environment: Record<string, string> }
  execInputs: { cwd: string; environment: Record<string, string> }
  serviceProbeInputs: { responses: AgentInspectionServiceProbeResponse[] }
  scaffoldPackets: AgentInspectionScaffoldPacket[]
  agentProfile: Record<string, unknown>
  declaredOverrides: AgentInspectionDeclaredOverrides
  compileContext: AgentInspectionCompileContext
}

/** Validation failure with every issue found in one traversal. */
export class AgentInspectionValidationError extends Error {
  readonly code = 'INVALID_AGENT_INSPECTION_CONTRACT'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid compiled-agent inspection contract')
    this.name = 'AgentInspectionValidationError'
    this.issues = issues
  }
}

type SchemaRecord = Record<string, unknown>

const ISSUE = {
  required: 'required',
  invalidType: 'invalid_type',
  invalidLiteral: 'invalid_literal',
  forbidden: 'forbidden_input',
} as const

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message }
}

function record(value: unknown, path: string, issues: ValidationIssue[]): SchemaRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as SchemaRecord
  }
  issues.push(
    issue(
      path,
      value === undefined ? ISSUE.required : ISSUE.invalidType,
      `${path} must be an object`
    )
  )
  return undefined
}

function string(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(
      issue(
        path,
        value === undefined ? ISSUE.required : ISSUE.invalidType,
        `${path} must be a string`
      )
    )
  }
}

function optionalString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value !== undefined) string(value, path, issues)
}

function literal(value: unknown, expected: string, path: string, issues: ValidationIssue[]): void {
  if (value !== expected) {
    issues.push(
      issue(
        path,
        value === undefined ? ISSUE.required : ISSUE.invalidLiteral,
        `${path} must be ${expected}`
      )
    )
  }
}

function oneOf(
  value: unknown,
  expected: readonly string[],
  path: string,
  issues: ValidationIssue[]
): value is string {
  if (typeof value !== 'string' || !expected.includes(value)) {
    issues.push(
      issue(path, value === undefined ? ISSUE.required : ISSUE.invalidLiteral, `${path} is invalid`)
    )
    return false
  }
  return true
}

function array(value: unknown, path: string, issues: ValidationIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(
      issue(
        path,
        value === undefined ? ISSUE.required : ISSUE.invalidType,
        `${path} must be an array`
      )
    )
    return undefined
  }
  return value
}

function boolean(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== 'boolean') {
    issues.push(
      issue(
        path,
        value === undefined ? ISSUE.required : ISSUE.invalidType,
        `${path} must be a boolean`
      )
    )
  }
}

function number(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(
      issue(
        path,
        value === undefined ? ISSUE.required : ISSUE.invalidType,
        `${path} must be a number`
      )
    )
  }
}

function stringArray(value: unknown, path: string, issues: ValidationIssue[]): void {
  const values = array(value, path, issues)
  values?.forEach((item, index) => string(item, `${path}.${index}`, issues))
}

function stringRecord(value: unknown, path: string, issues: ValidationIssue[]): void {
  const values = record(value, path, issues)
  if (values === undefined) return
  for (const [key, item] of Object.entries(values)) string(item, `${path}.${key}`, issues)
}

function validateIdentity(value: unknown, path: string, issues: ValidationIssue[]): void {
  const identity = record(value, path, issues)
  if (identity === undefined) return
  for (const field of [
    'agentId',
    'projectId',
    'mode',
    'scope',
    'lane',
    'harness',
    'frontend',
    'interaction',
  ]) {
    string(identity[field], `${path}.${field}`, issues)
  }
  optionalString(identity['agentName'], `${path}.agentName`, issues)
  optionalString(identity['taskId'], `${path}.taskId`, issues)
}

function validatePartId(value: unknown, path: string, issues: ValidationIssue[]): void {
  string(value, path, issues)
  if (typeof value === 'string' && !/^[a-z][a-z0-9-]*(?::[A-Za-z0-9._/-]+)+$/.test(value)) {
    issues.push(issue(path, ISSUE.invalidType, `${path} must be a semantic namespaced part id`))
  }
}

function validateFailureSource(value: unknown, path: string, issues: ValidationIssue[]): void {
  const source = record(value, path, issues)
  if (source === undefined) return
  if (
    !oneOf(
      source['kind'],
      ['file', 'inline', 'exec', 'slot', 'service-probe', 'compiler'],
      `${path}.kind`,
      issues
    )
  ) {
    return
  }
  switch (source['kind']) {
    case 'file':
      string(source['ref'], `${path}.ref`, issues)
      break
    case 'inline':
      string(source['name'], `${path}.name`, issues)
      break
    case 'exec':
      string(source['command'], `${path}.command`, issues)
      break
    case 'slot':
      string(source['source'], `${path}.source`, issues)
      break
    case 'service-probe':
      stringArray(source['services'], `${path}.services`, issues)
      break
    case 'compiler':
      string(source['stage'], `${path}.stage`, issues)
      break
  }
}

function validateDisposition(value: unknown, path: string, issues: ValidationIssue[]): void {
  const disposition = record(value, path, issues)
  if (disposition === undefined) return
  if (
    !oneOf(
      disposition['kind'],
      ['effective', 'overridden', 'deduplicated', 'skipped', 'failed'],
      `${path}.kind`,
      issues
    )
  ) {
    return
  }
  switch (disposition['kind']) {
    case 'overridden':
      validatePartId(disposition['byPartId'], `${path}.byPartId`, issues)
      break
    case 'deduplicated':
      validatePartId(disposition['canonicalPartId'], `${path}.canonicalPartId`, issues)
      break
    case 'skipped':
      oneOf(disposition['reason'], ['predicate', 'empty'], `${path}.reason`, issues)
      break
    case 'failed':
      validateFailureSource(disposition['source'], `${path}.source`, issues)
      string(disposition['reason'], `${path}.reason`, issues)
      break
  }
}

function validateProvenance(value: unknown, path: string, issues: ValidationIssue[]): void {
  const provenance = record(value, path, issues)
  if (provenance === undefined) return
  const contributions = array(provenance['contributions'], `${path}.contributions`, issues)
  contributions?.forEach((value, index) => {
    const itemPath = `${path}.contributions.${index}`
    const contribution = record(value, itemPath, issues)
    if (contribution === undefined) return
    oneOf(
      contribution['kind'],
      ['agent', 'project', 'space', 'template', 'override', 'runtime-plan', 'compiler'],
      `${itemPath}.kind`,
      issues
    )
    string(contribution['sourceId'], `${itemPath}.sourceId`, issues)
    string(contribution['sourceRef'], `${itemPath}.sourceRef`, issues)
  })
}

function validatePartValue(
  kind: string,
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): void {
  const partValue = record(value, path, issues)
  if (partValue === undefined) return
  switch (kind) {
    case 'prompt':
      oneOf(partValue['zone'], ['prompt', 'reminder'], `${path}.zone`, issues)
      string(partValue['name'], `${path}.name`, issues)
      oneOf(
        partValue['sourceType'],
        ['file', 'inline', 'exec', 'slot', 'service-probe'],
        `${path}.sourceType`,
        issues
      )
      number(partValue['order'], `${path}.order`, issues)
      optionalString(partValue['content'], `${path}.content`, issues)
      break
    case 'capability':
      string(partValue['capabilityId'], `${path}.capabilityId`, issues)
      boolean(partValue['enabled'], `${path}.enabled`, issues)
      break
    case 'runtime-setting':
      string(partValue['settingId'], `${path}.settingId`, issues)
      if (partValue['value'] === undefined) {
        issues.push(issue(`${path}.value`, ISSUE.required, `${path}.value is required`))
      }
      break
    case 'harness':
      string(partValue['family'], `${path}.family`, issues)
      string(partValue['runtime'], `${path}.runtime`, issues)
      string(partValue['provider'], `${path}.provider`, issues)
      break
    case 'model':
      string(partValue['provider'], `${path}.provider`, issues)
      string(partValue['modelId'], `${path}.modelId`, issues)
      optionalString(partValue['reasoningEffort'], `${path}.reasoningEffort`, issues)
      break
    case 'execution-profile':
      string(partValue['profileId'], `${path}.profileId`, issues)
      string(partValue['controllerKind'], `${path}.controllerKind`, issues)
      break
    case 'artifact':
      string(partValue['artifactKind'], `${path}.artifactKind`, issues)
      string(partValue['bundleIdentity'], `${path}.bundleIdentity`, issues)
      optionalString(partValue['identity'], `${path}.identity`, issues)
      break
  }
}

function validatePart(value: unknown, path: string, issues: ValidationIssue[]): void {
  const part = record(value, path, issues)
  if (part === undefined) return
  validatePartId(part['partId'], `${path}.partId`, issues)
  const kind = part['kind']
  const validKind = oneOf(
    kind,
    [
      'prompt',
      'capability',
      'runtime-setting',
      'harness',
      'model',
      'execution-profile',
      'artifact',
    ],
    `${path}.kind`,
    issues
  )
  validateDisposition(part['disposition'], `${path}.disposition`, issues)
  validateProvenance(part['provenance'], `${path}.provenance`, issues)
  if (validKind) validatePartValue(kind, part['value'], `${path}.value`, issues)
}

function validateCompleteness(value: unknown, path: string, issues: ValidationIssue[]): void {
  const completeness = record(value, path, issues)
  if (completeness === undefined) return
  if (!oneOf(completeness['kind'], ['complete', 'partial'], `${path}.kind`, issues)) return
  if (completeness['kind'] === 'partial') {
    const missing = array(completeness['missingPartIds'], `${path}.missingPartIds`, issues)
    missing?.forEach((partId, index) =>
      validatePartId(partId, `${path}.missingPartIds.${index}`, issues)
    )
  }
}

function validateFreshness(value: unknown, path: string, issues: ValidationIssue[]): void {
  const freshness = record(value, path, issues)
  if (freshness === undefined) return
  if (!oneOf(freshness['kind'], ['fresh', 'stale', 'unknown'], `${path}.kind`, issues)) return
  switch (freshness['kind']) {
    case 'fresh':
      for (const field of [
        'evaluatedAt',
        'compileId',
        'planHash',
        'lockHash',
        'bundleIdentity',
        'contextHash',
      ]) {
        string(freshness[field], `${path}.${field}`, issues)
      }
      break
    case 'stale':
      string(freshness['evaluatedAt'], `${path}.evaluatedAt`, issues)
      string(freshness['reason'], `${path}.reason`, issues)
      optionalString(freshness['expectedLockHash'], `${path}.expectedLockHash`, issues)
      optionalString(freshness['actualLockHash'], `${path}.actualLockHash`, issues)
      break
    case 'unknown':
      string(freshness['reason'], `${path}.reason`, issues)
      break
  }
}

function validateDiagnostic(value: unknown, path: string, issues: ValidationIssue[]): void {
  const diagnostic = record(value, path, issues)
  if (diagnostic === undefined) return
  const validKind = oneOf(
    diagnostic['kind'],
    ['compile', 'resolution', 'validation'],
    `${path}.kind`,
    issues
  )
  oneOf(diagnostic['severity'], ['info', 'warning', 'error'], `${path}.severity`, issues)
  string(diagnostic['code'], `${path}.code`, issues)
  string(diagnostic['message'], `${path}.message`, issues)
  if (!validKind) return
  if (diagnostic['kind'] === 'compile' || diagnostic['kind'] === 'resolution') {
    if (diagnostic['partId'] !== undefined) {
      validatePartId(diagnostic['partId'], `${path}.partId`, issues)
    }
  } else {
    optionalString(diagnostic['path'], `${path}.path`, issues)
  }
}

function throwIfIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new AgentInspectionValidationError(issues)
}

/** Validates and returns the original v1 inspection result. */
export function validateAgentInspectionResult(value: unknown): AgentInspectionResult {
  const issues: ValidationIssue[] = []
  const result = record(value, '', issues)
  if (result !== undefined) {
    literal(result['schemaVersion'], AGENT_INSPECTION_SCHEMA_VERSION, 'schemaVersion', issues)
    validateIdentity(result['identity'], 'identity', issues)
    const parts = array(result['parts'], 'parts', issues)
    parts?.forEach((part, index) => validatePart(part, `parts.${index}`, issues))
    validateCompleteness(result['completeness'], 'completeness', issues)
    validateFreshness(result['freshness'], 'freshness', issues)
    const diagnostics = array(result['diagnostics'], 'diagnostics', issues)
    diagnostics?.forEach((item, index) => validateDiagnostic(item, `diagnostics.${index}`, issues))
  }
  throwIfIssues(issues)
  return value as AgentInspectionResult
}

const ALLOWED_OVERRIDE_KEYS = new Set(['modelId', 'reasoningEffort', 'executionProfileId'])
const RAW_PATH_KEY = /(^cwd$|root$|path|directory)/i
const RAW_ENV_KEY = /(^env$|environment)/i
const CREDENTIAL_KEY = /(credential|password|secret|token|api.?key|private.?key)/i

function validateDeclaredOverrides(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  consumerBoundary: boolean
): void {
  const overrides = record(value, path, issues)
  if (overrides === undefined) return
  for (const [key, item] of Object.entries(overrides)) {
    const itemPath = `${path}.${key}`
    if (
      !ALLOWED_OVERRIDE_KEYS.has(key) ||
      (consumerBoundary &&
        (RAW_PATH_KEY.test(key) || RAW_ENV_KEY.test(key) || CREDENTIAL_KEY.test(key)))
    ) {
      issues.push(
        issue(
          itemPath,
          ISSUE.forbidden,
          `${itemPath} is not an allowed declared inspection override`
        )
      )
      continue
    }
    if (key === 'reasoningEffort') {
      oneOf(item, ['low', 'medium', 'high', 'xhigh'], itemPath, issues)
    } else {
      string(item, itemPath, issues)
    }
  }
}

function rejectUnknownFields(
  value: SchemaRecord,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const itemPath = path.length === 0 ? key : `${path}.${key}`
      issues.push(issue(itemPath, ISSUE.forbidden, `${itemPath} is not accepted at this boundary`))
    }
  }
}

/**
 * Validates the consumer request boundary and rejects raw paths, caller env maps,
 * credential values, and unsupported override fields with accumulated issues.
 */
export function validateAgentInspectionRequest(value: unknown): AgentInspectionRequest {
  const issues: ValidationIssue[] = []
  const request = record(value, '', issues)
  if (request !== undefined) {
    literal(
      request['schemaVersion'],
      AGENT_INSPECTION_REQUEST_SCHEMA_VERSION,
      'schemaVersion',
      issues
    )
    validateIdentity(request['identifiers'], 'identifiers', issues)
    validateDeclaredOverrides(request['declaredOverrides'], 'declaredOverrides', issues, true)
    rejectUnknownFields(
      request,
      new Set(['schemaVersion', 'identifiers', 'declaredOverrides']),
      '',
      issues
    )
  }
  throwIfIssues(issues)
  return value as AgentInspectionRequest
}

function validatePaths(value: unknown, path: string, issues: ValidationIssue[]): void {
  const paths = record(value, path, issues)
  if (paths === undefined) return
  for (const field of ['agentRoot', 'agentsRoot', 'projectRoot', 'cwd']) {
    string(paths[field], `${path}.${field}`, issues)
  }
}

function validateExecutionInputs(value: unknown, path: string, issues: ValidationIssue[]): void {
  const inputs = record(value, path, issues)
  if (inputs === undefined) return
  string(inputs['cwd'], `${path}.cwd`, issues)
  stringRecord(inputs['environment'], `${path}.environment`, issues)
}

function validateServiceProbeInputs(value: unknown, path: string, issues: ValidationIssue[]): void {
  const inputs = record(value, path, issues)
  if (inputs === undefined) return
  const responses = array(inputs['responses'], `${path}.responses`, issues)
  responses?.forEach((value, index) => {
    const responsePath = `${path}.responses.${index}`
    const response = record(value, responsePath, issues)
    if (response === undefined) return
    string(response['name'], `${responsePath}.name`, issues)
    string(response['endpoint'], `${responsePath}.endpoint`, issues)
    boolean(response['up'], `${responsePath}.up`, issues)
  })
}

function validateScaffoldPackets(value: unknown, path: string, issues: ValidationIssue[]): void {
  const packets = array(value, path, issues)
  packets?.forEach((value, index) => {
    const packetPath = `${path}.${index}`
    const packet = record(value, packetPath, issues)
    if (packet === undefined) return
    string(packet['slot'], `${packetPath}.slot`, issues)
    optionalString(packet['content'], `${packetPath}.content`, issues)
    optionalString(packet['ref'], `${packetPath}.ref`, issues)
  })
}

function validateCompileContext(value: unknown, path: string, issues: ValidationIssue[]): void {
  const compile = record(value, path, issues)
  if (compile === undefined) return
  string(compile['nowIso'], `${path}.nowIso`, issues)
  string(compile['idSalt'], `${path}.idSalt`, issues)
  const manifest = record(compile['toolchainManifest'], `${path}.toolchainManifest`, issues)
  if (manifest !== undefined) {
    string(manifest['schemaVersion'], `${path}.toolchainManifest.schemaVersion`, issues)
    if (manifest['tools'] !== undefined) {
      const tools = array(manifest['tools'], `${path}.toolchainManifest.tools`, issues)
      tools?.forEach((value, index) => {
        const toolPath = `${path}.toolchainManifest.tools.${index}`
        const tool = record(value, toolPath, issues)
        if (tool === undefined) return
        string(tool['name'], `${toolPath}.name`, issues)
        string(tool['version'], `${toolPath}.version`, issues)
      })
    }
    if (manifest['modelCatalog'] !== undefined) {
      record(manifest['modelCatalog'], `${path}.toolchainManifest.modelCatalog`, issues)
    }
  }
}

/** Validates the complete ASP-owned, ambient-free inspection evaluation context. */
export function validateAgentInspectionEvaluationContext(
  value: unknown
): AgentInspectionEvaluationContext {
  const issues: ValidationIssue[] = []
  const context = record(value, '', issues)
  if (context !== undefined) {
    literal(
      context['schemaVersion'],
      AGENT_INSPECTION_EVALUATION_CONTEXT_SCHEMA_VERSION,
      'schemaVersion',
      issues
    )
    validateIdentity(context['identifiers'], 'identifiers', issues)
    validatePaths(context['paths'], 'paths', issues)
    string(context['nowIso'], 'nowIso', issues)
    stringRecord(context['environment'], 'environment', issues)
    validateExecutionInputs(context['predicateInputs'], 'predicateInputs', issues)
    validateExecutionInputs(context['execInputs'], 'execInputs', issues)
    validateServiceProbeInputs(context['serviceProbeInputs'], 'serviceProbeInputs', issues)
    validateScaffoldPackets(context['scaffoldPackets'], 'scaffoldPackets', issues)
    record(context['agentProfile'], 'agentProfile', issues)
    validateDeclaredOverrides(context['declaredOverrides'], 'declaredOverrides', issues, false)
    validateCompileContext(context['compileContext'], 'compileContext', issues)
  }
  throwIfIssues(issues)
  return value as AgentInspectionEvaluationContext
}
