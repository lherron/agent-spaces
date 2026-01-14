/**
 * W205: Plugin name collision detection.
 *
 * WHY: When multiple spaces produce the same plugin name, Claude may
 * load them incorrectly. We warn about this to prevent confusion.
 */

import { derivePluginIdentity } from 'spaces-core'
import type { LintContext, LintWarning, SpaceLintData } from '../types.js'
import { WARNING_CODES } from '../types.js'

/**
 * W205: Detect plugin name collisions across spaces.
 */
export function checkPluginNameCollisions(context: LintContext): LintWarning[] {
  const warnings: LintWarning[] = []

  // Map plugin name -> list of spaces that produce it
  const pluginOwners = new Map<string, SpaceLintData[]>()

  for (const space of context.spaces) {
    const identity = derivePluginIdentity(space.manifest)
    const pluginName = identity.name

    const owners = pluginOwners.get(pluginName) ?? []
    owners.push(space)
    pluginOwners.set(pluginName, owners)
  }

  // Report collisions
  for (const [pluginName, owners] of pluginOwners) {
    if (owners.length > 1) {
      const spaceIds = owners.map((s) => String(s.manifest.id)).join(', ')
      warnings.push({
        code: WARNING_CODES.PLUGIN_NAME_COLLISION,
        message: `Plugin name '${pluginName}' is produced by multiple spaces: ${spaceIds}`,
        severity: 'warning',
        details: {
          pluginName,
          spaces: owners.map((s) => s.key),
        },
      })
    }
  }

  return warnings
}
