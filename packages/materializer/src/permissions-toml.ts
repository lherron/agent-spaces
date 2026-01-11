/**
 * permissions.toml parser and translator
 *
 * WHY: permissions.toml provides a harness-agnostic way to declare permissions.
 * This module parses permissions.toml and translates it to harness-specific formats:
 * - Claude: translates to settings.json permissions (enforced for most facets)
 * - Pi: best-effort translation (mostly lint_only)
 *
 * Enforcement Semantics:
 * - enforced: the harness can enforce it directly
 * - best_effort: ASP can approximate but not guarantee
 * - lint_only: ASP can only warn; no runtime enforcement
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import TOML from '@iarna/toml'

// ============================================================================
// Types
// ============================================================================

/**
 * Canonical permissions definition from permissions.toml.
 *
 * This is the harness-agnostic format that gets translated per-harness.
 */
export interface CanonicalPermissions {
  /** Read permissions for file paths */
  read?:
    | {
        /** Path patterns that can be read */
        paths?: string[] | undefined
      }
    | undefined

  /** Write permissions for file paths */
  write?:
    | {
        /** Path patterns that can be written */
        paths?: string[] | undefined
      }
    | undefined

  /** Execute permissions for commands */
  exec?:
    | {
        /** Specific commands allowed */
        commands?: string[] | undefined
        /** Patterns for dynamic commands (e.g., "npm run *") */
        patterns?: string[] | undefined
      }
    | undefined

  /** Network permissions */
  network?:
    | {
        /** Allowed hosts with optional port (e.g., "api.example.com:443") */
        hosts?: string[] | undefined
      }
    | undefined

  /** Deny rules (override allows) */
  deny?:
    | {
        /** Read paths to deny */
        read?: string[] | undefined
        /** Write paths to deny */
        write?: string[] | undefined
        /** Exec commands to deny */
        exec?: string[] | undefined
        /** Network hosts to deny */
        network?: string[] | undefined
      }
    | undefined
}

/**
 * Enforcement level for a permission facet.
 */
export type EnforcementLevel = 'enforced' | 'best_effort' | 'lint_only'

/**
 * Permission facet with enforcement level annotation.
 */
export interface AnnotatedPermissionFacet<T> {
  /** The actual value */
  value: T
  /** How this facet is enforced on this harness */
  enforcement: EnforcementLevel
  /** Human-readable note about the enforcement */
  note?: string | undefined
}

/**
 * Translated Claude permissions with enforcement annotations.
 */
export interface ClaudePermissions {
  /** Read paths - enforced via settings */
  read?: AnnotatedPermissionFacet<string[]> | undefined
  /** Write paths - enforced via settings */
  write?: AnnotatedPermissionFacet<string[]> | undefined
  /** Exec rules - enforced via allowedTools */
  exec?: AnnotatedPermissionFacet<string[]> | undefined
  /** Network hosts - lint_only (MCP-dependent) */
  network?: AnnotatedPermissionFacet<string[]> | undefined
  /** Deny rules - enforced via settings */
  deny?:
    | {
        read?: AnnotatedPermissionFacet<string[]> | undefined
        write?: AnnotatedPermissionFacet<string[]> | undefined
        exec?: AnnotatedPermissionFacet<string[]> | undefined
        network?: AnnotatedPermissionFacet<string[]> | undefined
      }
    | undefined
}

/**
 * Translated Pi permissions with enforcement annotations.
 */
export interface PiPermissions {
  /** Read paths - lint_only */
  read?: AnnotatedPermissionFacet<string[]> | undefined
  /** Write paths - lint_only */
  write?: AnnotatedPermissionFacet<string[]> | undefined
  /** Exec rules - best_effort via tools flag */
  exec?: AnnotatedPermissionFacet<string[]> | undefined
  /** Network hosts - lint_only */
  network?: AnnotatedPermissionFacet<string[]> | undefined
  /** Deny rules - lint_only */
  deny?:
    | {
        read?: AnnotatedPermissionFacet<string[]> | undefined
        write?: AnnotatedPermissionFacet<string[]> | undefined
        exec?: AnnotatedPermissionFacet<string[]> | undefined
        network?: AnnotatedPermissionFacet<string[]> | undefined
      }
    | undefined
}

/**
 * Claude settings.json permissions format.
 */
