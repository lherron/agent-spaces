import {
  validateAgentInspectionRequest,
  validateAgentInspectionResult,
} from 'spaces-runtime-contracts/agent-inspection'
import type { AgentInspectionRequest } from 'spaces-runtime-contracts/agent-inspection'

import type {
  AspcAgentInspectionCatalogResponse,
  AspcInspectAgentResponse,
} from './agent-inspection-types.js'

type ValidationIssue = {
  path: string
  code: string
  message: string
}

export class AspcSharedAgentInspectionSchemaError extends Error {
  readonly code = 'INVALID_ASPC_SHARED_AGENT_INSPECTION_SCHEMA'
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super('Invalid shared agent-inspection schema')
    this.name = 'AspcSharedAgentInspectionSchemaError'
    this.issues = issues
  }
}

export type AspcSharedSchema<T> = {
  parse(value: unknown): T
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error }
}

function schema<T>(parse: (value: unknown) => T): AspcSharedSchema<T> {
  return {
    parse,
    safeParse(value) {
      try {
        return { success: true, data: parse(value) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) }
      }
    },
  }
}

/** Shared strict request schema consumed by ACP and presentation clients. */
export const agentInspectionRequestSchema = schema<AgentInspectionRequest>((value) => {
  const request = validateAgentInspectionRequest(value)
  const issues: ValidationIssue[] = []
  identifier(request.identifiers.agentId, 'identifiers.agentId', issues)
  if (request.identifiers.agentName !== undefined) {
    identifier(request.identifiers.agentName, 'identifiers.agentName', issues)
  }
  identifier(request.identifiers.projectId, 'identifiers.projectId', issues)
  identifier(request.identifiers.mode, 'identifiers.mode', issues)
  identifier(request.identifiers.scope, 'identifiers.scope', issues)
  if (request.identifiers.taskId !== undefined) {
    identifier(request.identifiers.taskId, 'identifiers.taskId', issues)
  }
  identifier(request.identifiers.lane, 'identifiers.lane', issues)
  identifier(request.identifiers.harness, 'identifiers.harness', issues)
  identifier(request.identifiers.frontend, 'identifiers.frontend', issues)
  identifier(request.identifiers.interaction, 'identifiers.interaction', issues)
  throwIfIssues(issues)
  return request
})

/** Shared public catalog schema. Evaluation context and filesystem fields are forbidden. */
export const agentCatalogResponseSchema = schema<AspcAgentInspectionCatalogResponse>((value) => {
  const issues: ValidationIssue[] = []
  const catalog = asRecord(value, '', issues)
  if (catalog !== undefined) {
    rejectUnknown(catalog, new Set(['projectId', 'agents', 'contexts']), '', issues)
    if (catalog['projectId'] !== null) identifier(catalog['projectId'], 'projectId', issues)

    const agents = asArray(catalog['agents'], 'agents', issues)
    agents?.forEach((row, index) => validateCatalogRow(row, `agents.${index}`, issues))

    const contexts = asRecord(catalog['contexts'], 'contexts', issues)
    if (contexts !== undefined) {
      for (const [agentId, options] of Object.entries(contexts)) {
        identifier(agentId, `contexts.${agentId}`, issues)
        const entries = asArray(options, `contexts.${agentId}`, issues)
        entries?.forEach((entry, index) =>
          validateContextOption(
            entry,
            `contexts.${agentId}.${index}`,
            agentId,
            typeof catalog['projectId'] === 'string' ? catalog['projectId'] : undefined,
            issues
          )
        )
      }
    }
    validateCatalogContextSemantics(catalog, agents, contexts, issues)
  }
  throwIfIssues(issues)
  return value as AspcAgentInspectionCatalogResponse
})

