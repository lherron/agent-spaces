/**
 * Project manifest (asp-targets.toml) parser
 */

import { readFile } from 'node:fs/promises'
import TOML from '@iarna/toml'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import { validateProjectManifest } from '../schemas/index.js'
import type { ProjectManifest } from '../types/targets.js'

/** Default filename for project manifest */
export const TARGETS_FILENAME = 'asp-targets.toml'

/**
 * Parse an asp-targets.toml file content into a validated ProjectManifest
 *
 * @param content - Raw TOML string content
 * @param filePath - Path to the file (for error messages)
 * @returns Validated ProjectManifest
 * @throws ConfigParseError if TOML parsing fails
 * @throws ConfigValidationError if schema validation fails
 */
export function parseTargetsToml(content: string, filePath?: string): ProjectManifest {
  const source = filePath ?? TARGETS_FILENAME

  // Parse TOML
  let parsed: unknown
  try {
    parsed = TOML.parse(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigParseError(`Failed to parse TOML: ${message}`, source)
  }

  // Validate against schema
  const result = validateProjectManifest(parsed)
  if (!result.valid) {
    throw new ConfigValidationError('Invalid asp-targets.toml', source, result.errors)
  }

  return result.data
}

/**
 * Read and parse an asp-targets.toml file from disk
 *
 * @param filePath - Path to the asp-targets.toml file
 * @returns Validated ProjectManifest
 */
export async function readTargetsToml(filePath: string): Promise<ProjectManifest> {
  try {
    const content = await readFile(filePath, 'utf8')
    return parseTargetsToml(content, filePath)
  } catch (err) {
    if (err instanceof ConfigParseError || err instanceof ConfigValidationError) {
      throw err
    }
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new ConfigParseError('File not found', filePath)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigParseError(`Failed to read file: ${message}`, filePath)
  }
}

/**
 * Serialize a ProjectManifest to TOML string
 *
 * @param manifest - ProjectManifest to serialize
 * @returns TOML string
 */
export function serializeTargetsToml(manifest: ProjectManifest): string {
  const clean = JSON.parse(JSON.stringify(manifest))
  return TOML.stringify(clean)
}

/** Result of validating an ASP target */
export interface ValidateTargetResult {
  /** Whether the target is valid */
  valid: boolean
  /** Error message if invalid */
  error?: string | undefined
  /** The project manifest if successfully loaded */
  manifest?: ProjectManifest | undefined
  /** Available target names (for error messages) */
  availableTargets?: string[] | undefined
}

/**
 * Validate that an ASP target exists and is valid in a directory
 *
 * @param directory - Path to the project directory
 * @param targetName - Name of the target to validate
 * @returns Validation result
 */
export async function validateTarget(
  directory: string,
  targetName: string
): Promise<ValidateTargetResult> {
  const { join } = await import('node:path')
  const targetsPath = join(directory, TARGETS_FILENAME)

  // Try to read and parse asp-targets.toml
  let manifest: ProjectManifest
  try {
    manifest = await readTargetsToml(targetsPath)
  } catch (err) {
    if (err instanceof ConfigParseError) {
      return { valid: false, error: err.message }
    }
    if (err instanceof ConfigValidationError) {
      const msgs = err.validationErrors.map((e) => `${e.path}: ${e.message}`).join(', ')
      return { valid: false, error: `Invalid asp-targets.toml: ${msgs}` }
    }
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { valid: false, error: `No asp-targets.toml found in ${directory}` }
    }
    return { valid: false, error: `Failed to read asp-targets.toml: ${err}` }
  }

  // Check if target exists
  const availableTargets = Object.keys(manifest.targets)
  if (!manifest.targets[targetName]) {
    return {
      valid: false,
      error: `Target "${targetName}" not found in asp-targets.toml`,
      manifest,
      availableTargets,
    }
  }

  return { valid: true, manifest, availableTargets }
}
