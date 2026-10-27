import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packageDir = join(import.meta.dir, '..')
const repoRoot = join(import.meta.dir, '../../..')

describe('classic Node TypeScript resolution', () => {
  test('typechecks the browser-safe package subpath without modern module resolution', async () => {
    // The consumer lives in its own scratch dir; a node_modules symlink stands in for an
    // installed copy of the package, so classic resolution walks the published layout.
    const fixtureDir = await mkdtemp(join(tmpdir(), 'classic-node-types-'))
    try {
      await mkdir(join(fixtureDir, 'node_modules'))
      await symlink(packageDir, join(fixtureDir, 'node_modules', 'spaces-aspc-protocol'), 'dir')
      const inputPath = join(fixtureDir, 'consumer.ts')
      await writeFile(
        inputPath,
        [
          "import type { AspcAgentInspectionCatalogResponse } from 'spaces-aspc-protocol/agent-inspection'",
          "import { agentCatalogResponseSchema } from 'spaces-aspc-protocol/agent-inspection'",
          '',
          'const catalog: AspcAgentInspectionCatalogResponse = {',
          '  projectId: null,',
          '  agents: [],',
          '  contexts: {},',
          '}',
          'agentCatalogResponseSchema.parse(catalog)',
        ].join('\n')
      )

      const process = Bun.spawn(
        [
          'bunx',
          'tsc',
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          'false',
          '--target',
          'ES2022',
          '--module',
          'CommonJS',
          '--moduleResolution',
          'node',
          inputPath,
        ],
        { cwd: repoRoot, stderr: 'pipe', stdout: 'pipe' }
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect(`${stdout}${stderr}`).toBe('')
      expect(exitCode).toBe(0)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  }, 15_000)
})
