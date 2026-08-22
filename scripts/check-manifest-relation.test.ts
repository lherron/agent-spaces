/**
 * Anti-flattening relation guard for scripts/check-manifest-edges.ts (T-04420 Phase 2).
 *
 * WHY THIS EXISTS: When check-manifest-edges.ts is migrated onto the shared boundary-guard
 * engine (Phase 2), the HIGH-RISK failure mode daedalus flagged is silently FLATTENING the
 * check from a RELATION (workspace-import MUST be declared in that package's package.json)
 * into a plain token/forbidden-import match (any source file importing a workspace package
 * name is flagged, regardless of whether it IS declared). A flattened implementation
 * preserves the positive-violation shape but breaks the NEGATIVE CONTROL: a declared
 * import would be wrongly flagged.
 *
 * The existing check-diagnostics.test.ts only plants ONE undeclared import. A flattened
 * token-matcher would still pass that test. This file pins the RELATION itself so a
 * flattened migration is RED.
 *
 * Mechanism: plant temp fixture files under real packages, run check-manifest-edges.ts
 * via Bun.spawn from REPO_ROOT (same pattern as check-diagnostics.test.ts), assert the
 * relation semantics, delete fixtures in afterEach (force-cleanup even on throw).
 *
 * EXPECTED STATE: these tests ALL PASS against the current (un-migrated)
 * check-manifest-edges.ts. They must STAY GREEN after Phase 2 migration.
 * A flattened migration makes the NEGATIVE CONTROL test RED.
 *
 * Workspace pair for negative control:
 *   spaces-harness-broker-client (packages/harness-broker-client)
 *   declares spaces-harness-broker-protocol in its package.json "dependencies".
 *   → importing it in that package's src/ must NOT be flagged (IS declared).
 *   → a flattened token-matcher would wrongly flag it → this test turns RED.
 *
 * For the positive control: packages/agent-scope declares NO workspace deps, so
 * importing spaces-harness-broker-protocol there triggers the relation.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Repo root — CWD for all subprocess invocations.
const REPO_ROOT = join(import.meta.dir, '..')

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

// NEGATIVE CONTROL: spaces-harness-broker-protocol IS declared in
// spaces-harness-broker-client/package.json "dependencies". Importing it
// in that package's src/ must NOT produce any diagnostic.
// A flattened token-matcher would wrongly flag this → makes this test RED.
const NEG_FIXTURE_REL = 'packages/harness-broker-client/src/__relation_fixture__.ts'
const NEG_FIXTURE_CONTENT = [
  '// __relation_fixture__: declared workspace import — DO NOT COMMIT',
  '// Negative control: spaces-harness-broker-protocol IS declared in',
  '// spaces-harness-broker-client/package.json. Must NOT be flagged.',
  "import type { HarnessSocketOptions } from 'spaces-harness-broker-protocol'",
].join('\n')

// POSITIVE CONTROL: spaces-harness-broker-protocol is NOT declared in
// agent-scope/package.json (which has no workspace deps at all).
// The relation fires: check-manifest-edges.ts must flag this with file:line.
const POS_FIXTURE_REL = 'packages/agent-scope/src/__relation_fixture__.ts'
const POS_FIXTURE_LINE = 4 // three comment lines precede the import
const POS_FIXTURE_CONTENT = [
  '// __relation_fixture__: undeclared workspace import — DO NOT COMMIT',
  '// Positive control: spaces-harness-broker-protocol is NOT declared in',
  '// agent-scope/package.json. Must be flagged with file:line.',
  "import type { HarnessSocketOptions } from 'spaces-harness-broker-protocol'",
].join('\n')

// IGNORED KINDS: relative, node:, self-import, scoped non-workspace, bare non-workspace.
// Planted in agent-scope/src/ so the self-import (agent-scope) is the package itself.
// None of these must ever appear in check-manifest-edges.ts output.
const IGNORED_FIXTURE_REL = 'packages/agent-scope/src/__relation_ignored_fixture__.ts'
const IGNORED_FIXTURE_CONTENT = [
  '// __relation_ignored_fixture__: import kinds that must never be flagged — DO NOT COMMIT',
  "import type { ScopeRef } from './scope-ref'", // relative → ignored (starts with '.')
  "import { readFile } from 'node:fs/promises'", // node: built-in → ignored
  "import type { ScopeRef as SR } from 'agent-scope'", // self-import → ignored (same pkg name)
  "import type { Foo } from '@types/bun'", // scoped, not a workspace package → ignored
  "import type { Bar } from 'typescript'", // bare non-workspace → ignored
].join('\n')

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runManifestCheck(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'scripts/check-manifest-edges.ts'], {
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
// Test 1: NEGATIVE CONTROL — declared import must NOT be flagged
// (anti-flattening guard: a token-matcher would wrongly flag this)
// ---------------------------------------------------------------------------

describe('check-manifest-edges.ts — NEGATIVE CONTROL: declared import not flagged', () => {
  afterEach(async () => {
    await rm(join(REPO_ROOT, NEG_FIXTURE_REL), { force: true })
  })

  test('declared workspace import is NOT flagged (anti-flattening guard)', async () => {
    // Plant: import spaces-harness-broker-protocol in harness-broker-client/src/.
    // spaces-harness-broker-protocol IS declared in harness-broker-client/package.json
    // "dependencies" → the relation holds → no diagnostic expected.
    // A flattened token-matcher would flag ANY occurrence of 'spaces-harness-broker-protocol'
    // in source files, making this assertion fail.
    await writeFile(join(REPO_ROOT, NEG_FIXTURE_REL), NEG_FIXTURE_CONTENT)

    const result = await runManifestCheck()
    const combined = out(result)

    // The check must exit 0 — no violations detected (clean tree + declared import).
    expect(result.exitCode).toBe(0)

    // The fixture file must NOT appear in any diagnostic output.
    // This is the key anti-flattening assertion: a token-matcher ignoring the manifest
    // would wrongly report '__relation_fixture__.ts' here.
    expect(combined).not.toMatch(/__relation_fixture__\.ts/)

    // Sanity: the check reported clean (not silent failure).
    expect(combined).toMatch(/Manifest edge check passed\./i)
  })
})

// ---------------------------------------------------------------------------
// Test 2: POSITIVE — undeclared import fires the relation with file:line
// ---------------------------------------------------------------------------

describe('check-manifest-edges.ts — POSITIVE: undeclared import fires relation', () => {
  afterEach(async () => {
    await rm(join(REPO_ROOT, POS_FIXTURE_REL), { force: true })
  })

  test('undeclared workspace import is flagged with package name and file:line', async () => {
    // Plant: import spaces-harness-broker-protocol in agent-scope/src/.
    // agent-scope declares NO workspace deps → the relation fires.
    await writeFile(join(REPO_ROOT, POS_FIXTURE_REL), POS_FIXTURE_CONTENT)

    const result = await runManifestCheck()
    const combined = out(result)

    // Must detect the undeclared edge and exit non-zero.
    expect(result.exitCode).not.toBe(0)

    // The missing dependency name must appear in the diagnostic.
    expect(combined).toMatch(/spaces-harness-broker-protocol/)

    // The fixture path with concrete line number must appear (file:line).
    expect(combined).toMatch(new RegExp(`__relation_fixture__\\.ts:${POS_FIXTURE_LINE}`))
  })
})

// ---------------------------------------------------------------------------
// Test 3: IGNORED KINDS — relative, node:, self, scoped, bare non-workspace
// ---------------------------------------------------------------------------

describe('check-manifest-edges.ts — IGNORED KINDS: non-workspace imports never flagged', () => {
  afterEach(async () => {
    await rm(join(REPO_ROOT, IGNORED_FIXTURE_REL), { force: true })
  })

  test('relative, node:, self-import, scoped non-workspace, bare non-workspace are all ignored', async () => {
    // Plant a fixture in agent-scope/src/ containing only import kinds that must be ignored.
    await writeFile(join(REPO_ROOT, IGNORED_FIXTURE_REL), IGNORED_FIXTURE_CONTENT)

    const result = await runManifestCheck()
    const combined = out(result)

    // Must exit 0 — none of the planted import kinds is a workspace-undeclared edge.
    expect(result.exitCode).toBe(0)

    // The ignored-kinds fixture must not appear in any diagnostic output.
    expect(combined).not.toMatch(/__relation_ignored_fixture__\.ts/)
  })
})

// ---------------------------------------------------------------------------
// Test 4: MANIFEST-LESS PACKAGE DIRECTORY — skipped, never a crash
// ---------------------------------------------------------------------------

// A `packages/<name>/` directory with no package.json is not a workspace package.
// It occurs legitimately mid-split, when a new package's tests land before its
// manifest does. `workspacePackages()` must skip it. Before this guard existed,
// `readPackageInfo` let the ENOENT escape and the whole check died with an
// unhandled error — turning "this directory is not a package yet" into a total
// failure of the edge relation.
const MANIFESTLESS_DIR_REL = 'packages/__manifestless_fixture__'
const MANIFESTLESS_FILE_REL = `${MANIFESTLESS_DIR_REL}/test/placeholder.test.ts`
const MANIFESTLESS_FILE_CONTENT = [
  '// __manifestless_fixture__: package dir with no package.json — DO NOT COMMIT',
  'export const placeholder = true',
].join('\n')

describe('check-manifest-edges.ts — MANIFEST-LESS DIR: skipped, not a crash', () => {
  afterEach(async () => {
    await rm(join(REPO_ROOT, MANIFESTLESS_DIR_REL), { force: true, recursive: true })
  })

  test('a packages/ directory without package.json is skipped and the check still passes', async () => {
    await mkdir(join(REPO_ROOT, MANIFESTLESS_DIR_REL, 'test'), { recursive: true })
    await writeFile(join(REPO_ROOT, MANIFESTLESS_FILE_REL), MANIFESTLESS_FILE_CONTENT)

    const result = await runManifestCheck()
    const combined = out(result)

    // Skipped, not fatal: the relation check completes and reports clean.
    expect(result.exitCode).toBe(0)
    expect(combined).toMatch(/Manifest edge check passed\./i)

    // And it must not die on the absent manifest.
    expect(combined).not.toMatch(/ENOENT/)
    expect(combined).not.toMatch(/__manifestless_fixture__/)
  })
})
