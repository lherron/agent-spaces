/**
 * Resolution validation - detect structural errors.
 *
 * WHY: Validation catches configuration issues early.
 * This module focuses on errors (not warnings - those are in lint package).
 */

import type { LockFile, ProjectManifest, SpaceKey, SpaceManifest } from 'spaces-core'
import { isSpaceRefString, parseSpaceRef } from 'spaces-core'
import type { ClosureResult } from './closure.js'

/**
 * Validation error with details.
 */
export interface ValidationError {
  /** Error code */
  code: string
  /** Human-readable message */
  message: string
  /** Related space or target */
  subject?: string | undefined
  /** Additional details */
  details?: Record<string, unknown> | undefined
}

/**
 * Validation result.
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean
  /** Errors found */
  errors: ValidationError[]
}

// ============================================================================
// Space Ref Validation Helpers
// ============================================================================

/**
 * Validate a list of space references.
 */
function validateSpaceRefs(
  refs: string[],
  errorCode: string,
  subject: string | undefined,
  errors: ValidationError[]
): void {
  for (const ref of refs) {
    if (!isSpaceRefString(ref)) {
      errors.push({
        code: errorCode,
        message: `Invalid space reference: ${ref}`,
        subject,
      })
      continue
    }
    try {
      parseSpaceRef(ref)
    } catch (err) {
      errors.push({
        code: errorCode,
        message: `Failed to parse space reference '${ref}': ${err instanceof Error ? err.message : String(err)}`,
        subject,
      })
    }
  }
}

/**
 * Validate a space manifest structure.
 */
export function validateSpaceManifest(manifest: SpaceManifest): ValidationResult {
  const errors: ValidationError[] = []

  // Check required fields
  if (!manifest.id) {
    errors.push({
      code: 'E001',
      message: "Space manifest missing required 'id' field",
    })
  }

  // Validate space refs in deps
  if (manifest.deps?.spaces) {
    validateSpaceRefs(manifest.deps.spaces, 'E002', manifest.id, errors)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Validate a single target in a project manifest.
 */
function validateTarget(
  name: string,
  target: ProjectManifest['targets'][string],
  errors: ValidationError[]
): void {
  // Check compose is non-empty
  if (!target.compose || target.compose.length === 0) {
    errors.push({
      code: 'E011',
      message: `Target '${name}' has empty compose list`,
      subject: name,
    })
    return
  }

  // Validate each compose ref
  validateSpaceRefs(target.compose, 'E012', name, errors)
}

/**
 * Validate a project manifest structure.
 */
export function validateProjectManifest(manifest: ProjectManifest): ValidationResult {
  const errors: ValidationError[] = []

  // Check targets exist
  if (!manifest.targets || Object.keys(manifest.targets).length === 0) {
    errors.push({
      code: 'E010',
      message: 'Project manifest has no targets defined',
    })
  }

  // Validate each target
  for (const [name, target] of Object.entries(manifest.targets ?? {})) {
    validateTarget(name, target, errors)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ============================================================================
// Closure Validation Helpers
// ============================================================================

/**
 * Check all roots are present in the closure spaces.
 */
function validateClosureRoots(closure: ClosureResult, errors: ValidationError[]): void {
  for (const root of closure.roots) {
    if (!closure.spaces.has(root)) {
      errors.push({
        code: 'E020',
        message: `Root space '${root}' not found in closure`,
        subject: root,
      })
    }
  }
}

/**
 * Check all load order entries are present in closure spaces.
 */
function validateClosureLoadOrder(closure: ClosureResult, errors: ValidationError[]): void {
  for (const key of closure.loadOrder) {
    if (!closure.spaces.has(key)) {
      errors.push({
        code: 'E021',
        message: `Load order entry '${key}' not found in closure`,
        subject: key,
      })
    }
  }
}

/**
 * Check all dependencies are present in closure spaces.
 */
function validateClosureDeps(closure: ClosureResult, errors: ValidationError[]): void {
  for (const [key, space] of closure.spaces) {
    for (const dep of space.deps) {
      if (!closure.spaces.has(dep)) {
        errors.push({
          code: 'E022',
          message: `Dependency '${dep}' of space '${key}' not found in closure`,
          subject: key,
          details: { dependency: dep },
        })
      }
    }
  }
}

/**
 * Check load order respects dependency ordering.
 */
function validateLoadOrderDependencies(closure: ClosureResult, errors: ValidationError[]): void {
  const loadOrderIndex = new Map<SpaceKey, number>()
  closure.loadOrder.forEach((key, index) => {
    loadOrderIndex.set(key, index)
  })

  for (const [key, space] of closure.spaces) {
    const keyIndex = loadOrderIndex.get(key)
    if (keyIndex === undefined) continue

    for (const dep of space.deps) {
      const depIndex = loadOrderIndex.get(dep)
      if (depIndex === undefined) continue

      if (depIndex >= keyIndex) {
        errors.push({
          code: 'E023',
          message: `Dependency order violation: '${dep}' appears after '${key}' in load order`,
          subject: key,
          details: { dependency: dep, keyIndex, depIndex },
        })
      }
    }
  }
}

/**
 * Validate a closure result for structural issues.
 */
export function validateClosure(closure: ClosureResult): ValidationResult {
  const errors: ValidationError[] = []

  validateClosureRoots(closure, errors)
  validateClosureLoadOrder(closure, errors)
  validateClosureDeps(closure, errors)
  validateLoadOrderDependencies(closure, errors)

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ============================================================================
// Lock File Validation Helpers
// ============================================================================

/**
 * Validate a single target's space references in lock file.
 */
function validateLockTarget(
  targetName: string,
  target: LockFile['targets'][string],
  lock: LockFile,
  errors: ValidationError[]
): void {
  for (const key of target.loadOrder) {
    if (!lock.spaces[key]) {
      errors.push({
        code: 'E031',
        message: `Target '${targetName}' references missing space: ${key}`,
        subject: targetName,
        details: { missingSpace: key },
      })
    }
  }

  for (const key of target.roots) {
    if (!lock.spaces[key]) {
      errors.push({
        code: 'E032',
        message: `Target '${targetName}' has missing root space: ${key}`,
        subject: targetName,
        details: { missingSpace: key },
      })
    }
  }
}

/**
 * Validate space dependency references in lock file.
 */
function validateLockSpaceDeps(lock: LockFile, errors: ValidationError[]): void {
  for (const [key, space] of Object.entries(lock.spaces)) {
    for (const dep of space.deps.spaces) {
      if (!lock.spaces[dep]) {
        errors.push({
          code: 'E033',
          message: `Space '${key}' references missing dependency: ${dep}`,
          subject: key,
          details: { missingDependency: dep },
        })
      }
    }
  }
}

/**
 * Validate a lock file structure.
 */
export function validateLockFile(lock: LockFile): ValidationResult {
  const errors: ValidationError[] = []

  // Check version
  if (lock.lockfileVersion !== 1) {
    errors.push({
      code: 'E030',
      message: `Unsupported lock file version: ${lock.lockfileVersion}`,
    })
  }

  // Validate all targets
  for (const [targetName, target] of Object.entries(lock.targets)) {
    validateLockTarget(targetName, target, lock, errors)
  }

  // Validate space dependencies
  validateLockSpaceDeps(lock, errors)

  return {
    valid: errors.length === 0,
    errors,
  }
}
