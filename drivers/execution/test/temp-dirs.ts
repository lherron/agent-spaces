import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach } from 'bun:test'

/**
 * Register per-test temp-dir cleanup in the calling test file and return a
 * factory for tracked temp dirs.
 */
export function useTempDirs(): (prefix: string) => Promise<string> {
  let tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
    tempDirs = []
  })

  return async (prefix) => {
    const path = await mkdtemp(join(tmpdir(), prefix))
    tempDirs.push(path)
    return path
  }
}
