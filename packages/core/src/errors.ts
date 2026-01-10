/**
 * Typed error classes for Agent Spaces v2
 *
 * Error hierarchy:
 * - AspError (base)
 *   - ConfigError (configuration issues)
 *     - ConfigParseError (TOML/JSON parse failures)
 *     - ConfigValidationError (schema validation failures)
 *   - ResolutionError (resolution failures)
 *     - RefParseError (invalid space ref syntax)
 *     - SelectorResolutionError (selector cannot be resolved)
 *     - CyclicDependencyError (circular deps detected)
 *     - MissingDependencyError (dep not found)
 *   - StoreError (store operations)
 *     - IntegrityError (hash mismatch)
 *     - SnapshotError (snapshot extraction failed)
 *   - MaterializationError (plugin generation)
 *   - LockError (file locking)
 *   - GitError (git operations)
 *   - ClaudeError (claude invocation)
 */

import type { ValidationError } from './schemas/index.js'

/** Base error class for all Agent Spaces errors */
export class AspError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'AspError'
    this.code = code
    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace?.(this, this.constructor)
  }
}

// ============================================================================
// Configuration errors
// ============================================================================

/** Base class for configuration-related errors */
export class ConfigError extends AspError {
  readonly source: string

  constructor(message: string, code: string, source: string) {
    super(message, code)
    this.name = 'ConfigError'
    this.source = source
  }
}

/** Error thrown when TOML/JSON parsing fails */
export class ConfigParseError extends ConfigError {
  constructor(message: string, source: string) {
    super(message, 'CONFIG_PARSE_ERROR', source)
    this.name = 'ConfigParseError'
  }
}

/** Error thrown when schema validation fails */
export class ConfigValidationError extends ConfigError {
  readonly validationErrors: ValidationError[]

  constructor(message: string, source: string, validationErrors: ValidationError[]) {
    const details = validationErrors.map((e) => `  ${e.path}: ${e.message}`).join('\n')
    super(`${message}:\n${details}`, 'CONFIG_VALIDATION_ERROR', source)
    this.name = 'ConfigValidationError'
    this.validationErrors = validationErrors
  }
}

// ============================================================================
// Resolution errors
// ============================================================================

/** Base class for resolution-related errors */
export class ResolutionError extends AspError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'ResolutionError'
  }
}

/** Error thrown when a space ref cannot be parsed */
export class RefParseError extends ResolutionError {
  readonly refString: string

  constructor(message: string, refString: string) {
    super(`${message}: "${refString}"`, 'REF_PARSE_ERROR')
    this.name = 'RefParseError'
    this.refString = refString
  }
}

/** Error thrown when a selector cannot be resolved to a commit */
export class SelectorResolutionError extends ResolutionError {
  readonly spaceId: string
  readonly selector: string

  constructor(message: string, spaceId: string, selector: string) {
    super(`${message}: space:${spaceId}@${selector}`, 'SELECTOR_RESOLUTION_ERROR')
    this.name = 'SelectorResolutionError'
    this.spaceId = spaceId
    this.selector = selector
  }
}

/** Error thrown when cyclic dependencies are detected */
export class CyclicDependencyError extends ResolutionError {
  readonly cycle: string[]

  constructor(cycle: string[]) {
    const cycleStr = cycle.join(' -> ')
    super(`Cyclic dependency detected: ${cycleStr}`, 'CYCLIC_DEPENDENCY_ERROR')
    this.name = 'CyclicDependencyError'
    this.cycle = cycle
  }
}

/** Error thrown when a dependency cannot be found */
export class MissingDependencyError extends ResolutionError {
  readonly spaceId: string
  readonly dependsOn: string

  constructor(spaceId: string, dependsOn: string) {
    super(`Space "${spaceId}" depends on missing space: "${dependsOn}"`, 'MISSING_DEPENDENCY_ERROR')
    this.name = 'MissingDependencyError'
    this.spaceId = spaceId
    this.dependsOn = dependsOn
  }
}

// ============================================================================
// Store errors
// ============================================================================

