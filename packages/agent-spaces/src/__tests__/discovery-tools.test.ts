/**
 * Regression guard for scripts/find-entry-points.ts and scripts/explain-area.ts (T-04397).
 *
 * WHY: These tests FAIL now because the two discovery scripts do not exist yet.
 * Larry's impl task creates them to make these tests green.
 *
 * Contract (structural — NOT a brittle exact file list):
 *
 *   find-entry-points <topic>
 *     exit 0; stdout non-empty; >=1 line matches /^.+:\d+\t/;
 *     the path portion of >=1 hit exists on disk;
 *     stdout contains "packages/cli" (stable self-command hit).
 *
 *   explain-area <file|dir>
 *     exit 0; stdout contains section markers
 *       (layer: / exports: / imported by: / imports: / specs:);
 *     >=1 line matches /packages\/.+:\d+/;
 *     the "imported by:" section is non-empty (agent-scope is widely imported).
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Repo root — CWD for all subprocess invocations.
// Test file lives at packages/agent-spaces/src/__tests__/ → 4 levels up.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

async function runScript(
  script: string,
  args: string[] = []
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

describe('discovery tools (T-04397)', () => {
  test('find-entry-points: exits 0, emits file:line\\trole hits, contains packages/cli', async () => {
    // topic "self" → the asp self command group under packages/cli is a stable hit
    const { exitCode, stdout } = await runScript('find-entry-points.ts', ['self'])

    expect(exitCode).toBe(0)
    expect(stdout.trim()).not.toBe('')

    // At least one line must match the locus format: <path>:<line>\t<role>
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(1)

    const locusLines = lines.filter((l) => /^.+:\d+\t/.test(l))
    expect(locusLines.length).toBeGreaterThanOrEqual(1)

    // The file portion of at least one locus must exist on disk
    const hitExists = locusLines.some((line) => {
      const file = line.split(':')[0] ?? ''
      return file.length > 0 && existsSync(join(REPO_ROOT, file))
    })
    expect(hitExists).toBe(true)

    // Stable known hit: asp self command group lives under packages/cli
    expect(stdout).toContain('packages/cli')
  })

  test('explain-area: exits 0, emits all section markers, imported-by section is non-empty', async () => {
    const { exitCode, stdout } = await runScript('explain-area.ts', ['packages/agent-scope'])

    expect(exitCode).toBe(0)

    // Required section markers
    expect(stdout).toMatch(/^layer:/m)
    expect(stdout).toContain('exports:')
    expect(stdout).toContain('imported by:')
    expect(stdout).toContain('imports:')
    expect(stdout).toContain('specs:')

    // At least one entry uses repo-relative path:line format
    expect(stdout).toMatch(/packages\/.+:\d+/)

    // agent-scope is widely imported — the "imported by:" section must not be empty
    const importedByIdx = stdout.indexOf('imported by:')
    expect(importedByIdx).toBeGreaterThanOrEqual(0)
    const afterSection = stdout.slice(importedByIdx + 'imported by:'.length)
    expect(afterSection).toMatch(/packages\/.+:\d+/)
  }, 30_000)
})
