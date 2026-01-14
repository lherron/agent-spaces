/**
 * Generate .claude-plugin/plugin.json from space manifest.
 *
 * WHY: Claude Code expects plugins to have a specific structure with
 * plugin.json defining the plugin identity and metadata.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpaceManifest } from 'spaces-core'
import { derivePluginIdentity } from 'spaces-core'

/**
 * Plugin.json structure expected by Claude Code.
 */
export interface PluginJson {
  /** Plugin name (kebab-case) */
  name: string
  /** Plugin version (semver) */
  version?: string | undefined
  /** Plugin description */
  description?: string | undefined
  /** Author information */
  author?:
    | {
        name?: string | undefined
        email?: string | undefined
        url?: string | undefined
      }
    | undefined
  /** Homepage URL */
  homepage?: string | undefined
  /** Repository URL */
  repository?: string | undefined
  /** License identifier */
  license?: string | undefined
  /** Keywords for discovery */
  keywords?: string[] | undefined
}

/**
 * Generate plugin.json content from a space manifest.
 */
export function generatePluginJson(manifest: SpaceManifest): PluginJson {
  const identity = derivePluginIdentity(manifest)

  const pluginJson: PluginJson = {
    name: identity.name,
  }

  // Add optional fields only if defined
  if (identity.version !== undefined) {
    pluginJson.version = identity.version
  }

  const desc = manifest.plugin?.description ?? manifest.description
  if (desc !== undefined) {
    pluginJson.description = desc
  }

  if (manifest.plugin?.author !== undefined) {
    pluginJson.author = {}
    if (manifest.plugin.author.name !== undefined) {
      pluginJson.author.name = manifest.plugin.author.name
    }
    if (manifest.plugin.author.email !== undefined) {
      pluginJson.author.email = manifest.plugin.author.email
    }
    if (manifest.plugin.author.url !== undefined) {
      pluginJson.author.url = manifest.plugin.author.url
    }
  }

  if (manifest.plugin?.homepage !== undefined) {
    pluginJson.homepage = manifest.plugin.homepage
  }

  if (manifest.plugin?.repository !== undefined) {
    pluginJson.repository = manifest.plugin.repository
  }

  if (manifest.plugin?.license !== undefined) {
    pluginJson.license = manifest.plugin.license
  }

  if (manifest.plugin?.keywords !== undefined && manifest.plugin.keywords.length > 0) {
    pluginJson.keywords = manifest.plugin.keywords
  }

  return pluginJson
}

/**
 * Write plugin.json to the output directory.
 */
export async function writePluginJson(manifest: SpaceManifest, outputDir: string): Promise<void> {
  const pluginDir = join(outputDir, '.claude-plugin')
  await mkdir(pluginDir, { recursive: true })

  const pluginJson = generatePluginJson(manifest)
  const jsonPath = join(pluginDir, 'plugin.json')

  await writeFile(jsonPath, JSON.stringify(pluginJson, null, 2))
}

/**
 * Get the path where plugin.json should be written.
 */
export function getPluginJsonPath(outputDir: string): string {
  return join(outputDir, '.claude-plugin', 'plugin.json')
}
