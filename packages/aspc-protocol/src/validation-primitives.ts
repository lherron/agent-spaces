import type { ValidationIssue } from 'spaces-harness-broker-protocol'

/**
 * Generic, ASPC-agnostic validation primitives shared by the request/command
 * validators in {@link ./schemas.ts}. These are intentionally module-internal
 * (not re-exported from the package index): they encode low-level type checks
 * and issue-accumulation conventions, not the public protocol surface.
 *
 * Convention: each helper appends to a caller-owned `issues` array and uses
 * `basePath` for dotted-path issue locations.
 */

export type SchemaRecord = Record<string, unknown>

/**
 * Shared issue `code` literals so producers reference one canonical set instead
 * of repeating bare strings throughout the validators.
 */
export const ISSUE_CODE = {
  required: 'required',
  invalidType: 'invalid_type',
  invalidLiteral: 'invalid_literal',
  unsupportedProtocol: 'unsupported_protocol',
} as const

/**
 * Coerces `value` to a record, *pushing a validation issue* when it is not an
 * object. Contrast with {@link coerceRecord}, which is silent. Returns the
 * record on success, `undefined` (with an issue recorded) otherwise.
 */
export function requireRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const object = coerceRecord(value)
  if (object === undefined) {
    issues.push(
      issue(
        basePath,
        value === undefined ? ISSUE_CODE.required : ISSUE_CODE.invalidType,
        `${basePath} must be an object`
      )
    )
    return undefined
  }
  return object
}

/**
 * Silently coerces `value` to a record, returning `undefined` when it is not a
 * plain object. Contrast with {@link requireRecord}, which records an issue.
 */
export function coerceRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

export function requireString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, ISSUE_CODE.required, `${basePath} is required`))
  } else if (typeof value !== 'string') {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a string`))
  }
}

export function optionalString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a string`))
  }
}

export function requireStringArray(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    issues.push(
      issue(
        basePath,
        value === undefined ? ISSUE_CODE.required : ISSUE_CODE.invalidType,
        `${basePath} must be an array`
      )
    )
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      const itemPath = path(basePath, String(index))
      issues.push(issue(itemPath, ISSUE_CODE.invalidType, `${itemPath} must be a string`))
    }
  })
}

export function requireLiteral(
  value: unknown,
  expected: string,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    issues.push(issue(basePath, ISSUE_CODE.required, `${basePath} is required`))
  } else if (value !== expected) {
    issues.push(issue(basePath, ISSUE_CODE.invalidLiteral, `${basePath} must be ${expected}`))
  }
}

export function path(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : `${prefix}.${suffix}`
}

export function issue(pathValue: string, code: string, message: string): ValidationIssue {
  return { path: pathValue, code, message }
}
