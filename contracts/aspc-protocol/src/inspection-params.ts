/**
 * Params validators for the agent inspection methods: `aspc.catalogAgents`,
 * `aspc.inspectAgent`, `aspc.catalogAgentInspection` and
 * `aspc.inspectAgentSelection`. Shared inspection request/context shapes are
 * owned by spaces-runtime-contracts; their issues are re-rooted under params.
 */
import type { ValidationIssue } from 'spaces-harness-broker-protocol'
import {
  AgentInspectionValidationError,
  validateAgentInspectionEvaluationContext,
  validateAgentInspectionRequest,
} from 'spaces-runtime-contracts'
import {
  path,
  ISSUE_CODE,
  issue,
  rejectUnknownParams,
  requireRecord,
} from './validation-primitives.js'

const INSPECTION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/
const INSPECTION_IDENTIFIER_MAX_LENGTH = 160

export function validateCatalogAgents(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  appendInspectionIssues(
    () => validateAgentInspectionEvaluationContext(params['evaluationContext']),
    path(basePath, 'evaluationContext'),
    issues
  )
  rejectUnknownParams(params, new Set(['evaluationContext']), basePath, issues)
}

export function validateInspectAgent(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  appendInspectionIssues(
    () => validateAgentInspectionRequest(params['request']),
    path(basePath, 'request'),
    issues
  )
  appendInspectionIssues(
    () => validateAgentInspectionEvaluationContext(params['evaluationContext']),
    path(basePath, 'evaluationContext'),
    issues
  )
  rejectUnknownParams(params, new Set(['request', 'evaluationContext']), basePath, issues)
}

export function validateCatalogAgentInspection(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  validateOptionalInspectionIdentifier(params['projectId'], path(basePath, 'projectId'), issues)
  rejectUnknownParams(params, new Set(['projectId']), basePath, issues)
}

export function validateInspectAgentSelection(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const params = requireRecord(value, basePath, issues)
  if (params === undefined) return
  validateInspectionIdentifier(params['agentId'], path(basePath, 'agentId'), issues)
  appendInspectionIssues(
    () => validateAgentInspectionRequest(params['request']),
    path(basePath, 'request'),
    issues
  )
  validateStrictInspectionRequest(params['request'], path(basePath, 'request'), issues)
  rejectUnknownParams(params, new Set(['agentId', 'request']), basePath, issues)
}

function validateStrictInspectionRequest(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const request = requireRecord(value, basePath, issues)
  if (request === undefined) return
  rejectUnknownParams(
    request,
    new Set(['schemaVersion', 'identifiers', 'declaredOverrides']),
    basePath,
    issues
  )
  const identifiersPath = path(basePath, 'identifiers')
  const identifiers = requireRecord(request['identifiers'], identifiersPath, issues)
  if (identifiers === undefined) return
  const required = ['agentId', 'projectId', 'mode', 'scope', 'lane', 'harness'] as const
  for (const field of required) {
    validateInspectionIdentifier(identifiers[field], path(identifiersPath, field), issues)
  }
  for (const field of ['agentName', 'taskId'] as const) {
    validateOptionalInspectionIdentifier(identifiers[field], path(identifiersPath, field), issues)
  }
  if (typeof identifiers['presentation'] !== 'boolean') {
    issues.push(
      issue(
        path(identifiersPath, 'presentation'),
        ISSUE_CODE.invalidType,
        `${path(identifiersPath, 'presentation')} must be a boolean`
      )
    )
  }
  rejectUnknownParams(
    identifiers,
    new Set([...required, 'agentName', 'taskId', 'presentation']),
    identifiersPath,
    issues
  )
}

function validateInspectionIdentifier(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > INSPECTION_IDENTIFIER_MAX_LENGTH ||
    !INSPECTION_IDENTIFIER_PATTERN.test(value)
  ) {
    issues.push(
      issue(
        basePath,
        ISSUE_CODE.invalidType,
        `${basePath} must be a validated identifier of at most ${INSPECTION_IDENTIFIER_MAX_LENGTH} characters`
      )
    )
  }
}

function validateOptionalInspectionIdentifier(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value !== undefined) validateInspectionIdentifier(value, basePath, issues)
}

function appendInspectionIssues(
  validate: () => unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  try {
    validate()
  } catch (error) {
    if (!(error instanceof AgentInspectionValidationError)) throw error
    issues.push(
      ...error.issues.map((item) => {
        const rooted = item.path.length === 0 ? basePath : `${basePath}.${item.path}`
        // Messages lead with the issue's own relative path (empty at the root); re-root it too.
        const message = item.message.startsWith(item.path)
          ? `${rooted}${item.message.slice(item.path.length)}`
          : item.message
        return { ...item, path: rooted, message }
      })
    )
  }
}
