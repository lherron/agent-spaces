/**
 * RED acceptance bar for T-03600.
 *
 * This task is a deferred-refactor rollup, so the first green step is not a
 * code extraction: it is a refreshed, executable inventory plus cleanup of the
 * broad source-inspection blockers that currently pin whole function bodies.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..', '..')
const inventoryPath = join(repoRoot, 'refactor-analysis', 'T-03600-inventory.md')

const requiredCategories = [
  'resolved',
  'in-repo refactor',
  'Expand/Contract',
  'downstream-blocked',
  'optional',
  'stale-test-debt',
  'stale/no-op',
  'product decision',
]

const originalBulletSignals = [
  'runPlacementTurnNonInteractive',
  'runTurnNonInteractive',
  'runTurnInFlight',
  'preparePlacementCliRuntime',
  'packages/execution/src/run.ts',
  'applyEventState',
  'cli-kit',
  'buildProcessInvocationSpec',
  'AgentSpacesClientOptions.registryPath',
  'getStorePath',
  'PathResolver.store',
  'renderKeyValueSection',
  'hrcEventsBridgePath',
  'symmetric driver/normalizer exports',
  'buildThreadStartParams',
  'SchemaRecord',
  'startInvocation',
  'opus-4-6',
  'ASPC_FACADE_VERSION',
  'parseSessionHandle',
  'LintOptions.rules',
  'execute-embedded-sdk',
  'inferTargetFromBundleRoot',
  'notification-method dispatch',
]

const sourceInspectionFiles = [
  'packages/agent-spaces/src/__tests__/phase4-harness-adapter-integration.test.ts',
  'packages/agent-spaces/src/__tests__/m5-public-api-cutover.test.ts',
  'packages/agent-spaces/src/__tests__/headless-empty-response.test.ts',
  'packages/cli/src/__tests__/m6-agent-cli.test.ts',
]

const broadSourceInspectionPatterns = [
  /match\(\s*\/async function preparePlacementCliRuntime\[\\s\\S\]\*\?\^}/,
  /match\(\s*\/async function runPlacementTurnNonInteractive\[\\s\\S\]\*\?\^}/,
  /extractFunction\([^)]*['"]preparePlacementCliRuntime['"]\)/,
  /extractFunction\([^)]*['"]runPlacementTurnNonInteractive['"]\)/,
]

describe('T-03600 refreshed refactor inventory', () => {
  test('classifies every original deferred bullet into an accepted category', () => {
    expect(
      existsSync(inventoryPath),
      `Expected ${relative(repoRoot, inventoryPath)} to contain the refreshed T-03600 inventory`
    ).toBe(true)

    const inventory = readFileSync(inventoryPath, 'utf8')

    for (const category of requiredCategories) {
      expect(inventory, `missing category: ${category}`).toContain(category)
    }

    for (const signal of originalBulletSignals) {
      expect(inventory, `missing original bullet signal: ${signal}`).toContain(signal)
    }
  })

  test('records product decisions as decision records, not guessed implementation choices', () => {
    expect(
      existsSync(inventoryPath),
      `Expected ${relative(repoRoot, inventoryPath)} to contain product decision records`
    ).toBe(true)

    const inventory = readFileSync(inventoryPath, 'utf8')

    for (const decision of ['opus-4-6', 'parseSessionHandle']) {
      const start = inventory.indexOf(decision)
      expect(start, `missing decision record for ${decision}`).toBeGreaterThanOrEqual(0)
      const decisionBlock = inventory.slice(start, start + 1800)
      expect(decisionBlock, `${decision} must list concrete options`).toMatch(/Options?:/i)
      expect(decisionBlock, `${decision} must describe API impact`).toMatch(/API impact:/i)
      expect(decisionBlock, `${decision} must describe downstream migration impact`).toMatch(
        /downstream migration/i
      )
      expect(decisionBlock, `${decision} must name validation commands`).toMatch(/Validation:/i)
    }
  })
})

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
