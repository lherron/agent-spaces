/**
 * Link components from store snapshot to plugin directory.
 *
 * WHY: Hardlinks are the most efficient way to copy files when
 * source and destination are on the same filesystem. They avoid
 * duplicating data while providing independent file entries.
 */

import { access, copyFile, mkdir, readdir, readlink, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { linkOrCopy } from 'spaces-core'

/**
 * Harness-agnostic instructions file name.
 */
export const INSTRUCTIONS_FILE_AGNOSTIC = 'AGENT.md'

/**
 * Claude-specific instructions file name.
 */
export const INSTRUCTIONS_FILE_CLAUDE = 'CLAUDE.md'

/**
 * Component directories that should be linked from snapshot to plugin.
 */
export const COMPONENT_DIRS = ['commands', 'skills', 'agents', 'hooks', 'scripts', 'mcp'] as const

export type ComponentDir = (typeof COMPONENT_DIRS)[number]

/**
 * Options for linking operations.
 */
export interface LinkOptions {
  /** Use copy instead of hardlink (for cross-device) */
  forceCopy?: boolean | undefined
}

/**
 * Link a single file from source to destination.
 * Creates parent directories as needed.
 *
 * @param srcPath - Source file path
 * @param destPath - Destination file path
 * @param options - Link options (forceCopy to use copy instead of hardlink)
 */
export async function linkFile(
  srcPath: string,
  destPath: string,
  options: LinkOptions = {}
): Promise<void> {
  // Ensure destination directory exists
  await mkdir(dirname(destPath), { recursive: true })

  if (options.forceCopy) {
    // Use copy to protect source files (dev mode)
    await copyFile(srcPath, destPath)
  } else {
    // Use linkOrCopy from core for cross-device fallback
    await linkOrCopy(srcPath, destPath)
  }
}

/**
 * Link a directory tree from source to destination.
 * Recreates the directory structure with hardlinks to files.
 */
export async function linkDirectory(
  srcDir: string,
  destDir: string,
  options: LinkOptions = {}
): Promise<void> {
  await mkdir(destDir, { recursive: true })

  const entries = await readdir(srcDir, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)

    if (entry.isDirectory()) {
      await linkDirectory(srcPath, destPath, options)
    } else if (entry.isFile()) {
      await linkFile(srcPath, destPath, options)
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks
      const target = await readlink(srcPath)
      await symlink(target, destPath)
    }
  }
}

/**
 * Link all component directories from a snapshot to a plugin directory.
 */
export async function linkComponents(
  snapshotDir: string,
  pluginDir: string,
  options: LinkOptions = {}
): Promise<string[]> {
  const linked: string[] = []

  for (const component of COMPONENT_DIRS) {
    const srcDir = join(snapshotDir, component)
    const destDir = join(pluginDir, component)

    try {
      const stats = await stat(srcDir)
      if (stats.isDirectory()) {
        await linkDirectory(srcDir, destDir, options)
        linked.push(component)
      }
    } catch {
      // Component doesn't exist in snapshot, skip
    }
  }

  return linked
}

/**
 * Check if a path exists and is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Check which components exist in a snapshot.
 */
export async function getAvailableComponents(snapshotDir: string): Promise<ComponentDir[]> {
  const available: ComponentDir[] = []

  for (const component of COMPONENT_DIRS) {
    const dir = join(snapshotDir, component)
    if (await isDirectory(dir)) {
      available.push(component)
    }
  }

  return available
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Result of linking instructions file.
 */
export interface LinkInstructionsResult {
  /** Whether an instructions file was linked */
  linked: boolean
  /** Source file that was linked (AGENT.md or CLAUDE.md) */
  sourceFile?: string | undefined
  /** Destination file name */
  destFile?: string | undefined
}

/**
 * Link instructions file from snapshot to plugin directory.
 *
 * Supports the harness-agnostic AGENT.md pattern:
 * - For Claude: AGENT.md is copied as CLAUDE.md, or CLAUDE.md is kept as-is
 * - For Pi: AGENT.md is copied as AGENT.md
 *
 * Priority for Claude:
 * 1. If AGENT.md exists, link as CLAUDE.md (new multi-harness pattern)
 * 2. If CLAUDE.md exists (and no AGENT.md), link as CLAUDE.md (legacy pattern)
 *
 * Priority for Pi:
 * 1. If AGENT.md exists, link as AGENT.md
 * 2. No fallback to CLAUDE.md (Pi doesn't use Claude-specific files)
 *
 * @param snapshotDir - Source snapshot directory
 * @param pluginDir - Destination plugin directory
 * @param harness - Target harness: 'claude' or 'pi'
 * @param options - Link options
 */
export async function linkInstructionsFile(
  snapshotDir: string,
  pluginDir: string,
  harness: 'claude' | 'pi',
  options: LinkOptions = {}
): Promise<LinkInstructionsResult> {
  const agentMdPath = join(snapshotDir, INSTRUCTIONS_FILE_AGNOSTIC)
  const claudeMdPath = join(snapshotDir, INSTRUCTIONS_FILE_CLAUDE)

  if (harness === 'claude') {
    // Claude: prefer AGENT.md → CLAUDE.md, fallback to CLAUDE.md → CLAUDE.md
    if (await fileExists(agentMdPath)) {
      const destPath = join(pluginDir, INSTRUCTIONS_FILE_CLAUDE)
      await linkFile(agentMdPath, destPath, options)
      return {
        linked: true,
        sourceFile: INSTRUCTIONS_FILE_AGNOSTIC,
        destFile: INSTRUCTIONS_FILE_CLAUDE,
      }
    }

    if (await fileExists(claudeMdPath)) {
      const destPath = join(pluginDir, INSTRUCTIONS_FILE_CLAUDE)
      await linkFile(claudeMdPath, destPath, options)
      return {
        linked: true,
        sourceFile: INSTRUCTIONS_FILE_CLAUDE,
        destFile: INSTRUCTIONS_FILE_CLAUDE,
      }
    }
  } else {
    // Pi: only use AGENT.md
    if (await fileExists(agentMdPath)) {
      const destPath = join(pluginDir, INSTRUCTIONS_FILE_AGNOSTIC)
      await linkFile(agentMdPath, destPath, options)
      return {
        linked: true,
        sourceFile: INSTRUCTIONS_FILE_AGNOSTIC,
        destFile: INSTRUCTIONS_FILE_AGNOSTIC,
      }
    }
  }

  return { linked: false }
}
