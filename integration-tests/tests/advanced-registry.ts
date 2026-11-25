import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { readLockJson } from 'spaces-config'

import { SAMPLE_REGISTRY_DIR } from './setup.js'

export async function advancedRegistry(projectDir: string): Promise<string> {
  const registry = path.join(projectDir, 'registry-copy')
  await fs.cp(SAMPLE_REGISTRY_DIR, registry, { recursive: true })
  await fs.writeFile(path.join(registry, 'spaces/frontend/upgrade-marker.txt'), 'new frontend\n')
  await fs.writeFile(path.join(registry, 'spaces/backend/upgrade-marker.txt'), 'new backend\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: registry, encoding: 'utf8' })
  git('add', 'spaces/frontend/upgrade-marker.txt', 'spaces/backend/upgrade-marker.txt')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'advance stable spaces'
  )
  git('tag', '-f', 'space/frontend/v1.0.0')
  git('tag', '-f', 'space/backend/v1.0.0')
  return registry
}

export function commitFor(lock: Awaited<ReturnType<typeof readLockJson>>, id: string) {
  return Object.values(lock.spaces).find((entry) => entry.id === id)?.commit
}