/** Base class for store-related errors */
export class StoreError extends AspError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'StoreError'
  }
}

/** Error thrown when integrity verification fails */
export class IntegrityError extends StoreError {
  readonly expected: string
  readonly actual: string
  readonly path: string

  constructor(path: string, expected: string, actual: string) {
    super(
      `Integrity mismatch for "${path}": expected ${expected}, got ${actual}`,
      'INTEGRITY_ERROR'
    )
    this.name = 'IntegrityError'
    this.path = path
    this.expected = expected
    this.actual = actual
  }
}

/** Error thrown when snapshot extraction fails */
export class SnapshotError extends StoreError {
  readonly spaceId: string
  readonly commit: string

  constructor(message: string, spaceId: string, commit: string) {
    super(`Snapshot failed for ${spaceId}@${commit}: ${message}`, 'SNAPSHOT_ERROR')
    this.name = 'SnapshotError'
    this.spaceId = spaceId
    this.commit = commit
  }
}

// ============================================================================
// Materialization errors
// ============================================================================

/** Error thrown during plugin materialization */
export class MaterializationError extends AspError {
  readonly spaceId: string

  constructor(message: string, spaceId: string) {
    super(`Materialization failed for "${spaceId}": ${message}`, 'MATERIALIZATION_ERROR')
    this.name = 'MaterializationError'
    this.spaceId = spaceId
  }
}

// ============================================================================
// Lock errors
// ============================================================================

/** Error thrown during file locking operations */
export class LockError extends AspError {
  readonly lockPath: string

  constructor(message: string, lockPath: string) {
    super(`Lock error for "${lockPath}": ${message}`, 'LOCK_ERROR')
    this.name = 'LockError'
    this.lockPath = lockPath
  }
}

/** Error thrown when lock acquisition times out */
export class LockTimeoutError extends LockError {
  readonly timeout: number

  constructor(lockPath: string, timeout: number) {
    super(`Timed out after ${timeout}ms`, lockPath)
    this.name = 'LockTimeoutError'
    this.timeout = timeout
  }
}

// ============================================================================
// Git errors
// ============================================================================

/** Error thrown during git operations */
export class GitError extends AspError {
  readonly command: string
  readonly exitCode: number
  readonly stderr: string

  constructor(command: string, exitCode: number, stderr: string) {
    super(`Git command failed (exit ${exitCode}): ${command}\n${stderr}`, 'GIT_ERROR')
    this.name = 'GitError'
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

// ============================================================================
// Claude errors
// ============================================================================

/** Error thrown during Claude CLI operations */
export class ClaudeError extends AspError {
  constructor(message: string, code = 'CLAUDE_ERROR') {
    super(message, code)
    this.name = 'ClaudeError'
  }
}

/** Error thrown when Claude binary is not found */
export class ClaudeNotFoundError extends ClaudeError {
  constructor(searchedPaths: string[]) {
    super(`Claude CLI not found. Searched: ${searchedPaths.join(', ')}`, 'CLAUDE_NOT_FOUND_ERROR')
    this.name = 'ClaudeNotFoundError'
  }
}

/** Error thrown when Claude invocation fails */
export class ClaudeInvocationError extends ClaudeError {
  readonly exitCode: number
  readonly stderr: string

  constructor(exitCode: number, stderr: string) {
    super(`Claude exited with code ${exitCode}: ${stderr}`, 'CLAUDE_INVOCATION_ERROR')
    this.name = 'ClaudeInvocationError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

// ============================================================================
// Type guards
// ============================================================================

export function isAspError(error: unknown): error is AspError {
  return error instanceof AspError
}

export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError
}

export function isResolutionError(error: unknown): error is ResolutionError {
  return error instanceof ResolutionError
}

export function isStoreError(error: unknown): error is StoreError {
  return error instanceof StoreError
}

export function isGitError(error: unknown): error is GitError {
  return error instanceof GitError
}

export function isClaudeError(error: unknown): error is ClaudeError {
  return error instanceof ClaudeError
}
