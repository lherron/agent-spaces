/**
 * RED test suite for scripts/check-rule-authoring.ts (S8 authoring-ledger meta-check).
 *
 * WHY: These tests FAIL now because check-rule-authoring.ts does not exist yet
 * and checks/AUTHORING.md has not been created. Larry implements both in Phase 2.
 *
 * Encodes all 6 daedalus-required cases from T-04406:
 *   1. green path   — fixture justfile check: recipe with N checks + AUTHORING.md with
 *                     exactly those N rows, all cells valid → exit 0.
 *   2. missing-row  — recipe has `bun scripts/check-example.ts` with NO ledger row → exit 1;
 *                     diagnostic carries all seven §3 fields.
 *   3. add-row green — same fixture + the matching ledger row → exit 0.
 *   4. stale-row    — ledger has a `check` key absent from the recipe → exit 1.
 *   5. schema reds  — each FAILS independently:
 *                       5a. malformed / wrong-order header
 *                       5b. duplicate `check` key
 *                       5c. invalid rung (e.g., `BOGUS`)
 *                       5d. filler sunset-condition (`n/a`)
 *   6. integration  — assert real `justfile` check: recipe contains
 *                     `bun scripts/check-rule-authoring.ts` (red until Phase 2 wires it).
 *
 * ## Flag contract (larry implements to this exact interface)
 *
 *   bun scripts/check-rule-authoring.ts [--root <dir>]
 *
 *   --root <dir>   Fixture root. The script resolves:
 *                    <root>/justfile           — source of the check: recipe
 *                    <root>/checks/AUTHORING.md — authoring ledger
 *                  Defaults to the repo root (CWD of the invoking process) when omitted.
 *
 *   Exit 0 = all invariants satisfied.
 *   Exit 1 = at least one violation; teaching diagnostic on stdout/stderr.
 *
 * ## AUTHORING.md table contract
 *
 *   Header MUST be EXACTLY (pipe-delimited markdown table, in this order):
 *     | check | rule | why | bad | good | exception | rung | sunset-condition |
 *
 *   Each data row:
 *     check            = exact script basename (e.g. check-boundaries.ts)
 *     rule/why/bad/good/exception = non-empty strings
 *     rung             ∈ {ELIMINATE, GUARD, WARN, TRAIN, TACIT}
 *     sunset-condition = actionable text — filler (none/never/n/a/empty/—/N/A) FAILS
 *
 * ## §3 diagnostic shape (required on any exit-1)
 *
 *   The seven required fields mirror archagent/agent-enablement/checks/conformance-diagnostic.md:
 *     1. what-failed / rule-code  — which invariant was violated
 *     2. file:line                — the AUTHORING.md path with a concrete line number
 *     3. expected-vs-got          — both "expected" and "got" phrasing
 *     4. FIX →                   — blessed correction action
 *     5. WHY →                   — rationale pointer
 *     6. EXCEPTION →             — sanctioned exception channel
 *     7. do-not-suppress line    — explicit wording ("do not suppress/silence/disable")
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Repo root — CWD for all subprocess invocations.
const REPO_ROOT = join(import.meta.dir, '..')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCheck(
  fixtureDir: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'scripts/check-rule-authoring.ts', '--root', fixtureDir], {
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
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Write a minimal justfile with a `check:` recipe listing the given basenames.
 * Each basename is written as `bun scripts/<basename>`.
 */
async function writeJustfile(dir: string, checkBasenames: string[]): Promise<void> {
  const lines = ['check:']
  for (const b of checkBasenames) {
    lines.push(`    bun scripts/${b}`)
  }
  // Add a non-check recipe to ensure the parser only processes `check:`.
  lines.push('')
  lines.push('verify: check')
  lines.push('    echo "verify done"')
  await writeFile(join(dir, 'justfile'), lines.join('\n'))
}

/**
 * Write checks/AUTHORING.md with the given rows.
 * Each row is { check, rule, why, bad, good, exception, rung, sunsetCondition }.
 */
async function writeAuthoring(
  dir: string,
  rows: Array<{
    check: string
    rule: string
    why: string
    bad: string
    good: string
    exception: string
    rung: string
    sunsetCondition: string
  }>
): Promise<void> {
  const checksDir = join(dir, 'checks')
  await mkdir(checksDir, { recursive: true })

  const header = '| check | rule | why | bad | good | exception | rung | sunset-condition |'
  const separator = '|-------|------|-----|-----|------|-----------|------|-----------------|'
  const dataRows = rows.map(
    (r) =>
      `| ${r.check} | ${r.rule} | ${r.why} | ${r.bad} | ${r.good} | ${r.exception} | ${r.rung} | ${r.sunsetCondition} |`
  )

  const content = ['# Check Authoring Ledger', '', header, separator, ...dataRows].join('\n')

  await writeFile(join(checksDir, 'AUTHORING.md'), content)
}

