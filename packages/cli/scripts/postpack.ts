// WHY: prepack rewrites bare workspace imports in packages/cli/dist and the
// root shim files in place, and copies workspace packages into ./node_modules.
// This cleans up the bundled workspace copies and reverts the tracked shim
// files so the working tree matches HEAD after npm pack/publish runs.
// packages/cli/dist is gitignored; the next `tsc` run regenerates it.

import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = dirname(HERE)

const BUNDLED_DIRS = [
  'spaces-config',
  'spaces-runtime',
  'spaces-execution',
  'spaces-harness-claude',
  'spaces-harness-codex',
  'spaces-harness-pi',
  'spaces-harness-pi-sdk',
  'agent-spaces',
  'agent-scope',
]

for (const d of BUNDLED_DIRS) {
  await rm(join(CLI_ROOT, 'node_modules', d), { recursive: true, force: true })
}

await $`git checkout -- engine.js runtime.js core.js resolver.js store.js materializer.js git.js claude.js lint.js package.json`
  .cwd(CLI_ROOT)
  .nothrow()
