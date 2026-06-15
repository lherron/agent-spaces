#!/usr/bin/env bun
/**
 * Boundary check for the pre-HRC runtime-contract broker harness (plan §11, PR8).
 *
 * The contract harness exists to prove that Agent Spaces compiler output can be
 * consumed by an HRC-like caller WITHOUT boundary violations. To stay honest it
 * must depend only on the compiler + broker-client + protocol/runtime-contracts
 * surface — never HRC, never Codex driver/session internals, and never the
 * pre-compiler direct-builder / split-start escape hatches.
 *
 * Scanned harness surface:
 *   - packages/agent-spaces/src/testing/**\/*.ts
 *   - scripts/smoke-runtime-contract-broker-*.ts
 *
 * FAILS (exit 1) if any scanned file:
 *   - imports HRC (specifier `hrc-*` or a `hrc-runtime` / `packages/hrc` path);
 *   - references Codex driver/session internals (spaces-harness-codex,
 *     CodexAppServer, codex-session, runCodexAppServerOneShot,
 *     harness-broker/src/drivers);
 *   - uses buildHarnessBrokerInvocation (must use the compiled plan);
 *   - uses the split `.startInvocation(` call (must use the request-level call);
 *   - OR if NONE of the scanned files use startInvocationFromRequest (positive
 *     check: the exact pass-through start call must be present).
 *
 * The direct builder + split start call may remain in compatibility tests only;
 * those live outside the scanned surface above and are intentionally not scanned.
 */
import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineGuard, runGuard } from './lib/boundary-guard/engine.ts'
import type { Guard, ImportFinding, TokenFinding } from './lib/boundary-guard/engine.ts'

const repoRoot = new URL('..', import.meta.url).pathname

const TESTING_DIR = 'packages/agent-spaces/src/testing'
const SCRIPTS_DIR = 'scripts'
const SCRIPT_PREFIX = 'smoke-runtime-contract-broker-'

const ignoredDirectories = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

async function collectTsFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') return
      throw error
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(path)
        continue
      }
      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path)
      }
    }
  }

  await walk(root)
  return files
}

async function harnessFiles(): Promise<string[]> {
  const testingFiles = await collectTsFiles(join(repoRoot, TESTING_DIR))
  const scriptEntries = await readdir(join(repoRoot, SCRIPTS_DIR), { withFileTypes: true }).catch(
    () => [] as Dirent[]
  )
  const scriptFiles = scriptEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(SCRIPT_PREFIX) &&
        /\.(ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
    )
    .map((entry) => join(repoRoot, SCRIPTS_DIR, entry.name))
  return [...testingFiles, ...scriptFiles].sort()
}

function isHrcImport(specifier: string): boolean {
  return (
    specifier.startsWith('hrc-') ||
    specifier.includes('/hrc-runtime/') ||
    specifier.includes('hrc-runtime/') ||
    specifier.includes('packages/hrc')
  )
}

// Codex driver/session internals the harness must never reach into. These are
// raw tokens; the normalized broker surface (e.g. `fake-codex` fixtures, the
// `ASP_CODEX_PATH` shim) never contains any of them.
const codexInternalsPattern =
  /\b(spaces-harness-codex|CodexAppServer|codex-session|runCodexAppServerOneShot)\b|harness-broker\/src\/drivers/

const splitStartPattern = /\.startInvocation\s*\(/

function contractHarnessGuard(): Guard {
  return defineGuard({
    surface: {
      dirs: [TESTING_DIR],
      scriptPrefixes: [{ dir: SCRIPTS_DIR, prefix: SCRIPT_PREFIX }],
      ignore: [...ignoredDirectories],
    },
    rules: [
      {
        id: 'CONTRACT-HARNESS:no-hrc-import',
        kind: 'forbid-import',
        match: (specifier: string) => (isHrcImport(specifier) ? specifier : undefined),
        expected: 'contract harness must not import HRC',
        got: (finding: ImportFinding) => `import '${finding.specifier}'`,
        fix: 'drop the HRC import; consume only compiler + broker-client + protocol/runtime-contracts surface.',
        why: 'the harness proves compiler output is consumable by an HRC-LIKE caller without reaching into HRC itself.',
        exception:
          'edit the rule set in scripts/check-runtime-contract-harness-boundaries.ts via reviewed change — NOT an inline silence.',
        doNotSuppress:
          'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
      },
      {
        id: 'CONTRACT-HARNESS:no-codex-driver-internals',
        kind: 'forbid-token',
        match(line: string): string | undefined {
          return codexInternalsPattern.exec(line)?.[0]
        },
        expected: 'no Codex driver/session internals',
        got: (finding: TokenFinding) => `'${finding.token}'`,
        fix: 'use the normalized broker surface (fake-codex fixtures / ASP_CODEX_PATH shim), not driver/session internals.',
        why: 'reaching into Codex internals couples the harness to a specific driver and defeats the contract proof.',
        exception:
          'edit the rule set in scripts/check-runtime-contract-harness-boundaries.ts via reviewed change — NOT an inline silence.',
        doNotSuppress:
          'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
      },
      {
        id: 'CONTRACT-HARNESS:no-direct-builder',
        kind: 'forbid-token',
        match: (line: string) =>
          line.includes('buildHarnessBrokerInvocation')
            ? 'buildHarnessBrokerInvocation'
            : undefined,
        expected: 'invocation built from the compiled plan',
        got: 'buildHarnessBrokerInvocation',
        fix: 'build the invocation from the compiled plan instead of the direct builder.',
        why: 'the direct builder bypasses the compiler the harness is meant to exercise.',
        exception:
          'edit the rule set in scripts/check-runtime-contract-harness-boundaries.ts via reviewed change — NOT an inline silence.',
        doNotSuppress:
          'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
      },
      {
        id: 'CONTRACT-HARNESS:no-split-start',
        kind: 'forbid-token',
        match: (line: string) =>
          splitStartPattern.test(line) && !line.includes('startInvocationFromRequest')
            ? 'split .startInvocation('
            : undefined,
        expected: 'request-level startInvocationFromRequest',
        got: 'split .startInvocation(',
        fix: 'call startInvocationFromRequest (the request-level pass-through).',
        why: 'the split start escape hatch skips the request-level contract path.',
        exception:
          'edit the rule set in scripts/check-runtime-contract-harness-boundaries.ts via reviewed change — NOT an inline silence.',
        doNotSuppress:
          'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
      },
      {
        id: 'CONTRACT-HARNESS:requires-start-from-request',
        kind: 'require-presence',
        match: (line: string) => line.includes('startInvocationFromRequest'),
        expected: 'at least one startInvocationFromRequest call in the contract harness',
        got: 'none found',
        fix: 'exercise startInvocationFromRequest somewhere in the harness surface.',
        why: 'without it the harness never proves the request-level pass-through path works.',
        exception:
          'edit the rule set in scripts/check-runtime-contract-harness-boundaries.ts via reviewed change — NOT an inline silence.',
        doNotSuppress:
          'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
      },
    ],
    repoRoot,
  })
}

const files = await harnessFiles()
let startInvocationFromRequestHits = 0

for (const file of files) {
  const content = await readFile(file, 'utf8')
  startInvocationFromRequestHits += content
    .split('\n')
    .filter((line) => line.includes('startInvocationFromRequest')).length
}

const exitCode = await runGuard(contractHarnessGuard())

if (exitCode === 0) {
  console.log(
    `Contract harness boundary check passed (${files.length} files; startInvocationFromRequest hits=${startInvocationFromRequestHits}).`
  )
}

process.exit(exitCode)
