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

/** Permission settings for Claude */
export interface SpacePermissions {
  /** Permission rules to allow tool use */
  allow?: string[] | undefined
  /** Permission rules to deny tool use */
  deny?: string[] | undefined
}

/** Claude settings that can be defined in a space */
export interface SpaceSettings {
  /** Permission rules */
  permissions?: SpacePermissions | undefined
  /** Environment variables to set */
  env?: Record<string, string> | undefined
  /** Override the default Claude model */
  model?: string | undefined
}

/** Multi-harness support configuration */
export interface SpaceHarnessConfig {
  /** List of harnesses this space supports */
  supports?: Array<'claude' | 'pi' | 'pi-sdk'> | undefined
}

/** Claude-specific space configuration */
export interface SpaceClaudeConfig {
  /** Claude model override */
  model?: string | undefined
  /** Explicit MCP config paths (otherwise auto-discover mcp/) */
  mcp?: string[] | undefined
}

/** Pi extension build configuration */
export interface SpacePiBuildConfig {
  /** Bundle extensions to JS (default: true) */
  bundle?: boolean | undefined
  /** Output format: esm or cjs (default: esm) */
  format?: 'esm' | 'cjs' | undefined
  /** Target runtime: bun or node (default: bun) */
  target?: 'bun' | 'node' | undefined
  /** Dependencies to exclude from bundle */
  external?: string[] | undefined
}

/** Pi-specific space configuration */
export interface SpacePiConfig {
  /** Pi model override (e.g., claude-sonnet) */
  model?: string | undefined
  /** Extension files to load */
  extensions?: string[] | undefined
  /** Extension build configuration */
  build?: SpacePiBuildConfig | undefined
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
  /** Claude settings to apply when running with this space */
  settings?: SpaceSettings | undefined
  /** Multi-harness support configuration */
  harness?: SpaceHarnessConfig | undefined
  /** Claude-specific configuration */
  claude?: SpaceClaudeConfig | undefined
  /** Pi-specific configuration */
  pi?: SpacePiConfig | undefined
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
