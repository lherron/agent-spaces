/**
 * Params validators for `aspc.compileHarnessInvocation`: the compile envelope,
 * its serializable compile context, and the v2 runtime compile request.
 */
import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import type { SchemaRecord } from './validation-primitives.js'
import {
  path,
  optionalBoolean,
  optionalEnum,
  optionalRecord,
  optionalString,
  rejectUnknownParams,
  requireLiteral,
  requireRecord,
  requireRecordFields,
  requireString,
  validateOptionalStringRecord,
} from './validation-primitives.js'

/**
 * Canonical `schemaVersion` literal of the runtime compile request. Authoritative
 * home is `spaces-runtime-contracts`; mirrored here as a single point of reference
 * for the validator so the literal isn't repeated inline.
 */
const RUNTIME_COMPILE_REQUEST_SCHEMA_VERSION = 'agent-runtime-compile-request/v2'

const HARNESS_IDS = ['agent-harness', 'claude', 'codex', 'muse'] as const
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/**
 * Wire key names for one harness selection record. `requested` uses camelCase;
 * `selectionContext.summonDirectives` carries the snake_case directive keys.
 */
interface SelectionKeys {
  harness: string
  modelProvider: string
  model: string
  reasoningEffort: string
  presentation: string
}

const REQUESTED_KEYS: SelectionKeys = {
  harness: 'harness',
  modelProvider: 'modelProvider',
  model: 'model',
  reasoningEffort: 'reasoningEffort',
  presentation: 'presentation',
}

const SUMMON_DIRECTIVE_KEYS: SelectionKeys = {
  harness: 'harness',
  modelProvider: 'model_provider',
  model: 'model',
  reasoningEffort: 'reasoning_effort',
  presentation: 'presentation',
}

/** Validate one closed harness selection record (all fields optional). */
function validateSelection(
  selection: SchemaRecord,
  keys: SelectionKeys,
  basePath: string,
  issues: ValidationIssue[]
): void {
  optionalEnum(selection[keys.harness], HARNESS_IDS, path(basePath, keys.harness), issues)
  optionalString(selection[keys.modelProvider], path(basePath, keys.modelProvider), issues)
  optionalString(selection[keys.model], path(basePath, keys.model), issues)
  optionalEnum(
    selection[keys.reasoningEffort],
    REASONING_EFFORTS,
    path(basePath, keys.reasoningEffort),
    issues
  )
  optionalBoolean(selection[keys.presentation], path(basePath, keys.presentation), issues)
  rejectUnknownParams(selection, new Set(Object.values(keys)), basePath, issues)
}

function validateCompileEnvelope(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return undefined
  validateRuntimeCompileRequest(request['compileRequest'], path(basePath, 'compileRequest'), issues)
  optionalString(request['aspHome'], path(basePath, 'aspHome'), issues)
  validateCompileContext(request['compileContext'], path(basePath, 'compileContext'), issues)
  return request
}

/**
 * Validate the optional serializable compile context (T-04133). All fields are
 * optional; an absent context is accepted. `nowIso` / `idSalt` must be strings;
 * `toolchainManifest`, when present, must be a record.
 */
function validateCompileContext(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const context = optionalRecord(value, basePath, issues)
  if (context === undefined) return
  optionalString(context['nowIso'], path(basePath, 'nowIso'), issues)
  optionalString(context['idSalt'], path(basePath, 'idSalt'), issues)
  optionalRecord(context['toolchainManifest'], path(basePath, 'toolchainManifest'), issues)
}

export function validateCompileHarnessInvocation(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = validateCompileEnvelope(value, basePath, issues)
  if (request === undefined) return
  validateOptionalStringRecord(request['dispatchEnv'], path(basePath, 'dispatchEnv'), issues)
  optionalRecord(request['runtime'], path(basePath, 'runtime'), issues)
  optionalRecord(request['lifecyclePolicy'], path(basePath, 'lifecyclePolicy'), issues)
  rejectUnknownParams(
    request,
    new Set([
      'compileRequest',
      'aspHome',
      'compileContext',
      'dispatchEnv',
      'runtime',
      'lifecyclePolicy',
    ]),
    basePath,
    issues
  )
}

function validateRuntimeCompileRequest(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return
  requireLiteral(
    request['schemaVersion'],
    RUNTIME_COMPILE_REQUEST_SCHEMA_VERSION,
    path(basePath, 'schemaVersion'),
    issues
  )
  requireRecordFields(
    request,
    basePath,
    ['agent', 'identity', 'placement', 'requested', 'materialization', 'hrcPolicy', 'correlation'],
    issues
  )
  const agent = requireRecord(request['agent'], path(basePath, 'agent'), issues)
  if (agent !== undefined) {
    requireString(agent['id'], path(basePath, 'agent.id'), issues)
    rejectUnknownParams(agent, new Set(['id']), path(basePath, 'agent'), issues)
  }
  const requested = requireRecord(request['requested'], path(basePath, 'requested'), issues)
  if (requested !== undefined) {
    validateSelection(requested, REQUESTED_KEYS, path(basePath, 'requested'), issues)
  }
  const selectionContextPath = path(basePath, 'selectionContext')
  const selectionContext = optionalRecord(request['selectionContext'], selectionContextPath, issues)
  if (selectionContext !== undefined) {
    const directivesPath = path(selectionContextPath, 'summonDirectives')
    const directives = optionalRecord(selectionContext['summonDirectives'], directivesPath, issues)
    if (directives !== undefined) {
      validateSelection(directives, SUMMON_DIRECTIVE_KEYS, directivesPath, issues)
    }
    rejectUnknownParams(
      selectionContext,
      new Set(['summonDirectives']),
      selectionContextPath,
      issues
    )
  }
  rejectUnknownParams(
    request,
    new Set([
      'schemaVersion',
      'agent',
      'identity',
      'placement',
      'selectionContext',
      'requested',
      'materialization',
      'hrcPolicy',
      'continuation',
      'correlation',
    ]),
    basePath,
    issues
  )
}
