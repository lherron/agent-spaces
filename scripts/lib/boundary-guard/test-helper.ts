/**
 * Vendored boundary-guard test helper.
 *
 * Catalog entry id: typescript/boundary-checks/boundary-guard
 * Archagent source: db405a216b06e74da6c4be2f104f04747a4e5d96
 *   agent-enablement/catalog/typescript/boundary-checks/boundary-guard/test-helper.ts
 * Agent-spaces adoption commit: see git log for this file.
 * Exercised by: bun scripts/check-boundaries.ts;
 *   bun scripts/check-runtime-contract-harness-boundaries.ts;
 *   bun scripts/check-manifest-edges.ts; just check; lefthook pre-commit.
 */
import { expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseGuardDiagnostics, runGuard } from './engine.ts'
import type { Guard, GuardDiagnostic } from './engine.ts'

export interface Fixture {
  files?: { rel: string; content: string }[]
  expectExit: 0 | 1
}

export async function assertGuardDiagnostics(
  g: Guard,
  fixture: Fixture
): Promise<{ exitCode: number; diagnostics: GuardDiagnostic[]; stderr: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'boundary-guard-'))
  let stderr = ''

  try {
    for (const file of fixture.files ?? []) {
      const abs = join(repoRoot, file.rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, file.content, 'utf8')
    }

    const exitCode = await runGuard(
      { ...g, repoRoot },
      {
        emit(text) {
          stderr += `${text}\n`
        },
      }
    )
    const diagnostics = parseGuardDiagnostics(stderr)

    expect(exitCode).toBe(fixture.expectExit)
    return { exitCode, diagnostics, stderr }
  } finally {
    await rm(repoRoot, { recursive: true, force: true })
  }
}
