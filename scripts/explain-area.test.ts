/**
 * RED test for explain-area.ts file-mode (T-04440, Item 3).
 *
 * WHY: `bun scripts/explain-area.ts <file>` currently exits 1 with ENOTDIR.
 * `specEntries()` (~line 134) calls `collectTsFiles(areaAbsolute)` unconditionally;
 * `readdir` throws ENOTDIR when the path is a file, not a directory.
 * The usage string promises `<file|dir>` — file-mode is broken.
 *
 * This test FAILS before the fix (exit 1, ENOTDIR, no "specs:" section in output)
 * and passes once `specEntries()` guards the file case (mirror the `exportEntries`
 * guard at ~line 85).
 *
 * Contract after the fix:
 *   `bun scripts/explain-area.ts <file>` exits 0 and emits all five section
 *   headers that dir-mode prints: layer, exports, imported by, imports, specs.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// Repo root — CWD for all subprocess invocations.
const REPO_ROOT = join(import.meta.dir, '..')

// A real .ts source file that exists and is NOT a directory.
// Verified present: packages/harness-broker/src/runtime/env.ts
const FILE_TARGET = 'packages/harness-broker/src/runtime/env.ts'

type RunResult = { exitCode: number; stdout: string; stderr: string }

async function runExplainArea(target: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'scripts/explain-area.ts', target], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

describe('explain-area.ts — file-mode', () => {
  test('exits 0 and prints all section headers when given a .ts file path', async () => {
    const result = await runExplainArea(FILE_TARGET)

    // Currently exits 1 with ENOTDIR — this assertion fails before the fix.
    expect(result.exitCode).toBe(0)

    // All five section headers that dir-mode prints must appear in stdout.
    // Before the fix, "specs:" is never reached (crash in specEntries).
    expect(result.stdout).toMatch(/^layer:/m)
    expect(result.stdout).toMatch(/^exports:/m)
    expect(result.stdout).toMatch(/^imported by:/m)
    expect(result.stdout).toMatch(/^imports:/m)
    expect(result.stdout).toMatch(/^specs:/m)
  })
})
