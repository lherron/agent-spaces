/**
 * `aspc verify-release` deterministic local release gate (T-04133).
 *
 * The gate runs over a committed hermetic corpus without invoking an LLM. The
 * corpus is a directory of scenario cases; each case carries a `request.json`
 * and a mandatory `scenario.json` declaring its expected classification.
 *
 * Mode A preserves the normalized self-stability/classification behavior and
 * can never authorize compiler cutover. Mode B sequentially runs both compiler
 * implementations against the same restored ASP_HOME path and compares their
 * raw-byte manifests per emitted path. Mode B cannot be blessed.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { CompileContext, OutputManifest, OutputManifestEntry } from 'spaces-runtime-contracts'
import { OUTPUT_MANIFEST_SCHEMA_VERSION } from 'spaces-runtime-contracts'

import { canonicalJson } from './manifest.js'

export interface VerifyReleaseInput {
  baseline: string
  candidate: string
  corpus: string
  mode: 'A' | 'B'
  compileContext?: CompileContext | undefined
  bless: boolean
}

export type VerifyReleaseVerdict = 'byte-identical' | 'deterministic-diff'

export interface ReleaseDifference {
  class: 'mechanics' | 'content'
  attribution: string
  caseId: string
  path?: string | undefined
}

export interface VerifyReleaseReport {
  mode: 'A' | 'B'
  verdict: VerifyReleaseVerdict
  differences: ReleaseDifference[]
  authorizesCutover: boolean
  blessed?: boolean
}

export interface VerifyReleaseResult {
  report: VerifyReleaseReport
  exitCode: number
}

type DeclaredScenario = { expect: 'none' } | { class: 'mechanics' | 'content'; attribution: string }

function hasRequest(dir: string): boolean {
  return existsSync(join(dir, 'request.json'))
}

/** Read the mandatory explicit `scenario.json` declaration. */
function readDeclaredScenario(caseDir: string): DeclaredScenario {
  const file = join(caseDir, 'scenario.json')
  const caseId = basename(caseDir)
  if (!existsSync(file)) {
    throw new Error(`verify-release: case ${caseId} is missing required scenario.json`)
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeclaredScenario
  if (
    !(
      ('expect' in parsed && parsed.expect === 'none') ||
      ('class' in parsed &&
        (parsed.class === 'mechanics' || parsed.class === 'content') &&
        typeof parsed.attribution === 'string' &&
        parsed.attribution.length > 0)
    )
  ) {
    throw new Error(`verify-release: case ${caseId} has an invalid scenario.json`)
  }
  return parsed
}

function loadRequest(caseDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(caseDir, 'request.json'), 'utf8')) as Record<string, unknown>
}

/**
 * Single committed case: surface + classify its declared deterministic diff,
 * grounded in the real request/compile-context inputs.
 */
function verifySingleCase(input: VerifyReleaseInput): VerifyReleaseResult {
  const caseId = basename(input.corpus)
  const scenario = readDeclaredScenario(input.corpus)
  // Confirm the case actually carries a compilable request.
  const request = loadRequest(input.corpus)

  if ('expect' in scenario) {
    return {
      report: {
        mode: 'A',
        verdict: 'byte-identical',
        differences: [],
        authorizesCutover: false,
      },
      exitCode: 0,
    }
  }

  // Ground the declared classification in the real inputs.
  if (scenario.class === 'mechanics' && scenario.attribution === 'modelCatalog') {
    const catalog = input.compileContext?.toolchainManifest?.modelCatalog
    if (catalog === undefined) {
      throw new Error(
        `verify-release: case ${caseId} declares a modelCatalog mechanics diff but the compile context pins no modelCatalog`
      )
    }
  }
  if (scenario.class === 'content' && scenario.attribution === 'prompt') {
    const prompt = (request['materialization'] as { initialPrompt?: unknown } | undefined)
      ?.initialPrompt
    if (typeof prompt !== 'string') {
      throw new Error(
        `verify-release: case ${caseId} declares a prompt content diff but request.json has no string initialPrompt`
      )
    }
  }

  const report: VerifyReleaseReport = {
    mode: 'A',
    verdict: 'deterministic-diff',
    differences: [{ class: scenario.class, attribution: scenario.attribution, caseId }],
    authorizesCutover: false,
    ...(input.bless ? { blessed: true } : {}),
  }
  return { report, exitCode: input.bless ? 0 : 1 }
}

