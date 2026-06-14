#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SURFACE_RANK = {
  docs: 1,
  logic: 2,
  contract: 3,
  packaging: 4,
  harness: 5,
  runtime: 6,
} as const

type Surface = keyof typeof SURFACE_RANK
type Evidence = {
  kind?: string
  facts?: Record<string, unknown>
  data?: Record<string, unknown>
  [key: string]: unknown
}
type SurfaceConfig = {
  surface: Surface
  globs: string[]
  evidenceKinds?: string[]
  evidenceCommands?: string[]
}
export type Config = {
  surfaces: SurfaceConfig[]
}
type Diagnostic = {
  requiredSurface: Surface | null
  claimClass: string | null
  recordedDiffFloor: Surface | null
  expectedKind: string | null
  foundKind: string | null
  foundExitCode: number | null
  reason: string
}

const COVERAGE: Record<Surface, string[]> = {
  docs: ['docs_reachability'],
  logic: ['verify', 'verify_full'],
  contract: ['contract'],
  packaging: ['pack_smoke'],
  harness: ['matrix'],
  runtime: ['installed_binary'],
}

const COMMAND_KINDS = new Set(['docs_reachability', 'contract', 'pack_smoke', 'matrix'])

function readStdin(): string {
  return readFileSync(0, 'utf8')
}

function latestEvidence(evidence: Evidence[], kind: string): Evidence | null {
  const found = evidence.filter((entry) => entry.kind === kind)
  return found.length > 0 ? found[found.length - 1] : null
}

function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && value in SURFACE_RANK
}

function maxSurface(a: Surface, b: Surface): Surface {
  return SURFACE_RANK[a] >= SURFACE_RANK[b] ? a : b
}

function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    const next = glob[i + 1]
    if (ch === '*' && next === '*') {
      const after = glob[i + 2]
      if (after === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
      continue
    }
    if (ch === '*') {
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  out += '$'
  return new RegExp(out)
}

function loadConfig(path = join(import.meta.dir, '..', 'closeout-config.json')): Config {
  return JSON.parse(readFileSync(path, 'utf8')) as Config
}

export function classifyChangedFiles(
  files: string[],
  claimSurface: Surface,
  config: Config
): Surface {
  let floor = claimSurface
  for (const file of files) {
    let matched: Surface | null = null
    for (const surface of config.surfaces) {
      if (surface.globs.some((glob) => globToRegExp(glob).test(file))) {
        matched = matched === null ? surface.surface : maxSurface(matched, surface.surface)
      }
    }
    if (matched !== null) {
      floor = maxSurface(floor, matched)
    }
  }
  return floor
}

function extractFiles(entry: Evidence | null): string[] {
  const raw = entry?.data?.files
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.filter((value): value is string => typeof value === 'string')
}

function commandExitCode(entry: Evidence | null): number | null {
  const value = entry?.data?.exitCode
  return typeof value === 'number' ? value : null
}

function factsVerdictPass(entry: Evidence | null): boolean {
  return entry?.facts?.verdict === 'pass'
}

function coversKind(entry: Evidence | null): boolean {
  if (!entry?.kind) {
    return false
  }
  if (COMMAND_KINDS.has(entry.kind)) {
    return commandExitCode(entry) === 0
  }
  if (
    entry.kind === 'verify' ||
    entry.kind === 'verify_full' ||
    entry.kind === 'installed_binary'
  ) {
    return factsVerdictPass(entry)
  }
  return factsVerdictPass(entry)
}

function findCoverage(evidence: Evidence[], requiredSurface: Surface): Evidence | null {
  const expectedKinds = COVERAGE[requiredSurface]
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const entry = evidence[i]
    if (entry.kind && expectedKinds.includes(entry.kind)) {
      return entry
    }
  }
  return null
}

function printDiagnostic(diag: Diagnostic): void {
  console.error(JSON.stringify(diag))
}

function fail(diag: Diagnostic): never {
  printDiagnostic(diag)
  process.exit(1)
}

function main(): void {
  let context: { evidence?: Evidence[]; obligations?: unknown[] }
  try {
    context = JSON.parse(readStdin())
  } catch {
    fail({
      requiredSurface: null,
      claimClass: null,
      recordedDiffFloor: null,
      expectedKind: null,
      foundKind: null,
      foundExitCode: null,
      reason: 'malformed check context JSON',
    })
  }

  const evidence = Array.isArray(context.evidence) ? context.evidence : []
  const claim = latestEvidence(evidence, 'closeout_claim')
  const claimClass = claim?.facts?.claimClass ?? null
  if (!isSurface(claimClass)) {
    fail({
      requiredSurface: null,
      claimClass: typeof claimClass === 'string' ? claimClass : null,
      recordedDiffFloor: null,
      expectedKind: null,
      foundKind: null,
      foundExitCode: null,
      reason: 'missing or invalid closeout_claim claimClass',
    })
  }

  const changedFiles = latestEvidence(evidence, 'changed_files')
  const config = loadConfig()
  const classifiedFloor = classifyChangedFiles(extractFiles(changedFiles), claimClass, config)
  const factFloor = changedFiles?.facts?.strongestSurface
  const recordedDiffFloor = isSurface(factFloor)
    ? maxSurface(classifiedFloor, factFloor)
    : classifiedFloor
  const requiredSurface = maxSurface(claimClass, recordedDiffFloor)
  const expectedKind = COVERAGE[requiredSurface].join('|')
  const found = findCoverage(evidence, requiredSurface)
  const foundExitCode = commandExitCode(found)

  if (!coversKind(found)) {
    fail({
      requiredSurface,
      claimClass,
      recordedDiffFloor,
      expectedKind,
      foundKind: found?.kind ?? null,
      foundExitCode,
      reason: found
        ? 'covering evidence kind was present but did not pass or exited nonzero'
        : 'missing covering evidence for required surface',
    })
  }

  process.exit(0)
}

if (import.meta.main) {
  main()
}
