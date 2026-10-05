import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from './command'

/**
 * Extract an npm tarball into extractDir and return its `package/` directory.
 * Failures name `label` (the package being handled).
 */
export function extractTarball(tarballPath: string, extractDir: string, label: string): string {
  const mkdir = run('mkdir', ['-p', extractDir])
  if (mkdir.status !== 0) throw new Error(`mkdir failed for ${label}: ${mkdir.out}`)

  const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir])
  if (tar.status !== 0) throw new Error(`tar failed for ${label}: ${tar.out}`)

  return join(extractDir, 'package')
}

/** Write tarball bytes to a temp dir, extract them, and run `use` on the package dir. */
export async function withExtractedTarball<T>(
  bytes: Uint8Array,
  tempPrefix: string,
  label: string,
  use: (packageDir: string) => Promise<T>
): Promise<T> {
  let temp = ''
  try {
    temp = await mkdtemp(join(tmpdir(), tempPrefix))
    const tarballPath = join(temp, 'package.tgz')
    await writeFile(tarballPath, bytes)
    return await use(extractTarball(tarballPath, join(temp, 'extract'), label))
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true })
  }
}
