/**
 * Space manifest types for Agent Spaces v2
 *
 * A Space is the authored unit in the registry repo.
 * Layout: spaces/<id>/space.toml
 */

import type { SpaceId, SpaceRefString } from './refs.js'

/** Author information for plugin metadata */
export interface SpaceAuthor {
  name?: string
  email?: string
  url?: string
}

/** Plugin-specific configuration (maps to plugin.json fields) */
export interface SpacePluginConfig {
  /** Plugin name override (kebab-case); defaults to space id */
  name?: string | undefined
  /** Plugin version override (semver); defaults to space version */
  version?: string | undefined
  /** Plugin description override */
  description?: string | undefined
  /** Author information */
  author?: SpaceAuthor | undefined
  /** Homepage URL */
  homepage?: string | undefined
  /** Repository URL */
  repository?: string | undefined
  /** License identifier */
  license?: string | undefined
  /** Keywords for discovery */
  keywords?: string[] | undefined
}

/** Space dependencies configuration */
export interface SpaceDeps {
  /** Transitive space dependencies */
  spaces?: SpaceRefString[]
}

/**
 * Space manifest (space.toml)
 *
 * The Space layout mirrors Claude plugin conventions to minimize
 * mental translation during materialization.
 */
export interface SpaceManifest {
  /** Schema version (currently 1) */
  schema: 1
  /** Space identifier (kebab-case, 1-64 chars) */
  id: SpaceId
  /** Semantic version for the space */
  version?: string
  /** Human-readable description */
  description?: string
  /** Plugin configuration overrides */
  plugin?: SpacePluginConfig
  /** Dependencies */
  deps?: SpaceDeps
}

// ============================================================================
// Derived types for resolved spaces
// ============================================================================

/** Plugin identity derived from space manifest */
export interface PluginIdentity {
  /** Resolved plugin name (from plugin.name or id) */
  name: string
  /** Resolved plugin version (from plugin.version or version) */
  version?: string | undefined
}

/** Resolved space with derived values */
export interface ResolvedSpaceManifest extends SpaceManifest {
  /** Resolved plugin identity */
  plugin: PluginIdentity & SpacePluginConfig
}

/**
 * Derive plugin identity from space manifest
 */
export function derivePluginIdentity(manifest: SpaceManifest): PluginIdentity {
  return {
    name: manifest.plugin?.name ?? manifest.id,
    version: manifest.plugin?.version ?? manifest.version,
  }
}

/**
 * Resolve a space manifest to include derived plugin values
 */
export function resolveSpaceManifest(manifest: SpaceManifest): ResolvedSpaceManifest {
  const identity = derivePluginIdentity(manifest)
  return {
    ...manifest,
    plugin: {
      ...manifest.plugin,
      ...identity,
    },
  }
}
