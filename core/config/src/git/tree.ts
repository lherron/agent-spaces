/**
 * Git tree operations for listing directory entries.
 *
 * WHY: The store package needs to compute integrity hashes for spaces.
 * Using git ls-tree is faster than walking the filesystem because:
 * 1. Git already has the tree structure indexed
 * 2. We get stable sorting by path
 * 3. We get blob OIDs which can be used directly for hashing
 * 4. No file I/O required for the tree structure
 */

import { gitExecLines } from './exec.js'

/**
 * Entry in a git tree representing a file, directory, or symlink.
 */
export interface TreeEntry {
  /** File mode (e.g., "100644" for regular file, "100755" for executable, "120000" for symlink, "040000" for directory) */
  mode: string
  /** Object type: "blob" for files, "tree" for directories, "commit" for submodules */
  type: 'blob' | 'tree' | 'commit'
  /** Git object ID (SHA-1 hash) */
  oid: string
  /** Path relative to the tree root */
  path: string
}

/**
 * Parsed mode information.
 */
export interface ParsedMode {
  /** Whether the file is executable */
  isExecutable: boolean
  /** Whether the entry is a symlink */
  isSymlink: boolean
  /** Whether the entry is a directory */
  isDirectory: boolean
  /** Whether the entry is a submodule */
  isSubmodule: boolean
  /** Whether the entry is a regular file */
  isRegularFile: boolean
}

/**
 * Parse a git mode string into structured information.
 *
 * @param mode - Git mode string (e.g., "100644", "100755", "120000", "040000")
 * @returns Parsed mode information
 */
export function parseMode(mode: string): ParsedMode {
  return {
    isExecutable: mode === '100755',
    isSymlink: mode === '120000',
    isDirectory: mode === '040000' || mode === '40000',
    isSubmodule: mode === '160000',
    isRegularFile: mode === '100644' || mode === '100755',
  }
}

/**
 * List all entries in a tree at a specific commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the tree within the repository (empty string for root)
 * @param options - Execution options including cwd (repo root)
 * @returns Array of tree entries sorted by path
 * @throws GitError if commit or path doesn't exist
 *
 * @example
 * ```typescript
 * // List root of repository at HEAD
 * const entries = await listTree('HEAD', '', { cwd: repoPath });
 *
 * // List contents of a specific directory at a commit
 * const entries = await listTree('abc123', 'spaces/my-space', { cwd: repoPath });
 * ```
 */
export async function listTree(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<TreeEntry[]> {
  // Build the tree reference
  const treeRef = path ? `${commitish}:${path}` : commitish

  // Use ls-tree to list entries
  // Format: <mode> <type> <oid>\t<path>
  const lines = await gitExecLines(['ls-tree', treeRef], options)

  return lines.map((line) => {
    // Split by tab first to separate path (which may contain spaces)
    const tabParts = line.split('\t')
    const metadata = tabParts[0] ?? ''
    const entryPath = tabParts[1] ?? ''
    const metaParts = metadata.split(/\s+/)
    const mode = metaParts[0] ?? ''
    const type = (metaParts[1] ?? 'blob') as 'blob' | 'tree' | 'commit'
    const oid = metaParts[2] ?? ''
    return {
      mode,
      type,
      oid,
      path: entryPath,
    }
  })
}

/**
 * Recursively list all entries in a tree at a specific commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the tree within the repository (empty string for root)
 * @param options - Execution options including cwd (repo root)
 * @returns Array of tree entries (files only) sorted by path
 * @throws GitError if commit or path doesn't exist
 *
 * @example
 * ```typescript
 * // List all files in a space
 * const files = await listTreeRecursive('HEAD', 'spaces/my-space', { cwd: repoPath });
 * // Returns all files with full paths relative to spaces/my-space
 * ```
 */
export async function listTreeRecursive(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<TreeEntry[]> {
  // Build the tree reference
  const treeRef = path ? `${commitish}:${path}` : commitish

  // Use ls-tree -r to list recursively (only blobs, not trees)
  const lines = await gitExecLines(['ls-tree', '-r', treeRef], options)

  return lines.map((line) => {
    const tabParts = line.split('\t')
    const metadata = tabParts[0] ?? ''
    const entryPath = tabParts[1] ?? ''
    const metaParts = metadata.split(/\s+/)
    const mode = metaParts[0] ?? ''
    const type = (metaParts[1] ?? 'blob') as 'blob' | 'tree' | 'commit'
    const oid = metaParts[2] ?? ''
    return {
      mode,
      type,
      oid,
      path: entryPath,
    }
  })
}

/**
 * Recursively list all entries including trees in a tree at a specific commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the tree within the repository (empty string for root)
 * @param options - Execution options including cwd (repo root)
 * @returns Array of all tree entries (including directories) sorted by path
 */
export async function listTreeRecursiveWithDirs(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<TreeEntry[]> {
  const treeRef = path ? `${commitish}:${path}` : commitish

  // Use ls-tree -r -t to include tree entries
  const lines = await gitExecLines(['ls-tree', '-r', '-t', treeRef], options)

  return lines.map((line) => {
    const tabParts = line.split('\t')
    const metadata = tabParts[0] ?? ''
    const entryPath = tabParts[1] ?? ''
    const metaParts = metadata.split(/\s+/)
    const mode = metaParts[0] ?? ''
    const type = (metaParts[1] ?? 'blob') as 'blob' | 'tree' | 'commit'
    const oid = metaParts[2] ?? ''
    return {
      mode,
      type,
      oid,
      path: entryPath,
    }
  })
}

/**
 * Filter tree entries to exclude common ignored paths.
 *
 * @param entries - Array of tree entries
 * @param excludePatterns - Patterns to exclude (defaults to common ignored dirs)
 * @returns Filtered array of tree entries
 *
 * @example
 * ```typescript
 * const allFiles = await listTreeRecursive('HEAD', 'spaces/my-space', { cwd: repoPath });
 * const filtered = filterTreeEntries(allFiles);
 * // Excludes .git/, node_modules/, dist/, etc.
 * ```
 */
export function filterTreeEntries(
  entries: TreeEntry[],
  excludePatterns: string[] = [
    '.git/',
    '.git',
    '.asp/',
    '.asp',
    'node_modules/',
    'node_modules',
    'dist/',
    'dist',
  ]
): TreeEntry[] {
  return entries.filter((entry) => {
    const _pathWithSlash = entry.path.endsWith('/') ? entry.path : `${entry.path}/`
    return !excludePatterns.some(
      (pattern) =>
        entry.path === pattern ||
        entry.path.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)
    )
  })
}

/**
 * Get blob content by OID.
 *
 * @param oid - Git object ID (blob SHA)
 * @param options - Execution options including cwd (repo root)
 * @returns Blob content as string
 * @throws GitError if OID doesn't exist
 */
export async function getBlobContent(
  oid: string,
  options: { cwd?: string | undefined } = {}
): Promise<string> {
  const lines = await gitExecLines(['cat-file', 'blob', oid], options)
  return lines.join('\n')
}
