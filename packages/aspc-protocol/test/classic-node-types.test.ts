import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('classic Node TypeScript resolution', () => {
  test('typechecks the browser-safe package subpath without modern module resolution', async () => {
    const fixtureDir = await mkdtemp(join(import.meta.dir, '.classic-node-types-'))
    try {
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
        { cwd: join(import.meta.dir, '../../..'), stderr: 'pipe', stdout: 'pipe' }
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