/** Shared producer outcome schema used by both HTTP consumers. */
export const agentInspectionOutcomeSchema = schema<AspcInspectAgentResponse>((value) => {
  const issues: ValidationIssue[] = []
  const outcome = asRecord(value, '', issues)
  if (outcome !== undefined) {
    if (outcome['ok'] === true) {
      rejectUnknown(outcome, new Set(['ok', 'inspection']), '', issues)
      try {
        const inspection = validateAgentInspectionResult(outcome['inspection'])
        const record = asRecord(inspection, 'inspection', issues)
        if (record !== undefined) {
          rejectUnknown(
            record,
            new Set([
              'schemaVersion',
              'identity',
              'parts',
              'completeness',
              'freshness',
              'diagnostics',
            ]),
            'inspection',
            issues
          )
          agentInspectionRequestSchema.parse({
            schemaVersion: 'agent-inspection-request/v1',
            identifiers: inspection.identity,
            declaredOverrides: {},
          })
        }
      } catch (error) {
        appendNestedIssues(error, 'inspection', issues)
      }
    } else if (outcome['ok'] === false) {
      rejectUnknown(outcome, new Set(['ok', 'diagnostics']), '', issues)
      const diagnostics = asArray(outcome['diagnostics'], 'diagnostics', issues)
      diagnostics?.forEach((entry, index) =>
        validateDiagnostic(entry, `diagnostics.${index}`, issues)
      )
    } else {
      issues.push(issue('ok', 'invalid_literal', 'ok must be true or false'))
    }
  }
  throwIfIssues(issues)
  return value as AspcInspectAgentResponse
})

function validateCatalogRow(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const row = asRecord(value, basePath, issues)
  if (row === undefined) return
  rejectUnknown(
    row,
    new Set([
      'agentId',
      'displayName',
      'role',
      'sourceAvailability',
      'defaultContextSummary',
      'diagnostics',
      'warningCount',
      'errorCount',
    ]),
    basePath,
    issues
  )
  identifier(row['agentId'], `${basePath}.agentId`, issues)
  nonEmptyString(row['displayName'], `${basePath}.displayName`, issues)
  if (row['role'] !== null && typeof row['role'] !== 'string') {
    issues.push(
      issue(`${basePath}.role`, 'invalid_type', `${basePath}.role must be a string or null`)
    )
  }

  const availability = asRecord(row['sourceAvailability'], `${basePath}.sourceAvailability`, issues)
  if (availability !== undefined) {
    rejectUnknown(
      availability,
      new Set(['profile', 'soul', 'contextTemplate']),
      `${basePath}.sourceAvailability`,
      issues
    )
    for (const field of ['profile', 'soul', 'contextTemplate']) {
      if (typeof availability[field] !== 'boolean') {
        issues.push(
          issue(
            `${basePath}.sourceAvailability.${field}`,
            'invalid_type',
            `${basePath}.sourceAvailability.${field} must be a boolean`
          )
        )
      }
    }
  }

  if (row['defaultContextSummary'] !== undefined) {
    const summary = asRecord(
      row['defaultContextSummary'],
      `${basePath}.defaultContextSummary`,
      issues
    )
    if (summary !== undefined) {
      const fields = ['projectId', 'mode', 'lane', 'harness', 'frontend', 'interaction']
      rejectUnknown(summary, new Set(fields), `${basePath}.defaultContextSummary`, issues)
      for (const field of fields) {
        identifier(summary[field], `${basePath}.defaultContextSummary.${field}`, issues)
      }
    }
  }

  const diagnostics = asArray(row['diagnostics'], `${basePath}.diagnostics`, issues)
  diagnostics?.forEach((entry, index) =>
    validateDiagnostic(entry, `${basePath}.diagnostics.${index}`, issues)
  )
  nonNegativeInteger(row['warningCount'], `${basePath}.warningCount`, issues)
  nonNegativeInteger(row['errorCount'], `${basePath}.errorCount`, issues)
}

