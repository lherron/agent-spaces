/**
 * RED acceptance bar for T-03600.
 *
 * T-03600 was a deferred-refactor rollup. Its refreshed inventory was work
 * output and now lives on the task as the wrkq attachment
 * `refactor-analysis__T-03600-inventory.md` (T-10127). What stays here is the
 * behavioral half: the broad source-inspection blockers that pinned whole
 * function bodies must not return.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..', '..')

const sourceInspectionFiles = [
  'compiler/agent-spaces/src/__tests__/phase4-harness-adapter-integration.test.ts',
  'integration-tests/tests/m5-public-api-cutover.test.ts',
  'compiler/agent-spaces/src/__tests__/headless-empty-response.test.ts',
  'apps/cli/src/__tests__/asp-cli.ts',
  'apps/cli/src/__tests__/agent-command.test.ts',
  'apps/cli/src/__tests__/agent-correlation.test.ts',
  'apps/cli/src/__tests__/agent-invocation-spec.test.ts',
  'apps/cli/src/__tests__/cli-compatibility.test.ts',
]

const broadSourceInspectionPatterns = [
  /match\(\s*\/async function preparePlacementCliRuntime\[\\s\\S\]\*\?\^}/,
  /match\(\s*\/async function runPlacementTurnNonInteractive\[\\s\\S\]\*\?\^}/,
  /extractFunction\([^)]*['"]preparePlacementCliRuntime['"]\)/,
  /extractFunction\([^)]*['"]runPlacementTurnNonInteractive['"]\)/,
]

describe('T-03600 source-inspection blocker cleanup', () => {
  test('does not leave broad whole-function regex blockers around target extraction functions', () => {
    const violations: string[] = []

    for (const file of sourceInspectionFiles) {
      const fullPath = join(repoRoot, file)
      const source = readFileSync(fullPath, 'utf8')
      for (const pattern of broadSourceInspectionPatterns) {
        if (pattern.test(source)) {
          violations.push(`${file}: ${pattern.source}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
