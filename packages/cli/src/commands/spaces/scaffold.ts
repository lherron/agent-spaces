/**
 * Shared space scaffold writer.
 *
 * WHY: `asp spaces init` and `asp repo new-space` must emit the same manifest
 * shape from one code path, with only the legacy example command toggled.
 */

import { mkdir } from 'node:fs/promises'

import { resolver } from 'spaces-config'

export interface SpaceScaffoldOptions {
  description?: string | undefined
  version?: string | undefined
  withExample?: boolean | undefined
}

export interface SpaceScaffoldResult {
  spaceDir: string
}

const SPACE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Validate space ID format.
 */
export function validateSpaceId(id: string): string | null {
  if (!id) {
    return 'Space ID is required'
  }
  if (id.length > 64) {
    return 'Space ID must be 64 characters or less'
  }
  if (!SPACE_ID_PATTERN.test(id)) {
    return 'Space ID must be kebab-case (lowercase letters, numbers, hyphens) and start with a letter'
  }
  return null
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Generate space.toml content.
 */
export function generateSpaceToml(id: string, options: SpaceScaffoldOptions = {}): string {
  const lines: string[] = ['schema = 1', `id = ${tomlString(id)}`]

  lines.push(`version = ${tomlString(options.version ?? '0.1.0')}`)

  if (options.description) {
    lines.push(`description = ${tomlString(options.description)}`)
  }

  lines.push('')
  lines.push('[plugin]')
  lines.push(`name = ${tomlString(id)}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Generate example command file.
 */
function generateExampleCommand(id: string): string {
  return `# Example Command

This is an example command for the ${id} space.

## Usage

Describe how to use this command.

## Execution Steps

1. First step
2. Second step
3. Final step
`
}

/**
 * Write the blessed space scaffold and validate the manifest that was written.
 */
export async function writeSpaceScaffold(
  repoPath: string,
  spaceId: string,
  options: SpaceScaffoldOptions = {}
): Promise<SpaceScaffoldResult> {
  const spaceDir = `${repoPath}/spaces/${spaceId}`

  await mkdir(spaceDir, { recursive: true })
  await mkdir(`${spaceDir}/commands`, { recursive: true })
  await mkdir(`${spaceDir}/skills`, { recursive: true })
  await mkdir(`${spaceDir}/agents`, { recursive: true })
  await mkdir(`${spaceDir}/hooks/scripts`, { recursive: true })
  await mkdir(`${spaceDir}/mcp`, { recursive: true })

  await Bun.write(`${spaceDir}/space.toml`, generateSpaceToml(spaceId, options))

  if (options.withExample) {
    await Bun.write(`${spaceDir}/commands/example.md`, generateExampleCommand(spaceId))
  }

  const manifest = await resolver.readSpaceManifestFromFilesystem(spaceId, { cwd: repoPath })
  const validation = resolver.validateSpaceManifest(manifest)
  if (!validation.valid) {
    throw new Error(
      `Invalid generated space manifest: ${validation.errors.map((error) => error.message).join(', ')}`
    )
  }

  return { spaceDir }
}
