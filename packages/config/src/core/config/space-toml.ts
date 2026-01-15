/**
 * Space manifest (space.toml) parser
 */

import { readFile } from 'node:fs/promises'
import TOML from '@iarna/toml'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import { validateSpaceManifest } from '../schemas/index.js'
import type { SpaceManifest } from '../types/space.js'

/**
 * Parse a space.toml file content into a validated SpaceManifest
 *
 * @param content - Raw TOML string content
 * @param filePath - Path to the file (for error messages)
 * @returns Validated SpaceManifest
 * @throws ConfigParseError if TOML parsing fails
 * @throws ConfigValidationError if schema validation fails
 */
export function parseSpaceToml(content: string, filePath?: string): SpaceManifest {
  const source = filePath ?? 'space.toml'

  // Parse TOML
  let parsed: unknown
  try {
    parsed = TOML.parse(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigParseError(`Failed to parse TOML: ${message}`, source)
  }

  // Validate against schema
  const result = validateSpaceManifest(parsed)
  if (!result.valid) {
    throw new ConfigValidationError('Invalid space.toml', source, result.errors)
  }

  return result.data
}

/**
 * Read and parse a space.toml file from disk
 *
 * @param filePath - Path to the space.toml file
 * @returns Validated SpaceManifest
 */
export async function readSpaceToml(filePath: string): Promise<SpaceManifest> {
  try {
    const content = await readFile(filePath, 'utf8')
    return parseSpaceToml(content, filePath)
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
 * Serialize a SpaceManifest to TOML string
 *
 * @param manifest - SpaceManifest to serialize
 * @returns TOML string
 */
export function serializeSpaceToml(manifest: SpaceManifest): string {
  // TOML.stringify expects a JSON-compatible object
  // We need to ensure the manifest is clean
  const clean = JSON.parse(JSON.stringify(manifest))
  return TOML.stringify(clean)
}
