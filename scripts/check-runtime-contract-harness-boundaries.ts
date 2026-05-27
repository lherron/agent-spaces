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
import { join, relative } from 'node:path'

type Violation = {
  file: string
  line: number
  rule: string
  detail: string
}

const repoRoot = new URL('..', import.meta.url).pathname

// ---------------------------------------------------------------------------
// Harness surface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const importPattern =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/

function importSpecifier(line: string): string | undefined {
  const match = importPattern.exec(line)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
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

function scanLine(file: string, lineNumber: number, line: string): Violation[] {
  const violations: Violation[] = []

  const specifier = importSpecifier(line)
  if (specifier !== undefined && isHrcImport(specifier)) {
    violations.push({
      file,
      line: lineNumber,
      rule: 'no-hrc-import',
      detail: `forbidden HRC import '${specifier}'`,
    })
  }

  const codexMatch = codexInternalsPattern.exec(line)
  if (codexMatch !== null) {
    violations.push({
      file,
      line: lineNumber,
      rule: 'no-codex-driver-internals',
      detail: `forbidden Codex driver/session internal '${codexMatch[0]}'`,
    })
  }

  if (line.includes('buildHarnessBrokerInvocation')) {
    violations.push({
      file,
      line: lineNumber,
      rule: 'no-direct-builder',
      detail: 'forbidden buildHarnessBrokerInvocation (use the compiled plan)',
    })
  }

  // The split start call is `.startInvocation(`; the request-level call is
  // `.startInvocationFromRequest(` and must NOT trip this rule.
  if (splitStartPattern.test(line) && !line.includes('startInvocationFromRequest')) {
    violations.push({
      file,
      line: lineNumber,
      rule: 'no-split-start',
      detail: 'forbidden split .startInvocation( (use startInvocationFromRequest)',
    })
  }

  return violations
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const files = await harnessFiles()
if (files.length === 0) {
  console.error('Contract harness boundary check failed: no harness files were found.')
  console.error(`  expected ${TESTING_DIR}/**/*.ts and ${SCRIPTS_DIR}/${SCRIPT_PREFIX}*.ts`)
  process.exit(1)
}

const violations: Violation[] = []
let startInvocationFromRequestHits = 0

for (const file of files) {
  const content = await readFile(file, 'utf8')
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.includes('startInvocationFromRequest')) startInvocationFromRequestHits += 1
    violations.push(...scanLine(relative(repoRoot, file), i + 1, line))
  }
}

if (startInvocationFromRequestHits === 0) {
  violations.push({
    file: TESTING_DIR,
    line: 0,
    rule: 'requires-start-from-request',
    detail:
      'positive check failed: no startInvocationFromRequest call found in the contract harness',
  })
}

if (violations.length === 0) {
  console.log(
    `Contract harness boundary check passed (${files.length} files; startInvocationFromRequest hits=${startInvocationFromRequestHits}).`
  )
  process.exit(0)
}

console.error('Contract harness boundary check failed:')
for (const violation of violations) {
  const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file
  console.error(`  [${violation.rule}] ${location}: ${violation.detail}`)
}
process.exit(1)
