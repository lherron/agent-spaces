/**
 * RED test suite for scripts/check-public-surface.ts (S7 public-surface guard).
 *
 * Drives the checker by argv over a temp fixture root.
 *
 * Encodes the daedalus RULING for T-04402:
 *   1. Public exports are enumerated only when reachable from ratified barrels.
 *   2. A new uncovered public symbol fails with the six teaching fields.
 *   3. Symbol-level coverage from the ratified corpus passes without baseline.
 *   4. Package-only coverage does not cover a new symbol.
 *   5. Ticketed adjacent waivers pass; bare/junk/non-adjacent waivers fail.
 *   6. Baseline shape, identity hash, idempotency, and file-move stability.
 *   7. CLI command surfaces are checked and can be covered by argv-style tests.
 *
 * Contract larry must honour:
 *   bun scripts/check-public-surface.ts [--root <dir>] [--baseline <path>] [--update-baseline]
 *   Exit 0 = pass, non-zero = fail. Teaching diagnostic on failure.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')

type CheckResult = { exitCode: number; stdout: string; stderr: string }

async function runCheck(
  fixtureDir: string,
  baselinePath: string,
  updateBaseline = false
): Promise<CheckResult> {
  const args = [
    'bun',
    'scripts/check-public-surface.ts',
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

function out(result: CheckResult): string {
  return result.stdout + result.stderr
}

async function writeText(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${content.trimEnd()}\n`)
}

async function writeEmptyBaseline(root: string): Promise<string> {
  const baseline = join(root, '.public-surface-baseline.json')
  await writeFile(
    baseline,
    JSON.stringify(
      {
        _meta: {
          schemaVersion: 1,
          generatedBy: 'check-public-surface',
          warning: 'test fixture baseline',
        },
        surfaces: [],
      },
      null,
      2
    )
  )
  return baseline
}

async function writePackageJson(root: string, packageDir: string, name: string): Promise<void> {
  await writeText(
    root,
    `${packageDir}/package.json`,
    JSON.stringify({ name, type: 'module', main: './dist/index.js' }, null, 2)
  )
}

async function writeAgentScopePackage(root: string, indexSource: string): Promise<void> {
  await writePackageJson(root, 'contracts/agent-scope', 'agent-scope')
  await writeText(root, 'contracts/agent-scope/src/index.ts', indexSource)
}

async function writeCommandRegistry(root: string, commandSource: string): Promise<void> {
  await writeText(
    root,
    'apps/cli/src/command-registry.ts',
    `
      import type { Command } from 'commander'

      export function registerAllCommands(program: Command): void {
        ${commandSource}
      }
    `
  )
}

describe('check-public-surface.ts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cps-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('case 1: baseline update enumerates barrel-reachable exports and ignores non-barreled internals', async () => {
    await writeAgentScopePackage(
      tmpDir,
      `
        export const InlineValue = 'inline'
        export type InlineType = { id: string }
        export interface InlineInterface { id: string }
        export { directValue } from './direct'
        export type { DirectType } from './direct'
        export { aliasedValue as PublicAlias } from './alias'
        export * from './star'
        export * as NamespacePublic from './namespace'
        export { default as DefaultPublic } from './defaulted'
      `
    )
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/direct.ts',
      `
        export const directValue = 'direct'
        export type DirectType = { id: string }
      `
    )
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/alias.ts',
      "export const aliasedValue = 'alias'"
    )
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/star.ts',
      `
        export interface StarInterface { id: string }
        export const starValue = 'star'
      `
    )
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/namespace.ts',
      "export const namespaced = 'ns'"
    )
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/defaulted.ts',
      'export default function defaulted() {}'
    )
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/internal.ts',
      'export const HiddenInternal = true'
    )

    const baseline = join(tmpDir, '.public-surface-baseline.json')
    const result = await runCheck(tmpDir, baseline, true)
    expect(result.exitCode).toBe(0)

    const parsed = JSON.parse(await readFile(baseline, 'utf-8')) as {
      surfaces: Array<{ package: string; symbol: string; kind: string }>
    }
    const identities = parsed.surfaces.map((surface) => `${surface.package}|${surface.symbol}`)

    expect(identities).toContain('agent-scope|InlineValue')
    expect(identities).toContain('agent-scope|InlineType')
    expect(identities).toContain('agent-scope|InlineInterface')
    expect(identities).toContain('agent-scope|directValue')
    expect(identities).toContain('agent-scope|DirectType')
    expect(identities).toContain('agent-scope|PublicAlias')
    expect(identities).toContain('agent-scope|StarInterface')
    expect(identities).toContain('agent-scope|starValue')
    expect(identities).toContain('agent-scope|NamespacePublic')
    expect(identities).toContain('agent-scope|DefaultPublic')
    expect(identities).not.toContain('agent-scope|HiddenInternal')
    expect(parsed.surfaces.every((surface) => surface.kind.length > 0)).toBe(true)
  })

  test('case 2: new uncovered public symbol fails with six teaching fields', async () => {
    await writeAgentScopePackage(
      tmpDir,
      `
        export interface UncoveredSurface {
          id: string
        }
      `
    )
    const baseline = await writeEmptyBaseline(tmpDir)

    const result = await runCheck(tmpDir, baseline)
    const combined = out(result)

    expect(result.exitCode).not.toBe(0)
    expect(combined).toMatch(/PUBLIC_SURFACE|public-surface|new public surface/i)
    expect(combined).toMatch(/contracts\/agent-scope\/src\/index\.ts:\d+/)
    expect(combined).toMatch(/expected.*got|got.*expected/i)
    expect(combined).toMatch(/FIX\s*->/)
    expect(combined).toMatch(/WHY\s*->/)
    expect(combined).toMatch(/EXCEPTION\s*->/)
    expect(combined).toMatch(/do not suppress|do-not-silence/i)
  })

  test('case 3: symbol-level coverage from the allowed corpus passes without baseline update', async () => {
    await writeAgentScopePackage(tmpDir, 'export interface CoveredSurface { id: string }')
    await writeText(
      tmpDir,
      'contracts/agent-scope/src/covered.test.ts',
      `
        import type { CoveredSurface } from './index'

        const fixture: CoveredSurface = { id: 'covered' }
        void fixture
      `
    )
    const baseline = await writeEmptyBaseline(tmpDir)

    const result = await runCheck(tmpDir, baseline)
    expect(result.exitCode).toBe(0)
  })

  test('case 4: importing only the package does not cover an unmentioned public symbol', async () => {
    await writePackageJson(tmpDir, 'contracts/spaces-runtime-contracts', 'spaces-runtime-contracts')
    await writeText(
      tmpDir,
      'contracts/spaces-runtime-contracts/src/index.ts',
      'export interface PackageOnlySurface { id: string }'
    )
    await writeText(
      tmpDir,
      'contracts/spaces-runtime-contracts/src/package-only.test.ts',
      `
        import * as runtimeContracts from './index'

        expect(runtimeContracts).toBeDefined()
      `
    )
    const baseline = await writeEmptyBaseline(tmpDir)

    const result = await runCheck(tmpDir, baseline)
    expect(result.exitCode).not.toBe(0)
    expect(out(result)).toMatch(/PackageOnlySurface/)
  })

  const waiverCases: Array<{
    name: string
    index: string
    passes: boolean
    reported?: RegExp
  }> = [
    {
      name: 'a ticketed CONTRACT-EXEMPT waiver on the preceding line passes',
      index: `
        // CONTRACT-EXEMPT(T-1234): real downstream compatibility reason
        export interface ContractExemptSurface { id: string }
      `,
      passes: true,
    },
    {
      name: 'a ticketed TACIT waiver on the same line passes',
      index:
        'export interface TacitSurface { id: string } // TACIT(T-1234): real staged contract reason',
      passes: true,
    },
    {
      name: 'a TACIT waiver without a ticket fails',
      index: 'export interface BareTacitSurface { id: string } // TACIT(no ticket): real reason',
      passes: false,
      reported: /BareTacitSurface|TACIT/,
    },
    {
      name: 'a waiver with a junk reason fails',
      index: `
        // CONTRACT-EXEMPT(T-1234): todo
        export interface JunkReasonSurface { id: string }
      `,
      passes: false,
      reported: /JunkReasonSurface|todo|reason/i,
    },
    {
      name: 'a waiver more than one line above the export fails',
      index: `
        // CONTRACT-EXEMPT(T-1234): real reason but too far away

        export interface NonAdjacentSurface { id: string }
      `,
      passes: false,
      reported: /NonAdjacentSurface/,
    },
  ]

  test.each(waiverCases)('case 5: waiver grammar: $name', async ({ index, passes, reported }) => {
    await writeAgentScopePackage(tmpDir, index)
    const baseline = await writeEmptyBaseline(tmpDir)

    const result = await runCheck(tmpDir, baseline)
    if (passes) {
      expect(result.exitCode, out(result)).toBe(0)
    } else {
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(reported as RegExp)
    }
  })

  test('case 6: baseline shape is stable, identity-hashed, idempotent, and survives file moves', async () => {
    await writePackageJson(tmpDir, 'contracts/aspc-protocol', 'spaces-aspc-protocol')
    await writeText(
      tmpDir,
      'contracts/aspc-protocol/src/index.ts',
      "export { MoveStable } from './old-home'"
    )
    await writeText(
      tmpDir,
      'contracts/aspc-protocol/src/old-home.ts',
      'export const MoveStable = true'
    )

    const baseline = join(tmpDir, '.public-surface-baseline.json')
    const first = await runCheck(tmpDir, baseline, true)
    expect(first.exitCode).toBe(0)
    const content1 = await readFile(baseline, 'utf-8')
    const parsed = JSON.parse(content1) as {
      _meta: { schemaVersion: number; generatedBy: string; warning: string }
      surfaces: Array<{
        package: string
        symbol: string
        kind: string
        file: string
        hash: string
        count: number
      }>
    }

    expect(parsed._meta.schemaVersion).toBeDefined()
    expect(parsed._meta.generatedBy).toBeDefined()
    expect(parsed._meta.warning).toBeDefined()
    const moveSurface = parsed.surfaces.find((surface) => surface.symbol === 'MoveStable')
    expect(moveSurface).toMatchObject({
      package: 'spaces-aspc-protocol',
      symbol: 'MoveStable',
      hash: 'spaces-aspc-protocol|MoveStable|value',
      count: 1,
    })
    expect(moveSurface?.file).toMatch(/contracts\/aspc-protocol\/src\/old-home\.ts/)

    const second = await runCheck(tmpDir, baseline, true)
    expect(second.exitCode).toBe(0)
    const content2 = await readFile(baseline, 'utf-8')
    expect(content2).toBe(content1)

    await rename(
      join(tmpDir, 'contracts/aspc-protocol/src/old-home.ts'),
      join(tmpDir, 'contracts/aspc-protocol/src/new-home.ts')
    )
    await writeText(
      tmpDir,
      'contracts/aspc-protocol/src/index.ts',
      "export { MoveStable } from './new-home'"
    )

    const afterMove = await runCheck(tmpDir, baseline)
    expect(afterMove.exitCode).toBe(0)
  })

  test('case 7: CLI command surfaces fail without coverage and pass with argv-style coverage or waiver', async () => {
    await writeCommandRegistry(tmpDir, "program.command('self').command('inspect')")
    let baseline = await writeEmptyBaseline(tmpDir)

    const uncovered = await runCheck(tmpDir, baseline)
    expect(uncovered.exitCode).not.toBe(0)
    expect(out(uncovered)).toMatch(/asp self inspect|self inspect/)

    await writeText(
      tmpDir,
      'apps/cli/src/command-registry.test.ts',
      `
        const argv = ['self', 'inspect']
        expect(argv).toEqual(['self', 'inspect'])
      `
    )
    const covered = await runCheck(tmpDir, baseline)
    expect(covered.exitCode).toBe(0)

    await rm(join(tmpDir, 'apps/cli/src/command-registry.test.ts'), { force: true })
    await writeCommandRegistry(
      tmpDir,
      `
        // TACIT(T-1234): real transitional CLI contract reason
        program.command('self').command('inspect')
      `
    )
    baseline = await writeEmptyBaseline(tmpDir)
    const waived = await runCheck(tmpDir, baseline)
    expect(waived.exitCode).toBe(0)
  })
})
