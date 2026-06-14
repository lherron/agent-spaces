/**
 * RED conformance test for doc reachability §3 diagnostics (T-04399).
 *
 * WHY: These tests FAIL now because scripts/check-doc-reachability.ts does
 * not exist yet. Larry's implementation task must add the real checker and
 * make these behavior-level tests green.
 *
 * Invocation contract for Phase 3:
 *   bun scripts/check-doc-reachability.ts --root <fixture-root> --doc <relative-doc>
 *
 * The checker must resolve routed relative markdown links from --doc within
 * --root, including optional #anchor fragments, and emit §3 diagnostics for
 * every unreachable target. The fixture is self-contained under scripts/ and
 * force-cleaned in afterEach even on assertion failure or throw.
 *
 * The six §3 fields (per archagent/agent-enablement/checks/conformance-diagnostic.md):
 *   1. file:line       - source doc path with a real line number
 *   2. expected-vs-got - both "expected" and "got" phrasing in the diagnostic
 *   3. FIX →           - blessed correction line
 *   4. WHY →           - rationale pointer
 *   5. EXCEPTION →     - sanctioned exception channel
 *   6. do-not-suppress - explicit "do not suppress/silence/disable" wording
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Repo root - CWD for all subprocess invocations.
const REPO_ROOT = join(import.meta.dir, '..')

// Self-contained fixture root. This directory must never be committed.
const FIXTURE_DIR_REL = 'scripts/__reach_fixture__'
const FIXTURE_ROOT = join(REPO_ROOT, FIXTURE_DIR_REL)

const MISSING_FILE_DOC = 'missing-file.md'
const MISSING_FILE_LINK_LINE = 5
const MISSING_FILE_CONTENT = [
  '# Missing File Fixture',
  '',
  'This good control link must not make the check fail: [good](./present.md#present-heading).',
  '',
  'This routed relative markdown link points at a missing file: [missing](./missing-target.md).',
  '',
].join('\n')

const MISSING_ANCHOR_DOC = 'missing-anchor.md'
const MISSING_ANCHOR_LINK_LINE = 5
const MISSING_ANCHOR_CONTENT = [
  '# Missing Anchor Fixture',
  '',
  'This good control link must not make the check fail: [good](./present.md#present-heading).',
  '',
  'This routed relative markdown link points at an existing file with a missing anchor: [bad anchor](./present.md#absent-heading).',
  '',
].join('\n')

const ALL_RESOLVE_DOC = 'all-resolve.md'
const ALL_RESOLVE_CONTENT = [
  '# All Resolve Fixture',
  '',
  'Relative file link resolves: [present](./present.md).',
  'Relative file plus anchor link resolves: [heading](./present.md#present-heading).',
  '',
].join('\n')

const PRESENT_CONTENT = [
  '# Present Heading',
  '',
  'This target exists for the reachability checker.',
  '',
  '## Secondary Heading',
  '',
].join('\n')

async function writeFixture(files: Record<string, string>): Promise<void> {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(join(FIXTURE_ROOT, relativePath), content)
  }
}

async function runReachabilityCheck(
  doc: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ['bun', 'scripts/check-doc-reachability.ts', '--root', FIXTURE_ROOT, '--doc', doc],
    {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode: proc.exitCode ?? -1, stdout, stderr }
}

/** Combined stdout + stderr for assertion convenience. */
function out(r: { stdout: string; stderr: string }): string {
  return r.stdout + r.stderr
}

function expectSixFieldDiagnostic(
  combined: string,
  doc: string,
  line: number,
  expectedPattern: RegExp,
  gotPattern: RegExp
): void {
  // §3 field 1 - file:line (fixture doc path with concrete line number, not just path).
  expect(combined).toMatch(new RegExp(`${doc}:${line}`))

  // §3 field 2 - expected-vs-got: both "expected" and "got" appear with useful detail.
  expect(combined).toMatch(expectedPattern)
  expect(combined).toMatch(gotPattern)

  // §3 field 3 - FIX → blessed correction line.
  expect(combined).toMatch(/FIX\s*(→|->)/i)

  // §3 field 4 - WHY → rationale pointer.
  expect(combined).toMatch(/WHY\s*(→|->)/i)

  // §3 field 5 - EXCEPTION → sanctioned exception channel.
  expect(combined).toMatch(/EXCEPTION\s*(→|->)/i)

  // §3 field 6 - do-not-suppress wording.
  expect(combined).toMatch(/do not (suppress|silence|disable)/i)
}

describe('check-doc-reachability.ts - routed markdown reachability', () => {
  afterEach(async () => {
    // Force-remove even if the test threw before writeFixture completed.
    await rm(FIXTURE_ROOT, { force: true, recursive: true })
  })

  test('missing routed relative markdown target exits 1 with all six §3 fields', async () => {
    await writeFixture({
      [MISSING_FILE_DOC]: MISSING_FILE_CONTENT,
      'present.md': PRESENT_CONTENT,
    })

    const result = await runReachabilityCheck(MISSING_FILE_DOC)
    const combined = out(result)

    expect(result.exitCode).toBe(1)
    expectSixFieldDiagnostic(
      combined,
      MISSING_FILE_DOC,
      MISSING_FILE_LINK_LINE,
      /expected.*\.\/missing-target\.md.*to resolve/i,
      /got.*missing file/i
    )
  })

  test('missing #anchor in existing markdown target exits 1 with all six §3 fields', async () => {
    await writeFixture({
      [MISSING_ANCHOR_DOC]: MISSING_ANCHOR_CONTENT,
      'present.md': PRESENT_CONTENT,
    })

    const result = await runReachabilityCheck(MISSING_ANCHOR_DOC)
    const combined = out(result)

    expect(result.exitCode).toBe(1)
    expectSixFieldDiagnostic(
      combined,
      MISSING_ANCHOR_DOC,
      MISSING_ANCHOR_LINK_LINE,
      /expected.*#absent-heading.*to match a heading/i,
      /got.*missing anchor/i
    )
  })

  test('all routed relative markdown links and anchors resolve cleanly', async () => {
    await writeFixture({
      [ALL_RESOLVE_DOC]: ALL_RESOLVE_CONTENT,
      'present.md': PRESENT_CONTENT,
    })

    const result = await runReachabilityCheck(ALL_RESOLVE_DOC)
    const combined = out(result)

    expect(combined).not.toMatch(/unreachable|missing file|missing anchor/i)
    expect(result.exitCode).toBe(0)
  })
})
