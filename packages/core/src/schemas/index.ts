/**
 * JSON Schema validation for Agent Spaces v2 config files
 */

import Ajv from 'ajv'
import addFormats from 'ajv-formats'

import lockSchema from './lock.schema.json'
import spaceSchema from './space.schema.json'
import targetsSchema from './targets.schema.json'

import type { LockFile } from '../types/lock.js'
import type { SpaceManifest } from '../types/space.js'
import type { ProjectManifest } from '../types/targets.js'

// ============================================================================
// Ajv instance setup
// ============================================================================

const ajv = new Ajv({
  strict: true,
  allErrors: true,
  verbose: true,
})

addFormats(ajv)

// Compile validators
const validateSpaceSchema = ajv.compile<SpaceManifest>(spaceSchema)
const validateTargetsSchema = ajv.compile<ProjectManifest>(targetsSchema)
const validateLockSchema = ajv.compile<LockFile>(lockSchema)

// ============================================================================
// Validation result types
// ============================================================================

export interface ValidationError {
  path: string
  message: string
  keyword: string
  params: Record<string, unknown>
}

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: ValidationError[] }

// ============================================================================
// Validation functions
// ============================================================================

function formatErrors(errors: typeof validateSpaceSchema.errors): ValidationError[] {
  if (!errors) return []

  return errors.map((err) => ({
    path: err.instancePath || '/',
    message: err.message || 'Unknown error',
    keyword: err.keyword,
    params: err.params as Record<string, unknown>,
  }))
}

/**
 * Validate a space manifest (space.toml parsed to object)
 */
export function validateSpaceManifest(data: unknown): ValidationResult<SpaceManifest> {
  if (validateSpaceSchema(data)) {
    return { valid: true, data }
  }
  return { valid: false, errors: formatErrors(validateSpaceSchema.errors) }
}

/**
 * Validate a project manifest (asp-targets.toml parsed to object)
 */
export function validateProjectManifest(data: unknown): ValidationResult<ProjectManifest> {
  if (validateTargetsSchema(data)) {
    return { valid: true, data }
  }
  return { valid: false, errors: formatErrors(validateTargetsSchema.errors) }
}

/**
 * Validate a lock file (asp-lock.json parsed to object)
 */
export function validateLockFile(data: unknown): ValidationResult<LockFile> {
  if (validateLockSchema(data)) {
    return { valid: true, data }
  }
  return { valid: false, errors: formatErrors(validateLockSchema.errors) }
}

// ============================================================================
// Schema exports for external use
// ============================================================================

export { lockSchema, spaceSchema, targetsSchema }
