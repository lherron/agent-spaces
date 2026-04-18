// Runs `npm pack`, installs the tarball into a throwaway Bun project, and
// imports every published subpath entry. Meant to run in CI before
// `npm publish` so packaging regressions surface at PR time, not on the
// consumer side.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = dirname(HERE)

const ENTRY_POINTS = [
  '@lherron/agent-spaces',
  '@lherron/agent-spaces/engine',
  '@lherron/agent-spaces/runtime',
  '@lherron/agent-spaces/core',
  '@lherron/agent-spaces/resolver',
  '@lherron/agent-spaces/store',
  '@lherron/agent-spaces/materializer',
  '@lherron/agent-spaces/git',
  '@lherron/agent-spaces/claude',
  '@lherron/agent-spaces/lint',
]

const packDir = await mkdtemp(join(tmpdir(), 'asp-pack-'))
const consumerDir = await mkdtemp(join(tmpdir(), 'asp-consumer-'))

try {
  const packResult = await $`npm pack --json --pack-destination=${packDir}`.cwd(CLI_ROOT).text()
  const [packInfo] = JSON.parse(packResult)
  const tarball = join(packDir, packInfo.filename)
  console.log(`packed: ${tarball} (${packInfo.size} bytes, ${packInfo.files.length} files)`)

  await writeFile(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'asp-pack-smoke',
        version: '0.0.0',
        type: 'module',
        dependencies: { '@lherron/agent-spaces': `file:${tarball}` },
      },
      null,
      2
    )
  )
  await $`bun install --ignore-scripts`.cwd(consumerDir)

  const probe = `
    const entries = ${JSON.stringify(ENTRY_POINTS)};
    let failed = 0;
    for (const entry of entries) {
      try {
        const m = await import(entry);
        const exportCount = Object.keys(m).length;
        if (exportCount === 0) {
          console.error('FAIL ' + entry + ' — 0 exports');
          failed++;
        } else {
          console.log('OK   ' + entry + ' — ' + exportCount + ' exports');
        }
      } catch (err) {
        console.error('FAIL ' + entry + ' — ' + err.message);
        failed++;
      }
    }
    if (failed > 0) process.exit(1);
  `
  await writeFile(join(consumerDir, 'probe.mjs'), probe)
  await $`bun probe.mjs`.cwd(consumerDir)
  console.log('pack smoke test: all entries resolved')
} finally {
  await rm(packDir, { recursive: true, force: true })
  await rm(consumerDir, { recursive: true, force: true })
}
