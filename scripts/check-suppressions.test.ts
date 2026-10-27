/**
 * RED test suite for scripts/check-suppressions.ts (S5 suppression-cost guard).
 *
 * WHY: These tests FAIL now because check-suppressions.ts does not exist yet.
 * Larry implements scripts/check-suppressions.ts to make them green.
 *
 * Encodes the invariant cases from the daedalus RULING (T-04389):
 *   2. A new biome-ignore, @ts-ignore, or prose @ts-expect-error (not in baseline,
 *      no EXCEPTION) → FAILS with rich diagnostic.
 *   3. A preceding-line or same-line EXCEPTION annotation → PASSES.
 *   4. Existing grandfathered suppression PASSES via baseline (no EXCEPTION needed).
 *   5. Duplicate identical same-file suppression (count > baseline) → FAILS (multiset teeth).
 *   7. dist/, nested node_modules/, and .md files are excluded from the scan.
 *   8. --update-baseline is idempotent: stable sorted output, no diff on immediate rerun.
 *
 * Contract larry must honour:
 *   bun scripts/check-suppressions.ts [--root <dir>] [--baseline <path>] [--update-baseline]
 *   Exit 0 = pass, non-zero = fail. Teaching diagnostic on failure.
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
  fixtureDir: string,
  baselinePath: string,
  updateBaseline = false
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = [
    'bun',
    'scripts/check-suppressions.ts',
    '--root',
    fixtureDir,
    '--baseline',
    baselinePath,
  ]
  if (updateBaseline) args.push('--update-baseline')

  const proc = Bun.spawn(args, {
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
// Fixtures
// ---------------------------------------------------------------------------

describe('check-suppressions.ts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Case 2 — a new suppression without EXCEPTION → FAILS with rich diagnostic
  // -------------------------------------------------------------------------
  const unexceptedSuppressions: Array<{
    name: string
    file: string
    lines: string[]
    kind: RegExp
  }> = [
    {
      name: 'a bare biome-ignore',
      file: 'new-suppression.ts',
      lines: [
        'const arr: string[] = []',
        '// biome-ignore lint/style/noNonNullAssertion: prose without exception',
        'const y = arr[0]',
      ],
      kind: /biome-ignore/,
    },
    {
      name: 'a @ts-ignore',
      file: 'ts-ignore.ts',
      lines: ['// @ts-ignore', 'const _x: string = 42 as unknown as string'],
      kind: /@ts-ignore/,
    },
    {
      // Prose after @ts-expect-error is NOT a sanctioned EXCEPTION channel.
      name: 'a @ts-expect-error with a prose reason',
      file: 'ts-expect-prose.ts',
      lines: [
        '// @ts-expect-error: normal prose reason — not a sanctioned EXCEPTION',
        'const _x: string = 42 as unknown as string',
      ],
      kind: /@ts-expect-error/,
    },
  ]

  test.each(unexceptedSuppressions)(
    'case 2: $name with no baseline entry and no EXCEPTION fails with diagnostics',
    async ({ file, lines, kind }) => {
      const srcDir = join(tmpDir, 'src')
      await mkdir(srcDir, { recursive: true })
      await writeFile(join(srcDir, file), lines.join('\n'))

      // Empty baseline — this suppression is not grandfathered.
      await writeFile(join(tmpDir, 'baseline.json'), JSON.stringify({ suppressions: [] }))

      const result = await runCheck(tmpDir, join(tmpDir, 'baseline.json'))
      const combined = out(result)

      // Must fail
      expect(result.exitCode).not.toBe(0)
      // Must report file reference
      expect(combined).toContain(file)
      // Must echo the suppression kind (not just a bun module-not-found error)
      expect(combined).toMatch(kind)
      // Must include the blessed fix
      expect(combined).toMatch(/EXCEPTION\s*\(.*\).*reason|add EXCEPTION/i)
      // Must carry the do-not-suppress-this-check note
      expect(combined).toMatch(/do not suppress|check-suppressions/i)
    }
  )

  // -------------------------------------------------------------------------
  // Case 3 — an adjacent EXCEPTION annotation → PASSES
  // -------------------------------------------------------------------------
  const exceptedSuppressions: Array<{ name: string; file: string; lines: string[] }> = [
    {
      // EXCEPTION on the immediately preceding comment line — no blank line between.
      name: 'an EXCEPTION on the preceding line',
      file: 'excepted.ts',
      lines: [
        'const arr: string[] = []',
        '// EXCEPTION(T-04389): real reason for keeping this suppression',
        '// biome-ignore lint/style/noNonNullAssertion: needed here',
        'const y = arr[0]',
      ],
    },
    {
      // EXCEPTION annotation on the same physical line as @ts-expect-error.
      name: 'an EXCEPTION on the same line',
      file: 'ts-expect-excepted.ts',
      lines: [
        '// @ts-expect-error EXCEPTION(T-04389): proper sanctioned exception with ticket',
        'const _x: string = 42 as unknown as string',
      ],
    },
  ]

  test.each(exceptedSuppressions)(
    'case 3: a suppression with $name passes without a baseline entry',
    async ({ file, lines }) => {
      const srcDir = join(tmpDir, 'src')
      await mkdir(srcDir, { recursive: true })
      await writeFile(join(srcDir, file), lines.join('\n'))

      // Empty baseline — the EXCEPTION annotation exempts this suppression.
      await writeFile(join(tmpDir, 'baseline.json'), JSON.stringify({ suppressions: [] }))

      const result = await runCheck(tmpDir, join(tmpDir, 'baseline.json'))
      expect(result.exitCode, out(result)).toBe(0)
    }
  )

  // -------------------------------------------------------------------------
  // Case 4 — grandfathered suppression PASSES via baseline (no EXCEPTION needed)
  // -------------------------------------------------------------------------
  test('case 4: grandfathered suppression passes via baseline without EXCEPTION', async () => {
    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })

    await writeFile(
      join(srcDir, 'legacy.ts'),
      [
        '// biome-ignore lint/performance/noDelete: grandfathered legacy usage',
        'delete (process.env as Record<string, string>)["LEGACY_KEY"]',
      ].join('\n')
    )

    const baseline = join(tmpDir, 'baseline.json')

    // Generate baseline (captures this suppression with count=1)
    const updateResult = await runCheck(tmpDir, baseline, true)
    expect(updateResult.exitCode).toBe(0)

    // Check — passes because it is in baseline; no EXCEPTION required
    const checkResult = await runCheck(tmpDir, baseline)
    expect(checkResult.exitCode).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Case 5 — duplicate identical same-file suppression → FAILS (multiset teeth)
  // -------------------------------------------------------------------------
  test('case 5: duplicate identical suppression exceeds baseline count → fails', async () => {
    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })

    // Single occurrence — baseline count = 1.
    const suppressionLine = '// biome-ignore lint/performance/noDelete: count-test identical'
    await writeFile(
      join(srcDir, 'multi.ts'),
      [suppressionLine, 'delete (process.env as Record<string, string>)["KEY_A"]'].join('\n')
    )

    const baseline = join(tmpDir, 'baseline.json')
    const updateResult = await runCheck(tmpDir, baseline, true)
    expect(updateResult.exitCode).toBe(0)

    // Now add a second identical suppression comment — same file, same rule, same hash.
    // Occurrence count = 2, but baseline count = 1 → must fail.
    await writeFile(
      join(srcDir, 'multi.ts'),
      [
        suppressionLine,
        'delete (process.env as Record<string, string>)["KEY_A"]',
        suppressionLine,
        'delete (process.env as Record<string, string>)["KEY_B"]',
      ].join('\n')
    )

    const result = await runCheck(tmpDir, baseline)
    expect(result.exitCode).not.toBe(0)
  })

  // -------------------------------------------------------------------------
  // Case 7 — scanner scope: dist/, nested node_modules/, .md files are excluded
  // -------------------------------------------------------------------------
  test('case 7: dist, nested node_modules, and markdown files are excluded from scan', async () => {
    // dist/ — compiled output that must not be scanned.
    const distDir = join(tmpDir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(
      join(distDir, 'compiled.js'),
      [
        '// biome-ignore lint/style/noNonNullAssertion: in dist — must be ignored',
        'const _x = arr[0]',
      ].join('\n')
    )

    // Nested node_modules (not at root) — must be excluded.
    const nmDir = join(tmpDir, 'packages', 'foo', 'node_modules', 'bar')
    await mkdir(nmDir, { recursive: true })
    await writeFile(
      join(nmDir, 'index.ts'),
      [
        '// biome-ignore lint/performance/noDelete: in node_modules — must be ignored',
        'delete x',
      ].join('\n')
    )

    // Markdown file mentioning biome-ignore — prose mention, must be excluded.
    const docsDir = join(tmpDir, 'docs')
    await mkdir(docsDir, { recursive: true })
    await writeFile(
      join(docsDir, 'refactor-report.md'),
      [
        '# Refactor Report',
        '',
        'We use `// biome-ignore lint/...` in some legacy files.',
        'The `@ts-ignore` pattern is also present in a few places.',
      ].join('\n')
    )

    // Empty baseline — if the walker touched any excluded path it would fail.
    await writeFile(join(tmpDir, 'baseline.json'), JSON.stringify({ suppressions: [] }))

    const result = await runCheck(tmpDir, join(tmpDir, 'baseline.json'))
    // All suppression-like text is in excluded paths → clean scan → exit 0.
    expect(result.exitCode).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Case 8 — --update-baseline is idempotent: stable sorted output, no diff
  // -------------------------------------------------------------------------
  test('case 8: --update-baseline produces stable sorted output and is idempotent', async () => {
    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })

    // Multiple suppressions in different files to stress sort-order stability.
    await writeFile(
      join(srcDir, 'alpha.ts'),
      [
        '// biome-ignore lint/performance/noDelete: alpha file — first suppression',
        'delete (process.env as Record<string, string>)["ALPHA"]',
      ].join('\n')
    )

    await writeFile(
      join(srcDir, 'beta.ts'),
      [
        '// biome-ignore lint/style/noNonNullAssertion: beta file — second suppression',
        'const _z = ([] as string[])[0]',
      ].join('\n')
    )

    const baseline = join(tmpDir, 'baseline.json')

    // First run — write baseline.
    const first = await runCheck(tmpDir, baseline, true)
    expect(first.exitCode).toBe(0)
    const content1 = await readFile(baseline, 'utf-8')

    // Second run — must produce byte-for-byte identical baseline.
    const second = await runCheck(tmpDir, baseline, true)
    expect(second.exitCode).toBe(0)
    const content2 = await readFile(baseline, 'utf-8')

    expect(content1).toBe(content2)

    // Immediate check (no --update-baseline) against the stable baseline → pass.
    const checkResult = await runCheck(tmpDir, baseline)
    expect(checkResult.exitCode).toBe(0)
  })
})
