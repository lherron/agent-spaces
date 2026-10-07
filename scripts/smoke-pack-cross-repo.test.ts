import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { REPO_ROOT } from './lib/asp-publish/package-set'

// T-10320.check-packs: check:packs once ran each package's prepack in place,
// rewriting its tracked package.json in the shared checkout and restoring it
// afterwards, so a sibling seat could see or commit the rewrite and a killed
// run left it dirty. A run must only read the checkout: content AND mtime of
// every tracked file in the packed package dirs stay unchanged.

const PACKAGE_DIRS = [
  'contracts/agent-scope',
  'apps/cli-kit',
  'core/config',
  'core/runtime',
  'drivers/execution',
  'drivers/harness-claude',
  'drivers/harness-codex',
  'drivers/harness-pi',
  'drivers/harness-pi-sdk',
  'harness/harness-broker-pi-sdk',
  'harness/agent-harness-runtime',
  'harness/agent-harness',
  'contracts/spaces-runtime-contracts',
  'contracts/aspc-protocol',
  'compiler/agent-spaces',
]

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

async function snapshotTracked(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of git(['ls-files', '-z', '--', ...PACKAGE_DIRS])
    .split('\0')
    .filter(Boolean)) {
    const path = join(REPO_ROOT, rel)
    // A sibling seat's unstaged deletion leaves the path in the shared index but
    // not on disk. Record it as absent: a run that deletes a file still changes
    // the snapshot, and one that leaves the deletion alone still compares equal.
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) {
      out[rel] = 'absent'
      continue
    }
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    out[rel] = `${hash} ${info.mtimeMs}`
  }
  return out
}

test('check:packs passes without writing any tracked file of the packed packages', async () => {
  const statusBefore = git(['status', '--porcelain', '--', ...PACKAGE_DIRS])
  const before = await snapshotTracked()
  expect(Object.keys(before).length).toBeGreaterThan(PACKAGE_DIRS.length)

  const run = spawnSync('bun', ['scripts/smoke-pack-cross-repo.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  expect(`${run.stdout}${run.stderr}`).not.toContain('FAIL')
  expect(run.stdout.match(/^PASS /gm)?.length).toBe(PACKAGE_DIRS.length)
  expect(run.status).toBe(0)

  expect(await snapshotTracked()).toEqual(before)
  expect(git(['status', '--porcelain', '--', ...PACKAGE_DIRS])).toBe(statusBefore)
}, 300_000)