function validateContextOption(
  value: unknown,
  basePath: string,
  agentId: string,
  projectId: string | undefined,
  issues: ValidationIssue[]
): void {
  const option = asRecord(value, basePath, issues)
  if (option === undefined) return
  rejectUnknown(option, new Set(['identifiers', 'declaredOverrides']), basePath, issues)
  try {
    const request = agentInspectionRequestSchema.parse({
      schemaVersion: 'agent-inspection-request/v1',
      identifiers: option['identifiers'],
      declaredOverrides: option['declaredOverrides'],
    })
    if (request.identifiers.agentId !== agentId) {
      issues.push(
        issue(
          `${basePath}.identifiers.agentId`,
          'identity_mismatch',
          `${basePath}.identifiers.agentId must match its contexts key`
        )
      )
    }
    if (projectId !== undefined && request.identifiers.projectId !== projectId) {
      issues.push(
        issue(
          `${basePath}.identifiers.projectId`,
          'identity_mismatch',
          `${basePath}.identifiers.projectId must match the catalog projectId`
        )
      )
    }
  } catch (error) {
    appendNestedIssues(error, basePath, issues)
  }
}

function validateCatalogContextSemantics(
  catalog: Record<string, unknown>,
  agents: unknown[] | undefined,
  contexts: Record<string, unknown> | undefined,
  issues: ValidationIssue[]
): void {
  if (catalog['projectId'] === null) {
    if (contexts !== undefined && Object.keys(contexts).length > 0) {
      issues.push(
        issue('contexts', 'forbidden_input', 'a project-neutral catalog must have empty contexts')
      )
    }
    agents?.forEach((value, index) => {
      const row = asRecord(value, `agents.${index}`, issues)
      if (row?.['defaultContextSummary'] !== undefined) {
        issues.push(
          issue(
            `agents.${index}.defaultContextSummary`,
            'forbidden_input',
            'a project-neutral catalog cannot carry a default context'
          )
        )
      }
    })
    return
  }

  if (typeof catalog['projectId'] !== 'string') return
  agents?.forEach((value, index) => {
    const row = asRecord(value, `agents.${index}`, issues)
    const summary = row ? asOptionalRecord(row['defaultContextSummary']) : undefined
    if (summary !== undefined && summary['projectId'] !== catalog['projectId']) {
      issues.push(
        issue(
          `agents.${index}.defaultContextSummary.projectId`,
          'identity_mismatch',
          'defaultContextSummary.projectId must match the catalog projectId'
        )
      )
    }
  })
}

function validateDiagnostic(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  const diagnostic = asRecord(value, basePath, issues)
  if (diagnostic === undefined) return
  rejectUnknown(diagnostic, new Set(['severity', 'code', 'message']), basePath, issues)
  if (!['info', 'warning', 'error'].includes(String(diagnostic['severity']))) {
    issues.push(issue(`${basePath}.severity`, 'invalid_literal', `${basePath}.severity is invalid`))
  }
  nonEmptyString(diagnostic['code'], `${basePath}.code`, issues)
  nonEmptyString(diagnostic['message'], `${basePath}.message`, issues)
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/

function identifier(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 160 ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    issues.push(issue(basePath, 'invalid_identifier', `${basePath} must be a validated identifier`))
  }
}

function nonEmptyString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a non-empty string`))
  }
}

function nonNegativeInteger(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a non-negative integer`))
  }
}

function asRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  issues.push(
    issue(basePath, value === undefined ? 'required' : 'invalid_type', 'must be an object')
  )
  return undefined
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): unknown[] | undefined {
  if (Array.isArray(value)) return value
  issues.push(
    issue(basePath, value === undefined ? 'required' : 'invalid_type', 'must be an array')
  )
  return undefined
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  basePath: string,
  issues: ValidationIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue
    const itemPath = basePath.length === 0 ? key : `${basePath}.${key}`
    issues.push(issue(itemPath, 'forbidden_input', `${itemPath} is not accepted`))
  }
}

function appendNestedIssues(error: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (
    typeof error === 'object' &&
    error !== null &&
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    for (const nested of (error as { issues: ValidationIssue[] }).issues) {
      issues.push({
        ...nested,
        path: nested.path.length === 0 ? basePath : `${basePath}.${nested.path}`,
      })
    }
    return
  }
  issues.push(
    issue(basePath, 'invalid_type', error instanceof Error ? error.message : String(error))
  )
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message }
}

function throwIfIssues(issues: ValidationIssue[]): void {
  if (issues.length > 0) throw new AspcSharedAgentInspectionSchemaError(issues)
}
