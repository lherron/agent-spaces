/**
 * Pi extension bundling: compile TypeScript extensions to JavaScript with Bun
 * and discover extension sources in a space snapshot.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PiBundleError } from './errors.js'

/**
 * Build options for extension bundling.
 */
export interface ExtensionBuildOptions {
  /** Output format: "esm" or "cjs" */
  format?: 'esm' | 'cjs' | undefined
  /** Target runtime: "bun" or "node" */
  target?: 'bun' | 'node' | undefined
  /** Dependencies to exclude from bundle */
  external?: string[] | undefined
}

/**
 * Bundle a TypeScript extension to JavaScript using Bun.
 *
 * @param srcPath - Source TypeScript file path
 * @param outPath - Output JavaScript file path
 * @param options - Build options
 */
export async function bundleExtension(
  srcPath: string,
  outPath: string,
  options: ExtensionBuildOptions = {}
): Promise<void> {
  const { format = 'esm', target = 'bun', external = [] } = options

  // Build args for bun build
  const args = ['build', srcPath, '--outfile', outPath, '--format', format, '--target', target]

  // Add external dependencies
  for (const ext of external) {
    args.push('--external', ext)
  }

  const proc = Bun.spawn(['bun', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await proc.exited
  const stderr = await new Response(proc.stderr).text()

  if (exitCode !== 0) {
    throw new PiBundleError(srcPath, stderr)
  }
}

/**
 * Discover extensions in a snapshot directory.
 *
 * @param snapshotPath - Path to the space snapshot
 * @returns Array of extension file paths
 */
export async function discoverExtensions(snapshotPath: string): Promise<string[]> {
  const extensionsDir = join(snapshotPath, 'extensions')
  const extensions: string[] = []

  try {
    const stats = await stat(extensionsDir)
    if (!stats.isDirectory()) {
      return extensions
    }

    const entries = await readdir(extensionsDir)
    for (const entry of entries) {
      // Skip package.json and node_modules
      if (entry === 'package.json' || entry === 'node_modules') {
        continue
      }

      // Include .ts and .js files
      if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        extensions.push(join(extensionsDir, entry))
      }
    }
  } catch {
    // Extensions directory doesn't exist
  }

  return extensions
}
