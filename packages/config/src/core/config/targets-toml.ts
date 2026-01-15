/**
 * Project manifest (asp-targets.toml) parser
 */

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
  const file = Bun.file(filePath)

  if (!(await file.exists())) {
    throw new ConfigParseError('File not found', filePath)
  }

  const content = await file.text()
  return parseTargetsToml(content, filePath)
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