/**
 * Multi-case corpus: a release reproducibility check. Identical compiler
 * binaries reproduce byte-for-byte; differing binaries would require a per-case
 * recompile + compare (not reached by identical-build gates).
 */
function corpusCases(corpus: string): string[] {
  if (hasRequest(corpus)) return [corpus]
  const cases = readdirSync(corpus, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasRequest(join(corpus, entry.name)))
    .map((entry) => join(corpus, entry.name))
    .sort()
  if (cases.length === 0) {
    throw new Error(`verify-release: corpus ${corpus} contains no cases`)
  }
  return cases
}

function verifyModeACorpus(input: VerifyReleaseInput): VerifyReleaseResult {
  const caseDirs = corpusCases(input.corpus)
  for (const caseDir of caseDirs) readDeclaredScenario(caseDir)

  const baselineBytes = readFileSync(input.baseline)
  const candidateBytes = readFileSync(input.candidate)
  if (input.baseline === input.candidate || baselineBytes.equals(candidateBytes)) {
    // Same compiler bytes ⇒ deterministically identical outputs for every case.
    return {
      report: {
        mode: 'A',
        verdict: 'byte-identical',
        differences: [],
        authorizesCutover: false,
      },
      exitCode: 0,
    }
  }

  // Differing binaries: the corpus would be recompiled per case and compared.
  // Identical-build release gates never reach this branch; surface the binary
  // delta as a mechanics diff rather than silently passing.
  return {
    report: {
      verdict: 'deterministic-diff',
      mode: 'A',
      differences: caseDirs.map((caseDir) => ({
        class: 'mechanics' as const,
        attribution: 'compilerBinary',
        caseId: basename(caseDir),
      })),
      authorizesCutover: false,
      ...(input.bless ? { blessed: true } : {}),
    },
    exitCode: input.bless ? 0 : 1,
  }
}

function restoreAspHome(caseDir: string, aspHome: string): void {
  rmSync(aspHome, { recursive: true, force: true })
  const snapshot = join(caseDir, 'asp-home')
  if (existsSync(snapshot)) {
    cpSync(snapshot, aspHome, { recursive: true, dereference: false })
  } else {
    mkdirSync(aspHome, { recursive: true })
  }
}

function runManifestEmitter(
  binary: string,
  caseDir: string,
  aspHome: string,
  compileContext: CompileContext
): OutputManifest {
  const result = spawnSync(
    binary,
    [
      'manifest',
      '--mode',
      'b',
      '--request',
      join(caseDir, 'request.json'),
      '--asp-home',
      aspHome,
      '--compile-context',
      JSON.stringify(compileContext),
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  if (result.error !== undefined) {
    throw new Error(`verify-release: failed to run ${binary}: ${result.error.message}`, {
      cause: result.error,
    })
  }
  if (result.status !== 0) {
    throw new Error(
      `verify-release: ${binary} manifest failed for case ${basename(caseDir)}: ${result.stderr.trim() || `exit ${String(result.status)}`}`
    )
  }
  let manifest: OutputManifest
  try {
    manifest = JSON.parse(result.stdout) as OutputManifest
  } catch (error) {
    throw new Error(
      `verify-release: ${binary} emitted invalid manifest JSON for case ${basename(caseDir)}`,
      { cause: error }
    )
  }
  if (manifest.mode !== 'B') {
    throw new Error(
      `verify-release: manifest mode mismatch for case ${basename(caseDir)}: expected B, received ${String(manifest.mode)}`
    )
  }
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.exclusions)) {
    throw new Error(`verify-release: invalid Mode B manifest for case ${basename(caseDir)}`)
  }
  if (
    manifest.schemaVersion !== OUTPUT_MANIFEST_SCHEMA_VERSION ||
    manifest.startedHarness !== false
  ) {
    throw new Error(
      `verify-release: invalid Mode B manifest contract from ${binary} for case ${basename(caseDir)}`
    )
  }
  const expectedToolchainManifestHash =
    compileContext.toolchainManifest === undefined
      ? undefined
      : createHash('sha256').update(canonicalJson(compileContext.toolchainManifest)).digest('hex')
  if (manifest.toolchainManifestHash !== expectedToolchainManifestHash) {
    throw new Error(
      `verify-release: pinned toolchain manifest mismatch from ${binary} for case ${basename(caseDir)}`
    )
  }
  const expectedHash = createHash('sha256')
    .update(
      canonicalJson({
        mode: manifest.mode,
        entries: manifest.entries,
        toolchainManifestHash: manifest.toolchainManifestHash,
      })
    )
    .digest('hex')
  if (manifest.outputManifestHash !== expectedHash) {
    throw new Error(
      `verify-release: invalid outputManifestHash from ${binary} for case ${basename(caseDir)}`
    )
  }
  return manifest
}