export interface ClaudeSettingsPermissions {
  /** Permission rules to allow */
  allow?: string[] | undefined
  /** Permission rules to deny */
  deny?: string[] | undefined
}

// ============================================================================
// Constants
// ============================================================================

/** Filename for permissions.toml */
export const PERMISSIONS_TOML_FILENAME = 'permissions.toml'

/** Permission facet keys */
type PermissionFacetKey =
  | 'read'
  | 'write'
  | 'exec'
  | 'network'
  | 'deny.read'
  | 'deny.write'
  | 'deny.exec'
  | 'deny.network'

/**
 * Enforcement classification for Claude.
 */
export const CLAUDE_ENFORCEMENT: Record<PermissionFacetKey, EnforcementLevel> = {
  read: 'enforced',
  write: 'enforced',
  exec: 'enforced',
  network: 'lint_only',
  'deny.read': 'enforced',
  'deny.write': 'enforced',
  'deny.exec': 'enforced',
  'deny.network': 'lint_only',
}

/**
 * Enforcement classification for Pi.
 */
export const PI_ENFORCEMENT: Record<PermissionFacetKey, EnforcementLevel> = {
  read: 'lint_only',
  write: 'lint_only',
  exec: 'best_effort',
  network: 'lint_only',
  'deny.read': 'lint_only',
  'deny.write': 'lint_only',
  'deny.exec': 'lint_only',
  'deny.network': 'lint_only',
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse permissions.toml content.
 *
 * @param content - Raw TOML string content
 * @returns Parsed canonical permissions
 * @throws Error if parsing fails
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parser handles multiple optional sections
export function parsePermissionsToml(content: string): CanonicalPermissions {
  const parsed = TOML.parse(content) as unknown as Record<string, unknown>

  const result: CanonicalPermissions = {}

  // Parse read section
  if (parsed['read'] && typeof parsed['read'] === 'object') {
    const read = parsed['read'] as Record<string, unknown>
    result.read = {
      paths: Array.isArray(read['paths']) ? (read['paths'] as string[]) : undefined,
    }
  }

  // Parse write section
  if (parsed['write'] && typeof parsed['write'] === 'object') {
    const write = parsed['write'] as Record<string, unknown>
    result.write = {
      paths: Array.isArray(write['paths']) ? (write['paths'] as string[]) : undefined,
    }
  }

  // Parse exec section
  if (parsed['exec'] && typeof parsed['exec'] === 'object') {
    const exec = parsed['exec'] as Record<string, unknown>
    result.exec = {
      commands: Array.isArray(exec['commands']) ? (exec['commands'] as string[]) : undefined,
      patterns: Array.isArray(exec['patterns']) ? (exec['patterns'] as string[]) : undefined,
    }
  }

  // Parse network section
  if (parsed['network'] && typeof parsed['network'] === 'object') {
    const network = parsed['network'] as Record<string, unknown>
    result.network = {
      hosts: Array.isArray(network['hosts']) ? (network['hosts'] as string[]) : undefined,
    }
  }

  // Parse deny section
  if (parsed['deny'] && typeof parsed['deny'] === 'object') {
    const deny = parsed['deny'] as Record<string, unknown>
    result.deny = {
      read: Array.isArray(deny['read']) ? (deny['read'] as string[]) : undefined,
      write: Array.isArray(deny['write']) ? (deny['write'] as string[]) : undefined,
      exec: Array.isArray(deny['exec']) ? (deny['exec'] as string[]) : undefined,
      network: Array.isArray(deny['network']) ? (deny['network'] as string[]) : undefined,
    }
  }

  return result
}

/**
 * Read and parse permissions.toml from a space root directory.
 *
 * @param spaceRoot - Path to the space root directory
 * @returns Parsed canonical permissions, or null if permissions.toml doesn't exist
 */
export async function readPermissionsToml(spaceRoot: string): Promise<CanonicalPermissions | null> {
  const permissionsTomlPath = join(spaceRoot, PERMISSIONS_TOML_FILENAME)

  try {
    const file = Bun.file(permissionsTomlPath)
    if (!(await file.exists())) {
      return null
    }
    const content = await file.text()
    return parsePermissionsToml(content)
  } catch {
    return null
  }
}

/**
 * Check if permissions.toml exists in a space root directory.
 *
 * @param spaceRoot - Path to the space root directory
 * @returns True if permissions.toml exists
 */
export async function permissionsTomlExists(spaceRoot: string): Promise<boolean> {
  const permissionsTomlPath = join(spaceRoot, PERMISSIONS_TOML_FILENAME)
  try {
    const stats = await stat(permissionsTomlPath)
    return stats.isFile()
  } catch {
    return false
  }
}

// ============================================================================
// Translation: permissions.toml -> Claude settings
// ============================================================================

/**
 * Normalize path patterns for Claude permissions.
 *
 * @param paths - Array of path patterns
 * @returns Normalized path patterns
 */
export function normalizePaths(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return []
  return paths.map((p) => p.trim()).filter((p) => p.length > 0)
}

/**
 * Convert exec commands and patterns to Claude permission rules.
 *
 * Claude uses format like "Bash(npm *)" for command patterns.
 *
 * @param commands - Specific commands allowed
 * @param patterns - Command patterns with wildcards
 * @returns Claude permission rule strings
 */
export function normalizeExecToClaudeRules(
  commands: string[] | undefined,
  patterns: string[] | undefined
): string[] {
  const rules: string[] = []

  // Add specific commands as Bash(<cmd>)
  if (commands) {
    for (const cmd of commands) {
      const trimmed = cmd.trim()
      if (trimmed) {
        rules.push(`Bash(${trimmed} *)`)
      }
    }
  }

  // Add patterns as Bash(<pattern>)
  if (patterns) {
    for (const pattern of patterns) {
      const trimmed = pattern.trim()
      if (trimmed) {
        rules.push(`Bash(${trimmed})`)
      }
    }
  }

  return rules
}

/**
 * Translate canonical permissions to Claude permissions with enforcement annotations.
 *
 * @param permissions - Canonical permissions from permissions.toml
 * @returns Claude permissions with enforcement levels
 */
export function toClaudePermissions(permissions: CanonicalPermissions): ClaudePermissions {
  const result: ClaudePermissions = {}

  // Read paths - enforced
  if (permissions.read?.paths?.length) {
    result.read = {
      value: normalizePaths(permissions.read.paths),
      enforcement: CLAUDE_ENFORCEMENT['read'],
    }
  }

  // Write paths - enforced
  if (permissions.write?.paths?.length) {
    result.write = {
      value: normalizePaths(permissions.write.paths),
      enforcement: CLAUDE_ENFORCEMENT['write'],
    }
  }

  // Exec commands/patterns - enforced
  const execRules = normalizeExecToClaudeRules(
    permissions.exec?.commands,
    permissions.exec?.patterns
  )
  if (execRules.length > 0) {
    result.exec = {
      value: execRules,
      enforcement: CLAUDE_ENFORCEMENT['exec'],
    }
  }

  // Network hosts - lint_only
  if (permissions.network?.hosts?.length) {
    result.network = {
      value: normalizePaths(permissions.network.hosts),
      enforcement: CLAUDE_ENFORCEMENT['network'],
      note: 'Claude cannot enforce network restrictions; lint-only',
    }
  }

  // Deny rules
  if (permissions.deny) {
    result.deny = {}

    if (permissions.deny.read?.length) {
      result.deny.read = {
        value: normalizePaths(permissions.deny.read),
        enforcement: CLAUDE_ENFORCEMENT['deny.read'],
      }
    }

    if (permissions.deny.write?.length) {
      result.deny.write = {
        value: normalizePaths(permissions.deny.write),
        enforcement: CLAUDE_ENFORCEMENT['deny.write'],
      }
    }

    if (permissions.deny.exec?.length) {
      // Convert exec deny patterns to Bash() format
      result.deny.exec = {
        value: permissions.deny.exec.map((cmd) => `Bash(${cmd.trim()})`),
        enforcement: CLAUDE_ENFORCEMENT['deny.exec'],
      }
    }

    if (permissions.deny.network?.length) {
      result.deny.network = {
        value: normalizePaths(permissions.deny.network),
        enforcement: CLAUDE_ENFORCEMENT['deny.network'],
        note: 'Claude cannot enforce network restrictions; lint-only',
      }
    }
  }

  return result
}

/**
 * Convert Claude permissions to settings.json format.
 *
 * Combines all allow rules into a single array for the settings.json
 * permissions.allow field, and all deny rules into permissions.deny.
 *
 * @param claudePerms - Claude permissions with enforcement annotations
 * @returns Settings.json compatible permissions object
 */
export function toClaudeSettingsPermissions(
  claudePerms: ClaudePermissions
): ClaudeSettingsPermissions {
  const result: ClaudeSettingsPermissions = {}

  // Collect all allow rules
  const allowRules: string[] = []

  // Read and Write tools are implicit in Claude, but we can add path patterns
  // In Claude's permissions format, Read and Write are tool names, not path filters
  // Path filtering happens through other mechanisms
  // For now, we map read/write paths to tool permissions

  if (claudePerms.read?.value?.length) {
    // Add Read tool with paths - Claude doesn't have per-path read permissions
    // We add Read to allow and note that path restrictions are best-effort
    allowRules.push('Read')
  }

  if (claudePerms.write?.value?.length) {
    // Same for Write
    allowRules.push('Write')
  }

  if (claudePerms.exec?.value?.length) {
    // Add exec rules (already in Bash() format)
    allowRules.push(...claudePerms.exec.value)
  }

  // Set allow if we have rules
  if (allowRules.length > 0) {
    result.allow = allowRules
  }

  // Collect all deny rules
  const denyRules: string[] = []

  if (claudePerms.deny?.read?.value?.length) {
    // For deny, we can specify patterns to deny
    for (const path of claudePerms.deny.read.value) {
      denyRules.push(`Read(${path})`)
    }
  }

  if (claudePerms.deny?.write?.value?.length) {
    for (const path of claudePerms.deny.write.value) {
      denyRules.push(`Write(${path})`)
    }
  }

  if (claudePerms.deny?.exec?.value?.length) {
    // Already in Bash() format
    denyRules.push(...claudePerms.deny.exec.value)
  }

  // Set deny if we have rules
  if (denyRules.length > 0) {
    result.deny = denyRules
  }

  return result
}

// ============================================================================
// Translation: permissions.toml -> Pi settings (best-effort)
// ============================================================================

/**
 * Translate canonical permissions to Pi permissions with enforcement annotations.
 *
 * Most permissions are lint_only for Pi since it lacks built-in permission controls.
 *
 * @param permissions - Canonical permissions from permissions.toml
 * @returns Pi permissions with enforcement levels
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Translator handles multiple facets
export function toPiPermissions(permissions: CanonicalPermissions): PiPermissions {
  const result: PiPermissions = {}

  // Read paths - lint_only
  if (permissions.read?.paths?.length) {
    result.read = {
      value: normalizePaths(permissions.read.paths),
      enforcement: PI_ENFORCEMENT['read'],
      note: 'Pi has no read restrictions',
    }
  }

  // Write paths - lint_only
  if (permissions.write?.paths?.length) {
    result.write = {
      value: normalizePaths(permissions.write.paths),
      enforcement: PI_ENFORCEMENT['write'],
      note: 'Pi has no write restrictions',
    }
  }

  // Exec commands - best_effort via tools flag
  if (permissions.exec?.commands?.length || permissions.exec?.patterns?.length) {
    const commands = [
      ...(permissions.exec.commands ?? []),
      ...(permissions.exec.patterns ?? []),
    ].filter((c) => c.trim().length > 0)

    if (commands.length > 0) {
      result.exec = {
        value: commands,
        enforcement: PI_ENFORCEMENT['exec'],
        note: 'Best-effort via Pi tools configuration',
      }
    }
  }

  // Network hosts - lint_only
  if (permissions.network?.hosts?.length) {
    result.network = {
      value: normalizePaths(permissions.network.hosts),
      enforcement: PI_ENFORCEMENT['network'],
      note: 'Pi has no network restrictions',
    }
  }

  // Deny rules - all lint_only for Pi
  if (permissions.deny) {
    result.deny = {}

    if (permissions.deny.read?.length) {
      result.deny.read = {
        value: normalizePaths(permissions.deny.read),
        enforcement: PI_ENFORCEMENT['deny.read'],
        note: 'Pi cannot enforce read denials',
      }
    }

    if (permissions.deny.write?.length) {
      result.deny.write = {
        value: normalizePaths(permissions.deny.write),
        enforcement: PI_ENFORCEMENT['deny.write'],
        note: 'Pi cannot enforce write denials',
      }
    }

    if (permissions.deny.exec?.length) {
      result.deny.exec = {
        value: normalizePaths(permissions.deny.exec),
        enforcement: PI_ENFORCEMENT['deny.exec'],
        note: 'Pi cannot enforce exec denials',
      }
    }

    if (permissions.deny.network?.length) {
      result.deny.network = {
        value: normalizePaths(permissions.deny.network),
        enforcement: PI_ENFORCEMENT['deny.network'],
        note: 'Pi cannot enforce network denials',
      }
    }
  }

  return result
}

/**
 * Build Pi tools list from exec permissions.
 *
 * For Pi, we can configure which built-in tools are available.
 * This is a best-effort translation from exec permissions.
 *
 * @param permissions - Canonical permissions
 * @returns Array of tool names for Pi's --tools flag
 */
export function buildPiToolsList(_permissions: CanonicalPermissions): string[] {
  // Default tools that are always available
  const defaultTools = ['Read', 'Write', 'Bash', 'Glob', 'Grep']

  // If exec permissions are specified, we could potentially
  // restrict which tools are available, but this is very limited
  // For now, return default tools as Pi doesn't have fine-grained control
  return defaultTools
}

// ============================================================================
// Result types for explain output
// ============================================================================

/**
 * Read permissions.toml result with source information.
 */
export interface ReadPermissionsResult {
  /** Parsed permissions as canonical definitions */
  permissions: CanonicalPermissions | null
  /** Path to the source file */
  sourcePath?: string | undefined
  /** Whether the file exists */
  exists: boolean
}

/**
 * Read permissions configuration from a space directory.
 *
 * @param spaceRoot - Path to the space root directory
 * @returns Parsed permissions with source information
 */
export async function readPermissions(spaceRoot: string): Promise<ReadPermissionsResult> {
  const permissionsTomlPath = join(spaceRoot, PERMISSIONS_TOML_FILENAME)
  const permissions = await readPermissionsToml(spaceRoot)

  return {
    permissions,
    sourcePath: permissions ? permissionsTomlPath : undefined,
    exists: permissions !== null,
  }
}

/**
 * Check if canonical permissions have any actual rules defined.
 */
export function hasPermissions(permissions: CanonicalPermissions | null): boolean {
  if (!permissions) return false

  return !!(
    permissions.read?.paths?.length ||
    permissions.write?.paths?.length ||
    permissions.exec?.commands?.length ||
    permissions.exec?.patterns?.length ||
    permissions.network?.hosts?.length ||
    permissions.deny?.read?.length ||
    permissions.deny?.write?.length ||
    permissions.deny?.exec?.length ||
    permissions.deny?.network?.length
  )
}

/**
 * Generate a human-readable explanation of permissions for a harness.
 *
 * @param permissions - Canonical permissions
 * @param harnessId - Target harness ('claude' or 'pi')
 * @returns Array of explanation strings
 */
export function explainPermissions(
  permissions: CanonicalPermissions,
  harnessId: 'claude' | 'pi'
): string[] {
  const lines: string[] = []
  const translated =
    harnessId === 'claude' ? toClaudePermissions(permissions) : toPiPermissions(permissions)

  const formatFacet = (
    name: string,
    facet: AnnotatedPermissionFacet<string[]> | undefined
  ): void => {
    if (!facet || !facet.value?.length) return

    const enforcement = facet.enforcement.toUpperCase()
    const note = facet.note ? ` (${facet.note})` : ''
    const values = facet.value.slice(0, 3).join(', ')
    const more = facet.value.length > 3 ? `, +${facet.value.length - 3} more` : ''

    lines.push(`  - ${name}: [${values}${more}] → [${enforcement}]${note}`)
  }

  if (harnessId === 'claude') {
    const claude = translated as ClaudePermissions
    formatFacet('read', claude.read)
    formatFacet('write', claude.write)
    formatFacet('exec', claude.exec)
    formatFacet('network', claude.network)
    if (claude.deny) {
      formatFacet('deny.read', claude.deny.read)
      formatFacet('deny.write', claude.deny.write)
      formatFacet('deny.exec', claude.deny.exec)
      formatFacet('deny.network', claude.deny.network)
    }
  } else {
    const pi = translated as PiPermissions
    formatFacet('read', pi.read)
    formatFacet('write', pi.write)
    formatFacet('exec', pi.exec)
    formatFacet('network', pi.network)
    if (pi.deny) {
      formatFacet('deny.read', pi.deny.read)
      formatFacet('deny.write', pi.deny.write)
      formatFacet('deny.exec', pi.deny.exec)
      formatFacet('deny.network', pi.deny.network)
    }
  }

  return lines
}
