/**
 * RED conformance test for §3 six-field diagnostics (T-04394).
 *
 * WHY: These tests FAIL now because check-boundaries.ts and
 * check-manifest-edges.ts do not emit the six §3 diagnostic fields yet.
 * Larry's impl task upgrades the scripts to make them green.
 *
 * Mechanism: PLANT a temp source file under a real package, run the real
 * check from REPO_ROOT (no --root flag), assert the §3 fields appear for
 * the planted violation, then DELETE the fixture in afterEach (force-cleanup
 * even on assertion failure or uncaught throw).
 *
 * The six §3 fields (per archagent/agent-enablement/checks/conformance-diagnostic.md):
 *   1. file:line      — fixture path with a real line number (not just path)
 *   2. expected-vs-got — both "expected" and "got" phrasing in the diagnostic
 *   3. FIX →          — blessed correction line
 *   4. WHY →          — rationale pointer
 *   5. EXCEPTION →    — sanctioned exception channel
 *   6. do-not-suppress — explicit "do not suppress/silence/disable" wording
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Repo root — CWD for all subprocess invocations.
const REPO_ROOT = join(import.meta.dir, '..')

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

// Boundary fixture: forbidden 'agent-spaces' import in Harness Broker Protocol layer.
// The forbidden import is on line 3 (two comment lines precede it).
const BOUNDARY_FIXTURE_LINE = 3
const BOUNDARY_FIXTURE_REL = 'packages/harness-broker-protocol/src/__diag_fixture__.ts'
const BOUNDARY_FIXTURE_CONTENT = [
  '// __diag_fixture__: boundary violation sentinel — DO NOT COMMIT',
  '// Plants a forbidden import for §3 diagnostic conformance testing.',
  "import { x } from 'agent-spaces'", // line 3 — agent-spaces is forbidden in this layer
].join('\n')

// Manifest fixture: undeclared workspace import in agent-scope.
// 'spaces-harness-broker-protocol' is a real workspace pkg not in agent-scope/package.json.
// The undeclared import is on line 3 (two comment lines precede it).
const MANIFEST_FIXTURE_LINE = 3
const MANIFEST_FIXTURE_REL = 'packages/agent-scope/src/__diag_fixture__.ts'
const MANIFEST_FIXTURE_CONTENT = [
  '// __diag_fixture__: manifest violation sentinel — DO NOT COMMIT',
  '// Plants an undeclared workspace import for §3 diagnostic conformance testing.',
  "import { something } from 'spaces-harness-broker-protocol'", // line 3 — not in package.json
].join('\n')

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runScript(
  script: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', script], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

/** Combined stdout + stderr for assertion convenience. */
function out(r: { stdout: string; stderr: string }): string {
  return r.stdout + r.stderr
}

// ---------------------------------------------------------------------------
// Boundary: check-boundaries.ts
// ---------------------------------------------------------------------------

describe('check-boundaries.ts — §3 six-field diagnostics', () => {
  afterEach(async () => {
    // Force-remove even if the test threw before writeFile (force: true is a no-op if absent).
    await rm(join(REPO_ROOT, BOUNDARY_FIXTURE_REL), { force: true })
  })

  test('boundary violation carries all six §3 teaching fields', async () => {
    // Plant: forbidden 'agent-spaces' import on a deterministic line.
    await writeFile(join(REPO_ROOT, BOUNDARY_FIXTURE_REL), BOUNDARY_FIXTURE_CONTENT)

    const result = await runScript('scripts/check-boundaries.ts')
    const combined = out(result)

    // Must detect the violation and exit non-zero.
    expect(result.exitCode).not.toBe(0)

    // §3 field 1 — file:line (fixture path with concrete line number, not just path).
    expect(combined).toMatch(new RegExp(`__diag_fixture__\\.ts:${BOUNDARY_FIXTURE_LINE}`))

    // §3 field 2 — expected-vs-got: both "expected" and "got" appear in the diagnostic.
    expect(combined).toMatch(/expected/i)
    expect(combined).toMatch(/\bgot\b/i)

    // §3 field 3 — FIX → blessed correction line.
    expect(combined).toMatch(/FIX\s*(→|->)/i)

    // §3 field 4 — WHY → rationale pointer.
    expect(combined).toMatch(/WHY\s*(→|->)/i)

    // §3 field 5 — EXCEPTION → sanctioned exception channel.
    expect(combined).toMatch(/EXCEPTION\s*(→|->)/i)

    // §3 field 6 — do-not-suppress wording.
    expect(combined).toMatch(/do not (suppress|silence|disable)/i)
  })
})

// ---------------------------------------------------------------------------
// Manifest: check-manifest-edges.ts
// ---------------------------------------------------------------------------

describe('check-manifest-edges.ts — §3 six-field diagnostics', () => {
  afterEach(async () => {
    // Force-remove even if the test threw before writeFile (force: true is a no-op if absent).
    await rm(join(REPO_ROOT, MANIFEST_FIXTURE_REL), { force: true })
  })

  test('manifest missing-edge violation carries all six §3 teaching fields', async () => {
    // Plant: import 'spaces-harness-broker-protocol' — a real workspace package that is
    // NOT declared in packages/agent-scope/package.json (verified: only @types/bun + tsc).
    await writeFile(join(REPO_ROOT, MANIFEST_FIXTURE_REL), MANIFEST_FIXTURE_CONTENT)

    const result = await runScript('scripts/check-manifest-edges.ts')
    const combined = out(result)

    // Must detect the missing manifest edge and exit non-zero.
    expect(result.exitCode).not.toBe(0)

    // §3 field 1 — file:line (fixture path with concrete line number, not just path).
    expect(combined).toMatch(new RegExp(`__diag_fixture__\\.ts:${MANIFEST_FIXTURE_LINE}`))

    // §3 field 2 — expected-vs-got: both "expected" and "got" appear in the diagnostic.
    expect(combined).toMatch(/expected/i)
    expect(combined).toMatch(/\bgot\b/i)

    // §3 field 3 — FIX → blessed correction line.
    expect(combined).toMatch(/FIX\s*(→|->)/i)

    // §3 field 4 — WHY → rationale pointer.
    expect(combined).toMatch(/WHY\s*(→|->)/i)

    // §3 field 5 — EXCEPTION → sanctioned exception channel.
    expect(combined).toMatch(/EXCEPTION\s*(→|->)/i)

    // §3 field 6 — do-not-suppress wording.
    expect(combined).toMatch(/do not (suppress|silence|disable)/i)
  })
})
