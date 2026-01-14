/**
 * Claude settings composition.
 *
 * WHY: Spaces can declare Claude settings that should be applied when
 * running Claude. We compose these into a single settings.json file.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpaceSettings } from 'spaces-core'
import { ensureDir } from 'spaces-store'

/**
 * Composed Claude settings structure.
 * This matches the Claude Code settings.json format.
 */
export interface ComposedSettings {
  /** Permission rules */
  permissions?:
    | {
        allow?: string[] | undefined
        deny?: string[] | undefined
      }
    | undefined
  /** Environment variables */
  env?: Record<string, string> | undefined
  /** Model override */
  model?: string | undefined
}

/**
 * Input for settings composition - space settings with metadata.
 */
export interface SettingsInput {
  /** Space ID for error messages */
  spaceId: string
  /** Settings from the space manifest */
  settings: SpaceSettings
}

/**
 * Compose multiple space settings into one.
 *
 * Composition rules:
 * - permissions.allow: arrays are concatenated (all allow rules apply)
 * - permissions.deny: arrays are concatenated (all deny rules apply)
 * - env: later values override earlier ones for the same key
 * - model: last defined model wins
 */
export function composeSettings(inputs: SettingsInput[]): ComposedSettings {
  const composed: ComposedSettings = {}

  for (const { settings } of inputs) {
    // Compose permissions
    if (settings.permissions) {
      if (!composed.permissions) {
        composed.permissions = {}
      }

      // Concatenate allow rules
      if (settings.permissions.allow?.length) {
        composed.permissions.allow = [
          ...(composed.permissions.allow ?? []),
          ...settings.permissions.allow,
        ]
      }

      // Concatenate deny rules
      if (settings.permissions.deny?.length) {
        composed.permissions.deny = [
          ...(composed.permissions.deny ?? []),
          ...settings.permissions.deny,
        ]
      }
    }

    // Merge env (later values override)
    if (settings.env && Object.keys(settings.env).length > 0) {
      composed.env = {
        ...(composed.env ?? {}),
        ...settings.env,
      }
    }

    // Last model wins
    if (settings.model) {
      composed.model = settings.model
    }
  }

  return composed
}

/**
 * Check if composed settings are empty (no meaningful configuration).
 */
export function isEmptySettings(settings: ComposedSettings): boolean {
  const hasPermissions = settings.permissions?.allow?.length || settings.permissions?.deny?.length
  const hasEnv = settings.env && Object.keys(settings.env).length > 0
  const hasModel = !!settings.model

  return !hasPermissions && !hasEnv && !hasModel
}

/**
 * Write composed settings to a JSON file.
 */
export async function writeSettingsFile(
  settings: ComposedSettings,
  outputPath: string
): Promise<void> {
  await ensureDir(join(outputPath, '..'))
  await writeFile(outputPath, JSON.stringify(settings, null, 2))
}

/**
 * Compose settings from space manifests and write to output file.
 *
 * Always writes a settings.json file (even if empty) so that Claude
 * is always invoked with --settings for consistent behavior.
 *
 * @param inputs - Array of space settings with metadata
 * @param outputPath - Path to write the settings.json file
 * @returns The composed settings
 */
export async function composeSettingsFromSpaces(
  inputs: SettingsInput[],
  outputPath: string
): Promise<{ settings: ComposedSettings }> {
  // Filter to only spaces with settings
  const withSettings = inputs.filter(
    (input) => input.settings && Object.keys(input.settings).length > 0
  )

  const composed = composeSettings(withSettings)

  // Always write settings.json (even if empty)
  await writeSettingsFile(composed, outputPath)

  return { settings: composed }
}
