/**
 * RED test suite for scripts/check-public-surface.ts (S7 public-surface guard).
 *
 * WHY: These tests fail now because check-public-surface.ts does not exist yet,
 * and scripts/lib/import-graph.ts does not yet export parseExportReferences().
 * Larry implements the checker and import-graph export scanner to make them green.
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
  await writePackageJson(root, 'packages/agent-scope', 'agent-scope')
  await writeText(root, 'packages/agent-scope/src/index.ts', indexSource)
}

async function writeCommandRegistry(root: string, commandSource: string): Promise<void> {
  await writeText(
    root,
    'packages/cli/src/command-registry.ts',
    `
      import type { Command } from 'commander'

      export function registerAllCommands(program: Command): void {
        ${commandSource}
      }
    `
  )
}

describe('parseExportReferences()', () => {
  test('case 1: barrel-reachable export enumeration includes public forms and ignores internal src exports', async () => {
    const module = await import('./lib/import-graph')
    const parseExportReferences = module.parseExportReferences as
      | ((file: string, content: string) => Array<Record<string, unknown>>)
      | undefined
    expect(typeof parseExportReferences).toBe('function')

    const refs = parseExportReferences?.(
      'packages/agent-scope/src/index.ts',
      `
        export const InlineValue = 'inline'
        export type InlineType = { id: string }
        export interface InlineInterface { id: string }
        export { localValue as PublicAlias } from './alias'
        export * from './star'
        export * as NamespacePublic from './namespace'
        export { default as DefaultPublic } from './defaulted'
        const HiddenInternal = true
      `
    )

    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          symbol: 'InlineValue',
        }),
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          symbol: 'InlineType',
        }),
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          symbol: 'InlineInterface',
        }),
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          symbol: 'PublicAlias',
          specifier: './alias',
        }),
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          kind: 'star',
          specifier: './star',
        }),
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          symbol: 'NamespacePublic',
          specifier: './namespace',
        }),
        expect.objectContaining({
          file: 'packages/agent-scope/src/index.ts',
          symbol: 'DefaultPublic',
          specifier: './defaulted',
        }),
      ])
    )
    expect(refs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: 'HiddenInternal' })])
    )
  })
})

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
      'packages/agent-scope/src/direct.ts',
      `
        export const directValue = 'direct'
        export type DirectType = { id: string }
      `
    )
    await writeText(
      tmpDir,
      'packages/agent-scope/src/alias.ts',
      "export const aliasedValue = 'alias'"
    )
    await writeText(
      tmpDir,
      'packages/agent-scope/src/star.ts',
      `
        export interface StarInterface { id: string }
        export const starValue = 'star'
      `
    )
    await writeText(
      tmpDir,
      'packages/agent-scope/src/namespace.ts',
      "export const namespaced = 'ns'"
    )
    await writeText(
      tmpDir,
      'packages/agent-scope/src/defaulted.ts',
      'export default function defaulted() {}'
    )
    await writeText(
      tmpDir,
      'packages/agent-scope/src/internal.ts',
      'export const HiddenInternal = true'
    )

    const baseline = join(tmpDir, '.public-surface-baseline.json')
    const result = await runCheck(tmpDir, baseline, true)
    expect(result.exitCode).toBe(0)

    const parsed = JSON.parse(await readFile(baseline, 'utf-8')) as {
      surfaces: Array<{ package: string; symbol: string; kind: string }>
    }
    const identities = parsed.surfaces.map((surface) => `${surface.package}|${surface.symbol}`)

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
    expect(combined).toMatch(/packages\/agent-scope\/src\/index\.ts:\d+/)
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
      'packages/agent-scope/src/covered.test.ts',
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
    await writePackageJson(tmpDir, 'packages/spaces-runtime-contracts', 'spaces-runtime-contracts')
    await writeText(
      tmpDir,
      'packages/spaces-runtime-contracts/src/index.ts',
      'export interface PackageOnlySurface { id: string }'
    )
    await writeText(
      tmpDir,
      'packages/spaces-runtime-contracts/src/package-only.test.ts',
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

  describe('case 5: waiver grammar is ticketed, adjacent, and rejects junk reasons', () => {
    test('ticketed CONTRACT-EXEMPT waiver on the preceding line passes', async () => {
      await writeAgentScopePackage(
        tmpDir,
        `
          // CONTRACT-EXEMPT(T-1234): real downstream compatibility reason
          export interface ContractExemptSurface { id: string }
        `
      )
      const baseline = await writeEmptyBaseline(tmpDir)

      const result = await runCheck(tmpDir, baseline)
      expect(result.exitCode).toBe(0)
    })

    test('ticketed TACIT waiver on the same line passes', async () => {
      await writeAgentScopePackage(
        tmpDir,
        'export interface TacitSurface { id: string } // TACIT(T-1234): real staged contract reason'
      )
      const baseline = await writeEmptyBaseline(tmpDir)

      const result = await runCheck(tmpDir, baseline)
      expect(result.exitCode).toBe(0)
    })

    test('bare TACIT without a ticket fails', async () => {
      await writeAgentScopePackage(
        tmpDir,
        'export interface BareTacitSurface { id: string } // TACIT(no ticket): real reason'
      )
      const baseline = await writeEmptyBaseline(tmpDir)

      const result = await runCheck(tmpDir, baseline)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/BareTacitSurface|TACIT/)
    })

    test('junk waiver reason fails', async () => {
      await writeAgentScopePackage(
        tmpDir,
        `
          // CONTRACT-EXEMPT(T-1234): todo
          export interface JunkReasonSurface { id: string }
        `
      )
      const baseline = await writeEmptyBaseline(tmpDir)

      const result = await runCheck(tmpDir, baseline)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/JunkReasonSurface|todo|reason/i)
    })

    test('non-adjacent waiver more than one line above fails', async () => {
      await writeAgentScopePackage(
        tmpDir,
        `
          // CONTRACT-EXEMPT(T-1234): real reason but too far away

          export interface NonAdjacentSurface { id: string }
        `
      )
      const baseline = await writeEmptyBaseline(tmpDir)

      const result = await runCheck(tmpDir, baseline)
      expect(result.exitCode).not.toBe(0)
      expect(out(result)).toMatch(/NonAdjacentSurface/)
    })
  })

  test('case 6: baseline shape is stable, identity-hashed, idempotent, and survives file moves', async () => {
    await writePackageJson(tmpDir, 'packages/aspc-protocol', 'spaces-aspc-protocol')
    await writeText(
      tmpDir,
      'packages/aspc-protocol/src/index.ts',
      "export { MoveStable } from './old-home'"
    )
    await writeText(
      tmpDir,
      'packages/aspc-protocol/src/old-home.ts',
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
    expect(moveSurface?.file).toMatch(/packages\/aspc-protocol\/src\/old-home\.ts/)

    const second = await runCheck(tmpDir, baseline, true)
    expect(second.exitCode).toBe(0)
    const content2 = await readFile(baseline, 'utf-8')
    expect(content2).toBe(content1)

    await rename(
      join(tmpDir, 'packages/aspc-protocol/src/old-home.ts'),
      join(tmpDir, 'packages/aspc-protocol/src/new-home.ts')
    )
    await writeText(
      tmpDir,
      'packages/aspc-protocol/src/index.ts',
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
      'packages/cli/src/command-registry.test.ts',
      `
        const argv = ['self', 'inspect']
        expect(argv).toEqual(['self', 'inspect'])
      `
    )
    const covered = await runCheck(tmpDir, baseline)
    expect(covered.exitCode).toBe(0)

    await rm(join(tmpDir, 'packages/cli/src/command-registry.test.ts'), { force: true })
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