/** A valid row for check-alpha.ts used across multiple tests. */
const VALID_ROW_ALPHA = {
  check: 'check-alpha.ts',
  rule: 'R-ALPHA-01',
  why: 'Prevents alpha-layer boundary violations in CI',
  bad: 'import across alpha/beta boundary without approval',
  good: 'use the approved alpha public API only',
  exception: 'EXCEPTION(T-00001): explicit ticket required',
  rung: 'GUARD',
  sunsetCondition: 'Remove when alpha/beta boundary is enforced by the type system',
}

/** A valid row for check-beta.ts used in multi-check green path. */
const VALID_ROW_BETA = {
  check: 'check-beta.ts',
  rule: 'R-BETA-01',
  why: 'Prevents beta-layer drift from declared manifest',
  bad: 'undeclared workspace package import in beta scope',
  good: 'declare all imports in package.json before use',
  exception: 'EXCEPTION(T-00002): explicit ticket required',
  rung: 'WARN',
  sunsetCondition: 'Remove when manifest drift is caught by bun install strict mode',
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('check-rule-authoring.ts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cra-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Case 1 — green path: recipe and ledger are in sync, all cells valid
  // -------------------------------------------------------------------------
  test('case 1: green path — recipe and ledger in sync with valid rows exits 0', async () => {
    await writeJustfile(tmpDir, ['check-alpha.ts', 'check-beta.ts'])
    await writeAuthoring(tmpDir, [VALID_ROW_ALPHA, VALID_ROW_BETA])

    const result = await runCheck(tmpDir)
    expect(result.exitCode).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Case 2 — missing-row red: recipe check has no ledger entry
  // -------------------------------------------------------------------------
  test('case 2: missing ledger row → exit 1 with §3 diagnostic', async () => {
    // Recipe has check-alpha.ts but AUTHORING.md only covers check-beta.ts.
    await writeJustfile(tmpDir, ['check-alpha.ts', 'check-beta.ts'])
    await writeAuthoring(tmpDir, [VALID_ROW_BETA]) // check-alpha.ts is MISSING

    const result = await runCheck(tmpDir)
    const combined = out(result)

    // Must fail.
    expect(result.exitCode).not.toBe(0)

    // Must name the uncatalogued script.
    expect(combined).toMatch(/check-alpha\.ts/)

    // §3 field 1 — what-failed / rule-code.
    expect(combined).toMatch(/missing|uncatalogued|not in ledger/i)

    // §3 field 2 — file:line (AUTHORING.md with a concrete line number).
    expect(combined).toMatch(/AUTHORING\.md:\d+/)

    // §3 field 3 — expected-vs-got.
    expect(combined).toMatch(/expected/i)
    expect(combined).toMatch(/\bgot\b/i)

    // §3 field 4 — FIX →.
    expect(combined).toMatch(/FIX\s*(→|->)/i)

    // §3 field 5 — WHY →.
    expect(combined).toMatch(/WHY\s*(→|->)/i)

    // §3 field 6 — EXCEPTION →.
    expect(combined).toMatch(/EXCEPTION\s*(→|->)/i)

    // §3 field 7 — do-not-suppress wording.
    expect(combined).toMatch(/do not (suppress|silence|disable)/i)
  })

  // -------------------------------------------------------------------------
  // Case 3 — add-row green: adding the missing row makes it pass
  // -------------------------------------------------------------------------
  test('case 3: after adding the missing row the check exits 0', async () => {
    // Same recipe as case 2 but now AUTHORING.md has BOTH rows.
    await writeJustfile(tmpDir, ['check-alpha.ts', 'check-beta.ts'])
    await writeAuthoring(tmpDir, [VALID_ROW_ALPHA, VALID_ROW_BETA])

    const result = await runCheck(tmpDir)
    expect(result.exitCode).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Case 4 — stale-row red: ledger references a script not in the recipe
  // -------------------------------------------------------------------------
  test('case 4: stale ledger row (script absent from recipe) → exit 1', async () => {
    // Recipe only has check-alpha.ts; ledger has check-alpha.ts AND check-ghost.ts.
    await writeJustfile(tmpDir, ['check-alpha.ts'])
    await writeAuthoring(tmpDir, [
      VALID_ROW_ALPHA,
      {
        check: 'check-ghost.ts',
        rule: 'R-GHOST-01',
        why: 'Was useful once',
        bad: 'doing the thing',
        good: 'not doing the thing',
        exception: 'EXCEPTION(T-99999): rare edge case',
        rung: 'GUARD',
        sunsetCondition: 'Remove when ghost functionality is fully retired in Q4',
      },
    ])

    const result = await runCheck(tmpDir)
    const combined = out(result)

    expect(result.exitCode).not.toBe(0)
    // Must name the stale entry.
    expect(combined).toMatch(/check-ghost\.ts/)
    // Must indicate the row is stale / not in recipe.
    expect(combined).toMatch(/stale|not in (recipe|check:)|absent from/i)
  })

  // -------------------------------------------------------------------------
  // Case 5 — schema reds: each invalid schema shape fails independently
  // -------------------------------------------------------------------------
  describe('case 5: schema violations', () => {
    // 5a — wrong-order / malformed header
    test('5a: wrong-order header → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await mkdir(join(tmpDir, 'checks'), { recursive: true })

      // Header has columns in wrong order (rule before check).
      const badHeader = '| rule | check | why | bad | good | exception | rung | sunset-condition |'
      const separator = '|------|-------|-----|-----|------|-----------|------|-----------------|'
      const row =
        '| R-ALPHA-01 | check-alpha.ts | why text | bad text | good text | EXCEPTION(T-01): reason | GUARD | Remove when done |'

      await writeFile(
        join(tmpDir, 'checks', 'AUTHORING.md'),
        ['# Check Authoring Ledger', '', badHeader, separator, row].join('\n')
      )

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/header|column order|expected.*check.*rule/i)
    })

    // 5b — duplicate `check` key
    test('5b: duplicate check key → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await writeAuthoring(tmpDir, [
        VALID_ROW_ALPHA,
        // Same check basename again — duplicate.
        { ...VALID_ROW_ALPHA, rule: 'R-ALPHA-02-DUP' },
      ])

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/duplicate|check-alpha\.ts/i)
    })

    // 5c — invalid rung value
    test('5c: invalid rung value (BOGUS) → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await writeAuthoring(tmpDir, [{ ...VALID_ROW_ALPHA, rung: 'BOGUS' }])

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/rung|BOGUS|ELIMINATE|GUARD|WARN|TRAIN|TACIT/i)
    })

    // 5d — filler sunset-condition
    test('5d: filler sunset-condition (n/a) → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await writeAuthoring(tmpDir, [{ ...VALID_ROW_ALPHA, sunsetCondition: 'n/a' }])

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/sunset.condition|filler|actionable|n\/a/i)
    })

    // 5e — empty sunset-condition (catches '' and whitespace-only)
    test('5e: empty sunset-condition → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await writeAuthoring(tmpDir, [{ ...VALID_ROW_ALPHA, sunsetCondition: '' }])

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/sunset.condition|empty|required/i)
    })

    // 5f — filler sunset-condition variant: 'none'
    test('5f: filler sunset-condition (none) → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await writeAuthoring(tmpDir, [{ ...VALID_ROW_ALPHA, sunsetCondition: 'none' }])

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/sunset.condition|filler|actionable|none/i)
    })

    // 5g — filler sunset-condition variant: 'never'
    test('5g: filler sunset-condition (never) → exit 1', async () => {
      await writeJustfile(tmpDir, ['check-alpha.ts'])
      await writeAuthoring(tmpDir, [{ ...VALID_ROW_ALPHA, sunsetCondition: 'never' }])

      const result = await runCheck(tmpDir)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/sunset.condition|filler|actionable|never/i)
    })
  })

  // -------------------------------------------------------------------------
  // Case 6 — integration: real justfile must wire check-rule-authoring.ts
  // -------------------------------------------------------------------------
  test('case 6 (integration): real justfile check: recipe includes check-rule-authoring.ts', async () => {
    // This test reads the REAL repo justfile, not a fixture.
    // It FAILS until Phase 2 (larry) wires check-rule-authoring.ts into just check:.
    const justfileContent = await readFile(join(REPO_ROOT, 'justfile'), 'utf-8')

    // Extract the check: recipe lines (between "check:" and the next recipe).
    const checkRecipeMatch = justfileContent.match(/^check:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)
    expect(checkRecipeMatch).not.toBeNull()

    const recipeBody = checkRecipeMatch![1]
    expect(recipeBody).toMatch(/bun scripts\/check-rule-authoring\.ts/)
  })
})
