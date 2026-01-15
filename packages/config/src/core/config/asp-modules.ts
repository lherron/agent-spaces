/**
 * asp_modules directory constants and helpers.
 *
 * WHY: The asp_modules directory contains materialized artifacts
 * for each target, providing a user-managed filesystem view of
 * resolved spaces that can be used directly with Claude.
 */

import { join } from 'node:path'

/** Directory name for materialized artifacts */
export const ASP_MODULES_DIR = 'asp_modules'

/** Subdirectory name for plugins within a target */
export const ASP_MODULES_PLUGINS_DIR = 'plugins'

/** Filename for composed MCP config */
export const ASP_MODULES_MCP_CONFIG = 'mcp.json'

/** Filename for composed settings */
export const ASP_MODULES_SETTINGS = 'settings.json'

/**
 * Get the path to the asp_modules directory for a project.
 */
export function getAspModulesPath(projectPath: string): string {
  return join(projectPath, ASP_MODULES_DIR)
}

/**
 * Get the path to a target's output directory within asp_modules.
 */
export function getTargetOutputPath(projectPath: string, targetName: string): string {
  return join(projectPath, ASP_MODULES_DIR, targetName)
}

/**
 * Get the path to a target's plugins directory within asp_modules.
 */
export function getTargetPluginsPath(projectPath: string, targetName: string): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, ASP_MODULES_PLUGINS_DIR)
}

/**
 * Get the path to a target's MCP config file within asp_modules.
 */
export function getTargetMcpConfigPath(projectPath: string, targetName: string): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, ASP_MODULES_MCP_CONFIG)
}

/**
 * Get the path to a target's settings file within asp_modules.
 */
export function getTargetSettingsPath(projectPath: string, targetName: string): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, ASP_MODULES_SETTINGS)
}

/**
 * Check if asp_modules directory exists for a project.
 */
export async function aspModulesExists(projectPath: string): Promise<boolean> {
  const modulesPath = getAspModulesPath(projectPath)
  try {
    const { stat } = await import('node:fs/promises')
    const stats = await stat(modulesPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Check if a specific target's output exists in asp_modules.
 */
export async function targetOutputExists(
  projectPath: string,
  targetName: string
): Promise<boolean> {
  const targetPath = getTargetOutputPath(projectPath, targetName)
  try {
    const { stat } = await import('node:fs/promises')
    const stats = await stat(targetPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

// ============================================================================
// Phase 2: Harness-Aware Path Helpers
// ============================================================================

/**
 * Get the path to a harness-specific output directory within a target.
 *
 * Returns: asp_modules/<target>/<harness>/
 *
 * This is the Phase 2 layout that separates output by harness.
 */
export function getHarnessOutputPath(
  projectPath: string,
  targetName: string,
  harnessId: string
): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, harnessId)
}

/**
 * Get the path to a harness-specific plugins directory.
 *
 * Returns: asp_modules/<target>/<harness>/plugins/
 */
export function getHarnessPluginsPath(
  projectPath: string,
  targetName: string,
  harnessId: string
): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, harnessId, ASP_MODULES_PLUGINS_DIR)
}

/**
 * Get the path to a harness-specific MCP config file.
 *
 * Returns: asp_modules/<target>/<harness>/mcp.json
 */
export function getHarnessMcpConfigPath(
  projectPath: string,
  targetName: string,
  harnessId: string
): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, harnessId, ASP_MODULES_MCP_CONFIG)
}

/**
 * Get the path to a harness-specific settings file.
 *
 * Returns: asp_modules/<target>/<harness>/settings.json
 */
export function getHarnessSettingsPath(
  projectPath: string,
  targetName: string,
  harnessId: string
): string {
  return join(projectPath, ASP_MODULES_DIR, targetName, harnessId, ASP_MODULES_SETTINGS)
}

/**
 * Check if a harness-specific output exists in asp_modules.
 */
export async function harnessOutputExists(
  projectPath: string,
  targetName: string,
  harnessId: string
): Promise<boolean> {
  const harnessPath = getHarnessOutputPath(projectPath, targetName, harnessId)
  try {
    const { stat } = await import('node:fs/promises')
    const stats = await stat(harnessPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}
