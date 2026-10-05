import type { ValidationIssue } from 'spaces-harness-broker-protocol'

/**
 * Generic, ASPC-agnostic validation primitives shared by the request/command
 * validators in {@link ./schemas.ts} and its params modules. These are intentionally module-internal
 * (not re-exported from the package index): they encode low-level type checks
 * and issue-accumulation conventions, not the public protocol surface.
 *
 * Convention: each helper appends to a caller-owned `issues` array and uses
 * `basePath` for dotted-path issue locations.
 */

export type SchemaRecord = Record<string, unknown>

/** Validates one params value, appending issues under `basePath`. */
export type ParamsValidator = (value: unknown, basePath: string, issues: ValidationIssue[]) => void

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
function coerceRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

/**
 * Requires that each named field of `parent` is a present object, recording one
 * issue per offending field via {@link requireRecord}. Fields are checked in the
 * given array order, producing the same per-field issues (and ordering) as the
 * equivalent sequence of inline `requireRecord` calls.
 */
export function requireRecordFields(
  parent: SchemaRecord,
  basePath: string,
  fields: readonly string[],
  issues: ValidationIssue[]
): void {
  for (const field of fields) {
    requireRecord(parent[field], path(basePath, field), issues)
  }
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

export function requireEnum(
  value: unknown,
  allowed: readonly string[],
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(
      issue(
        basePath,
        ISSUE_CODE.invalidLiteral,
        `${basePath} must be one of: ${allowed.join(', ')}`
      )
    )
  }
}

/** Like {@link requireEnum}, but accepts an absent value. */
export function optionalEnum(
  value: unknown,
  allowed: readonly string[],
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value !== undefined) requireEnum(value, allowed, basePath, issues)
}

export function optionalNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a finite number`))
  }
}

export function optionalBoolean(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'boolean') {
    issues.push(issue(basePath, ISSUE_CODE.invalidType, `${basePath} must be a boolean`))
  }
}

/** {@link requireRecord} for an optional field: absent → `undefined`, no issue. */
export function optionalRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  return value === undefined ? undefined : requireRecord(value, basePath, issues)
}

/** Records one `forbidden_input` issue per key of `params` outside `allowed`. */
export function rejectUnknownParams(
  params: SchemaRecord,
  allowed: ReadonlySet<string>,
  basePath: string,
  issues: ValidationIssue[]
): void {
  for (const key of Object.keys(params)) {
    if (allowed.has(key)) continue
    issues.push(
      issue(path(basePath, key), 'forbidden_input', `${path(basePath, key)} is not accepted`)
    )
  }
}

const PRIMITIVE_ITEM_CHECKS = {
  boolean: (item: unknown) => typeof item === 'boolean',
  string: (item: unknown) => typeof item === 'string',
} as const

/**
 * Validates that an optional `value` is a record whose entries all match the
 * given primitive type. Absent values are accepted; a non-record records a
 * single issue and skips entry checks; each off-type entry records its own
 * indexed issue.
 */
function validateOptionalPrimitiveRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  itemType: keyof typeof PRIMITIVE_ITEM_CHECKS
): void {
  if (value === undefined) return
  const object = requireRecord(value, basePath, issues)
  if (object === undefined) return
  for (const [key, item] of Object.entries(object)) {
    if (!PRIMITIVE_ITEM_CHECKS[itemType](item)) {
      const itemPath = path(basePath, key)
      issues.push(issue(itemPath, ISSUE_CODE.invalidType, `${itemPath} must be a ${itemType}`))
    }
  }
}

export function validateOptionalBooleanRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateOptionalPrimitiveRecord(value, basePath, issues, 'boolean')
}

export function validateOptionalStringRecord(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  validateOptionalPrimitiveRecord(value, basePath, issues, 'string')
}
