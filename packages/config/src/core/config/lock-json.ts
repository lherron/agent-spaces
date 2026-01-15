/**
 * Lock file (asp-lock.json) parser
 */

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import { validateLockFile } from '../schemas/index.js'
import type { LockFile } from '../types/lock.js'

/** Default filename for lock file */
export const LOCK_FILENAME = 'asp-lock.json'

/**
 * Parse an asp-lock.json file content into a validated LockFile
 *
 * @param content - Raw JSON string content
 * @param filePath - Path to the file (for error messages)
 * @returns Validated LockFile
 * @throws ConfigParseError if JSON parsing fails
 * @throws ConfigValidationError if schema validation fails
 */
export function parseLockJson(content: string, filePath?: string): LockFile {
  const source = filePath ?? LOCK_FILENAME

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigParseError(`Failed to parse JSON: ${message}`, source)
  }

  // Validate against schema
  const result = validateLockFile(parsed)
  if (!result.valid) {
    throw new ConfigValidationError('Invalid asp-lock.json', source, result.errors)
  }

  return result.data
}

/**
 * Read and parse an asp-lock.json file from disk
 *
 * @param filePath - Path to the asp-lock.json file
 * @returns Validated LockFile
 */
export async function readLockJson(filePath: string): Promise<LockFile> {
  const file = Bun.file(filePath)

  if (!(await file.exists())) {
    throw new ConfigParseError('File not found', filePath)
  }

  const content = await file.text()
  return parseLockJson(content, filePath)
}

/**
 * Check if a lock file exists at the given path
 *
 * @param filePath - Path to check
 * @returns true if the lock file exists
 */
export async function lockFileExists(filePath: string): Promise<boolean> {
  const file = Bun.file(filePath)
  return file.exists()
}

/**
 * Serialize a LockFile to JSON string (pretty-printed)
 *
 * @param lock - LockFile to serialize
 * @returns Pretty-printed JSON string
 */
export function serializeLockJson(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`
}
