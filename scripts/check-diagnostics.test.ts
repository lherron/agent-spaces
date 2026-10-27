/**
 * RED conformance test for §3 six-field diagnostics (T-04394).
 *
 * WHY: These tests FAIL now because check-boundaries.ts and
 * check-manifest-edges.ts do not emit the six §3 diagnostic fields yet.
 * Larry's impl task upgrades the scripts to make them green.
 *
 * Mechanism: check-boundaries.ts and check-manifest-edges.ts scan the tree
 * under their cwd, so each test builds a fixture tree in a fresh temp dir and
 * runs the real script there. check-runtime-contract-harness-boundaries.ts
 * pins its scan root to the script's own location, so that test copies the
 * script to a scratch root and links its shared read-only libraries there.
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
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Repo root — CWD for all subprocess invocations.
const REPO_ROOT = join(import.meta.dir, '..')

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

// Boundary fixture: forbidden 'agent-spaces' import in Harness Broker Protocol layer.
// The forbidden import is on line 3 (two comment lines precede it).
const BOUNDARY_FIXTURE_LINE = 3
const BOUNDARY_FIXTURE_REL = 'contracts/harness-broker-protocol/src/__diag_fixture__.ts'
const BOUNDARY_FIXTURE_CONTENT = [
  '// __diag_fixture__: boundary violation sentinel — DO NOT COMMIT',
  '// Plants a forbidden import for §3 diagnostic conformance testing.',
  "import { x } from 'agent-spaces'", // line 3 — agent-spaces is forbidden in this layer
].join('\n')

// Manifest fixture: undeclared workspace import in agent-scope.
// 'spaces-harness-broker-protocol' is a real workspace pkg not in agent-scope/package.json.
// The undeclared import is on line 3 (two comment lines precede it).
const MANIFEST_FIXTURE_LINE = 3
const MANIFEST_FIXTURE_REL = 'contracts/agent-scope/src/__diag_fixture__.ts'
const MANIFEST_FIXTURE_CONTENT = [
  '// __diag_fixture__: manifest violation sentinel — DO NOT COMMIT',
  '// Plants an undeclared workspace import for §3 diagnostic conformance testing.',
  "import { something } from 'spaces-harness-broker-protocol'", // line 3 — not in package.json
].join('\n')

// Harness-contract fixture: forbidden HRC import in the testing harness surface.
// The forbidden import is on line 3 (two comment lines precede it).
const HARNESS_FIXTURE_LINE = 3
const HARNESS_FIXTURE_REL = 'compiler/agent-spaces/src/testing/__diag_fixture__.ts'
const HARNESS_FIXTURE_CONTENT = [
  '// __diag_fixture__: contract-harness boundary violation sentinel — DO NOT COMMIT',
  '// Plants a forbidden HRC import for §3 diagnostic conformance testing.',
  "import { x } from 'hrc-runtime'", // line 3 — hrc-* prefix is forbidden in this surface
].join('\n')

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runScript(
  script: string,
  cwd = REPO_ROOT
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', join(REPO_ROOT, script)], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

// The six workspace roots check-manifest-edges.ts reads; each must exist.
const WORKSPACE_ROOTS = ['contracts', 'core', 'drivers', 'compiler', 'harness', 'apps']

/** Builds a fixture tree in a fresh temp dir; returns its path. */
async function writeFixtureTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asp-diag-fixture-'))
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    await mkdir(join(root, workspaceRoot), { recursive: true })
  }
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true })
    await writeFile(join(root, relativePath), content)
  }
  return root
}

/** Combined stdout + stderr for assertion convenience. */
function out(r: { stdout: string; stderr: string }): string {
  return r.stdout + r.stderr
}

// ---------------------------------------------------------------------------
// Boundary: check-boundaries.ts
// ---------------------------------------------------------------------------

describe('check-boundaries.ts — §3 six-field diagnostics', () => {
  let fixtureRoot = ''
  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = ''
  })

  test('boundary violation carries all six §3 teaching fields', async () => {
    // Plant: forbidden 'agent-spaces' import on a deterministic line.
    fixtureRoot = await writeFixtureTree({
      [BOUNDARY_FIXTURE_REL]: BOUNDARY_FIXTURE_CONTENT,
    })

    const result = await runScript('scripts/check-boundaries.ts', fixtureRoot)
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
  let fixtureRoot = ''
  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = ''
  })

  test('manifest missing-edge violation carries all six §3 teaching fields', async () => {
    // Plant: import 'spaces-harness-broker-protocol' — a workspace package of the
    // fixture tree that agent-scope's package.json does NOT declare.
    fixtureRoot = await writeFixtureTree({
      'contracts/agent-scope/package.json': JSON.stringify({ name: 'agent-scope' }),
      'contracts/harness-broker-protocol/package.json': JSON.stringify({
        name: 'spaces-harness-broker-protocol',
      }),
      'contracts/harness-broker-protocol/src/index.ts': 'export const protocol = true\n',
      [MANIFEST_FIXTURE_REL]: MANIFEST_FIXTURE_CONTENT,
    })

    const result = await runScript('scripts/check-manifest-edges.ts', fixtureRoot)
    const combined = out(result)

    // Must detect the missing manifest edge and exit non-zero.
    expect(result.exitCode).not.toBe(0)

    // The missing dependency is named.
    expect(combined).toMatch(/spaces-harness-broker-protocol/)

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

// ---------------------------------------------------------------------------
// Harness contract: check-runtime-contract-harness-boundaries.ts
// ---------------------------------------------------------------------------

describe('check-runtime-contract-harness-boundaries.ts — §3 six-field diagnostics', () => {
  let fixtureRoot = ''
  afterEach(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('contract-harness no-hrc-import violation carries all six §3 teaching fields', async () => {
    fixtureRoot = await writeFixtureTree({
      [HARNESS_FIXTURE_REL]: HARNESS_FIXTURE_CONTENT,
      'compiler/agent-spaces/src/testing/control.ts': 'startInvocationFromRequest()\n',
    })
    await mkdir(join(fixtureRoot, 'scripts'), { recursive: true })
    await copyFile(
      join(REPO_ROOT, 'scripts/check-runtime-contract-harness-boundaries.ts'),
      join(fixtureRoot, 'scripts/check-runtime-contract-harness-boundaries.ts')
    )
    await symlink(join(REPO_ROOT, 'scripts/lib'), join(fixtureRoot, 'scripts/lib'))

    const proc = Bun.spawn(
      ['bun', join(fixtureRoot, 'scripts/check-runtime-contract-harness-boundaries.ts')],
      { cwd: fixtureRoot, stdout: 'pipe', stderr: 'pipe' }
    )
    await proc.exited
    const result = {
      exitCode: proc.exitCode ?? -1,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    }
    const combined = out(result)

    // Must detect the violation and exit non-zero.
    expect(result.exitCode).not.toBe(0)

    // §3 field 1 — file:line (fixture path with concrete line number, not just path).
    expect(combined).toMatch(new RegExp(`__diag_fixture__\\.ts:${HARNESS_FIXTURE_LINE}`))

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
