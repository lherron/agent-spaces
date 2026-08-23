import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agentCatalogResponseSchema,
  agentInspectionRequestSchema,
} from 'spaces-aspc-protocol/agent-inspection'

describe('browser-safe agent-inspection entrypoint', () => {
  test('exposes the shared inspection schemas through the package subpath', () => {
    expect(
      agentInspectionRequestSchema.safeParse({
        schemaVersion: 'agent-inspection-request/v1',
        identifiers: {
          agentId: 'cody',
          projectId: 'agent-spaces',
          mode: 'query',
          scope: 'project',
          lane: 'default',
          harness: 'codex',
          frontend: 'codex-cli',
          interaction: 'interactive',
        },
        declaredOverrides: {},
      }).success
    ).toBe(true)
    expect(
      agentCatalogResponseSchema.safeParse({ projectId: null, agents: [], contexts: {} }).success
    ).toBe(true)
  })

  test('bundles for browsers without Node or harness-broker imports', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'aspc-browser-entry-'))
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, '../src/agent-inspection.ts')],
        outdir: outputDir,
        target: 'browser',
        format: 'esm',
      })
      expect(result.success).toBe(true)
      const output = await readFile(join(outputDir, 'agent-inspection.js'), 'utf8')
      expect(output).not.toContain('node:')
      expect(output).not.toContain('spaces-harness-broker-protocol')
      expect(output).not.toContain('crypto')
    } finally {
      await rm(outputDir, { recursive: true, force: true })
    }
  })
})
