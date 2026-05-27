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
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'string') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

export function requireNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a finite number`))
  }
}

export function requireTrue(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    issues.push(issue(basePath, 'required', `${basePath} is required`))
  } else if (value !== true) {
    issues.push(issue(basePath, 'invalid_literal', `${basePath} must be true`))
  }
}

export function requirePayloadRecord(
  value: unknown,
  issues: ValidationIssue[]
): SchemaRecord | undefined {
  const payload = asRecord(value)
  if (!payload) {
    issues.push(issue('payload', 'invalid_type', 'payload must be an object'))
    return undefined
  }
  return payload
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
        value === undefined ? 'required' : 'invalid_type',
        `${basePath} must be an array`
      )
    )
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push(
        issue(path(basePath, String(index)), 'invalid_type', 'array item must be a string')
      )
    }
  })
}

export function optionalString(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a string`))
  }
}

export function optionalNumber(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a finite number`))
  }
}

export function optionalBoolean(value: unknown, basePath: string, issues: ValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'boolean') {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be a boolean`))
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
  if (!Array.isArray(value)) {
    issues.push(issue(basePath, 'invalid_type', `${basePath} must be an array`))
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push(
        issue(path(basePath, String(index)), 'invalid_type', 'array item must be a string')
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
      issues.push(issue(basePath, 'required', `${basePath} is required`))
    }
    return
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(issue(basePath, 'invalid_literal', `${basePath} has an unsupported value`))
  }
}

export function asRecord(value: unknown): SchemaRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined
}

export function path(prefix: string, suffix: string): string {
  return prefix.length === 0 ? suffix : `${prefix}.${suffix}`
}

export function issue(pathValue: string, code: string, message: string): ValidationIssue {
  return { path: pathValue, code, message }
}