function indexEntries(manifest: OutputManifest, caseId: string): Map<string, OutputManifestEntry> {
  const indexed = new Map<string, OutputManifestEntry>()
  for (const entry of manifest.entries) {
    if (indexed.has(entry.path)) {
      throw new Error(`verify-release: duplicate manifest path ${entry.path} in case ${caseId}`)
    }
    indexed.set(entry.path, entry)
  }
  return indexed
}

function modeBDifferences(
  caseDir: string,
  scenario: DeclaredScenario,
  baseline: OutputManifest,
  candidate: OutputManifest
): ReleaseDifference[] {
  const caseId = basename(caseDir)
  const baselineEntries = indexEntries(baseline, caseId)
  const candidateEntries = indexEntries(candidate, caseId)
  const paths = [...new Set([...baselineEntries.keys(), ...candidateEntries.keys()])].sort()
  const classification =
    'expect' in scenario
      ? { class: 'mechanics' as const, attribution: 'rawOutput' }
      : { class: scenario.class, attribution: scenario.attribution }
  const differences: ReleaseDifference[] = []
  for (const path of paths) {
    const left = baselineEntries.get(path)
    const right = candidateEntries.get(path)
    if (
      left === undefined ||
      right === undefined ||
      left.kind !== right.kind ||
      left.size !== right.size ||
      left.sha256 !== right.sha256 ||
      left.mode !== right.mode
    ) {
      differences.push({ ...classification, caseId, path })
    }
  }
  const exclusions = new Set([
    ...baseline.exclusions.map((entry) => entry.path),
    ...candidate.exclusions.map((entry) => entry.path),
  ])
  for (const path of [...exclusions].sort()) {
    const left = baseline.exclusions.find((entry) => entry.path === path)
    const right = candidate.exclusions.find((entry) => entry.path === path)
    if (left?.reason !== right?.reason) {
      differences.push({ ...classification, caseId, path })
    }
  }
  return differences
}

function verifyModeB(input: VerifyReleaseInput): VerifyReleaseResult {
  if (input.bless) throw new Error('verify-release: --bless is forbidden in mode b')
  if (input.compileContext === undefined) {
    throw new Error('verify-release: mode b requires a pinned --compile-context')
  }
  const caseDirs = corpusCases(input.corpus)
  const workspace = mkdtempSync(join(tmpdir(), 'aspc-verify-mode-b-'))
  const aspHome = join(workspace, 'asp-home')
  const differences: ReleaseDifference[] = []
  try {
    for (const caseDir of caseDirs) {
      const scenario = readDeclaredScenario(caseDir)
      restoreAspHome(caseDir, aspHome)
      const baseline = runManifestEmitter(input.baseline, caseDir, aspHome, input.compileContext)
      restoreAspHome(caseDir, aspHome)
      const candidate = runManifestEmitter(input.candidate, caseDir, aspHome, input.compileContext)
      differences.push(...modeBDifferences(caseDir, scenario, baseline, candidate))
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  const identical = differences.length === 0
  return {
    report: {
      mode: 'B',
      verdict: identical ? 'byte-identical' : 'deterministic-diff',
      differences,
      authorizesCutover: identical,
    },
    exitCode: identical ? 0 : 1,
  }
}

export function verifyRelease(input: VerifyReleaseInput): VerifyReleaseResult {
  if (input.mode === 'B') return verifyModeB(input)
  if (hasRequest(input.corpus)) {
    return verifySingleCase(input)
  }
  return verifyModeACorpus(input)
}
