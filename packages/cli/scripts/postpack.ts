// WHY: prepack rewrites bare workspace imports in packages/cli/dist and the
// root shim files in place, and copies workspace packages into ./node_modules.
// This cleans up the bundled workspace copies and restores the exact prepack
// snapshot without consulting git, preserving concurrent/uncommitted changes.

import { cp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = dirname(HERE)
const BACKUP = join(CLI_ROOT, '.asp-prepack-backup')

const SHIMS = [
  'engine.js',
  'runtime.js',
  'core.js',
  'resolver.js',
  'store.js',
  'materializer.js',
  'git.js',
  'claude.js',
  'lint.js',
]

const BUNDLED_DIRS = [
  'spaces-config',
  'spaces-runtime',
  'spaces-execution',
  'spaces-runtime-contracts',
  'spaces-harness-broker-client',
  'spaces-harness-broker-protocol',
  'spaces-harness-claude',
  'spaces-harness-codex',
  'spaces-harness-pi',
  'spaces-harness-pi-sdk',
  'agent-spaces',
  'agent-scope',
  'cli-kit',
]

for (const d of BUNDLED_DIRS) {
  await rm(join(CLI_ROOT, 'node_modules', d), { recursive: true, force: true })
}

await cp(join(BACKUP, 'package.json'), join(CLI_ROOT, 'package.json'))
for (const shim of SHIMS) {
  await cp(join(BACKUP, shim), join(CLI_ROOT, shim))
}
await rm(join(CLI_ROOT, 'dist'), { recursive: true, force: true })
await cp(join(BACKUP, 'dist'), join(CLI_ROOT, 'dist'), { recursive: true })
await rm(BACKUP, { recursive: true, force: true })
