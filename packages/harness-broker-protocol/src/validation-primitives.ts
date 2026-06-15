/**
 * Generic, DTO-agnostic validation primitives used by the hand-rolled protocol
 * validators in schemas.ts. These accumulate {@link ValidationIssue}s rather
 * than throwing.
 *
 * Extracted from schemas.ts (behavior-preserving). Not part of the public
 * package surface — schemas.ts imports these internally.
 */

import type { SchemaRecord, ValidationIssue } from './schemas.js'

export function requireString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'string') {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

export function requireNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be a finite number`))
  }
}

export function requireTrue(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
  } else if (value !== true) {
    issues.push(makeIssue(basePath, 'invalid_literal', `${basePath} must be true`))
  }
}

export function requirePayloadRecord(
  value: unknown,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const payload = asRecord(value)
  if (!payload) {
    issues.push(makeIssue('payload', 'invalid_type', 'payload must be an object'))
    return undefined
  }
  return payload
}

/**
 * Guard that `value` is an array, pushing a `required` (when `undefined`) or
 * `invalid_type` issue otherwise. Returns the array on success, or `undefined`
 * so callers can early-return. The "required vs invalid_type" distinction and
 * `must be an array` message wording match the per-validator copies this
 * deduplicates; the message is parameterized because one caller wants a fixed
 * literal rather than the `basePath`-derived form.
 */
export function requireArray(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[],
  message = `${basePath} must be an array`
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(makeIssue(basePath, value === undefined ? 'required' : 'invalid_type', message))
    return undefined
  }
  return value
}

export function requireStringArray(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  const items = requireArray(value, basePath, issues)
  if (!items) {
    return
  }
  items.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push(
        makeIssue(joinPath(basePath, String(index)), 'invalid_type', 'array item must be a string')
      )
    }
  })
}

export function optionalString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

export function optionalNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be a finite number`))
  }
}

/**
 * Like {@link optionalNumber} but additionally accepts `null`. Names the
 * "exit-code-shaped nullable number" contract (`number | null | undefined`)
 * once; other types still fail with `invalid_type`.
 */
export function optionalNumberOrNull(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === null) {
    return
  }
  optionalNumber(value, basePath, issues)
}

export function optionalBoolean(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'boolean') {
    issues.push(makeIssue(basePath, 'invalid_type', `${basePath} must be a boolean`))
  }
}

export function optionalStringArray(
  value: unknown,
  basePath: string,
  issues: ValidationIssue[]
): void {
  if (value === undefined) {
    return
  }
  const items = requireArray(value, basePath, issues)
  if (!items) {
    return
  }
  items.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push(
        makeIssue(joinPath(basePath, String(index)), 'invalid_type', 'array item must be a string')
      )
    }
  })
}

export function optionalEnum(
  value: unknown,
  allowed: string[],
  basePath: string,
  issues: ValidationIssue[],
  required = false
): void {
  if (value === undefined) {
    if (required) {
      issues.push(makeIssue(basePath, 'required', `${basePath} is required`))
    }
    return
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(makeIssue(basePath, 'invalid_literal', `${basePath} has an unsupported value`))
  }
}

export function asRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

/**
 * Join a path prefix and a suffix segment with a `.`, omitting the separator
 * when the prefix is empty. Named `joinPath` (not `path`) so it never shadows
 * Node's `path` module in importing modules.
 */
export function joinPath(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : `${prefix}.${suffix}`
}

/**
 * Construct a {@link ValidationIssue}. Named `makeIssue` (not `issue`) to avoid
 * an overly generic single-word export name leaking into importing modules.
 */
export function makeIssue(pathValue: string, code: string, message: string): ValidationIssue {
  return { path: pathValue, code, message }
}
