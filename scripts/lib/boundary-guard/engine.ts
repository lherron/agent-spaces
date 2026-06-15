/**
 * Vendored boundary-guard engine.
 *
 * Catalog entry id: typescript/boundary-checks/boundary-guard
 * Archagent source: db405a216b06e74da6c4be2f104f04747a4e5d96
 *   agent-enablement/catalog/typescript/boundary-checks/boundary-guard/engine.ts
 * Agent-spaces adoption commit: see git log for this file.
 * Exercised by: bun scripts/check-boundaries.ts;
 *   bun scripts/check-runtime-contract-harness-boundaries.ts;
 *   bun scripts/check-manifest-edges.ts; just check; lefthook pre-commit.
 */
export interface Section3Fields {
  expected: string
  got: string
  fix: string
  why: string
  exception: string
  doNotSuppress: string
}

export interface GuardDiagnostic extends Section3Fields {
  location: { file: string; line: number }
  ruleId: string
}

export type FieldSpec<F> = string | ((finding: F) => string)

export interface ImportFinding {
  file: string
  line: number
  specifier: string
  token?: string
}

export interface TokenFinding {
  file: string
  line: number
  token: string
  text: string
}

export interface PresenceFinding {
  file: string
  line: number
}

interface RuleFields<F> {
  expected: FieldSpec<F>
  got: FieldSpec<F>
  fix: FieldSpec<F>
  why: FieldSpec<F>
  exception: FieldSpec<F>
  doNotSuppress: FieldSpec<F>
}

export interface ForbidImportRule extends RuleFields<ImportFinding> {
  id: string
  kind: 'forbid-import'
  match: (specifier: string) => boolean | string | undefined
}

export interface ForbidTokenRule extends RuleFields<TokenFinding> {
  id: string
  kind: 'forbid-token'
  match: (line: string) => boolean | string | undefined
}

export interface RequirePresenceRule extends RuleFields<PresenceFinding> {
  id: string
  kind: 'require-presence'
  match: (line: string) => boolean
}

export interface CustomRule {
  id: string
  kind: 'custom'
  detect: (ctx: GuardContext) => GuardDiagnostic[] | Promise<GuardDiagnostic[]>
}

export type GuardRule = ForbidImportRule | ForbidTokenRule | RequirePresenceRule | CustomRule

export interface Surface {
  dirs: string[]
  scriptPrefixes?: { dir: string; prefix: string }[]
  ignore?: string[]
}

export interface GuardContext {
  repoRoot: string
  surface: Surface
  files: string[]
  readFile(rel: string): string
  parseImports(file: string, content: string): ImportFinding[]
}

export interface Guard {
  surface: Surface
  rules: GuardRule[]
  repoRoot?: string
}

interface RunGuardOptions {
  emit?: (text: string) => void
}

declare const process: { cwd: () => string }
declare const console: { error: (message?: unknown, ...optionalParams: unknown[]) => void }

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>

const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport

export function defineGuard<G extends Guard>(g: G): G {
  return g
}

export async function runGuard(g: Guard, options: RunGuardOptions = {}): Promise<number> {
  const repoRoot = normalizePath(g.repoRoot ?? process.cwd())
  syncFs ??= (await dynamicImport('node:fs')) as {
    readFileSync: (path: string, encoding: string) => unknown
  }
  const files = await collectSurfaceFiles(repoRoot, g.surface)
  const fileContents = new Map<string, string>()

  const ctx: GuardContext = {
    repoRoot,
    surface: g.surface,
    files,
    readFile(rel: string): string {
      const normalized = normalizeRelPath(rel)
      const cached = fileContents.get(normalized)
      if (cached !== undefined) return cached

      const fs = getSyncFs()
      const content = String(fs.readFileSync(joinPath(repoRoot, normalized), 'utf8'))
      fileContents.set(normalized, content)
      return content
    },
    parseImports,
  }

  const diagnostics: GuardDiagnostic[] = []

  if (files.length === 0) {
    diagnostics.push(noFilesFoundDiagnostic(g.surface))
  } else {
    for (const file of files) {
      fileContents.set(file, ctx.readFile(file))
    }

    for (const rule of g.rules) {
      if (rule.kind === 'forbid-import') {
        diagnostics.push(...runForbidImport(rule, ctx))
      } else if (rule.kind === 'forbid-token') {
        diagnostics.push(...runForbidToken(rule, ctx))
      } else if (rule.kind === 'require-presence') {
        diagnostics.push(...runRequirePresence(rule, ctx))
      } else {
        diagnostics.push(...(await rule.detect(ctx)))
      }
    }
  }

  for (const diagnostic of diagnostics) {
    emitGuardDiagnostic(diagnostic, options.emit)
  }

  return diagnostics.length === 0 ? 0 : 1
}

export function parseImports(file: string, content: string): ImportFinding[] {
  const findings: ImportFinding[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1

    for (const pattern of [
      /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]) {
      pattern.lastIndex = 0
      let match = pattern.exec(line)
      while (match !== null) {
        findings.push({ file, line: lineNumber, specifier: match[1], token: match[1] })
        match = pattern.exec(line)
      }
    }
  }
  return findings
}

export function parseGuardDiagnostics(stderr: string): GuardDiagnostic[] {
  const blocks = stderr
    .split('\n--- boundary-guard diagnostic end ---')
    .map((block) => block.trim())
    .filter(Boolean)

  const diagnostics: GuardDiagnostic[] = []
  for (const block of blocks) {
    const payloadLine = block.split('\n').find((line) => line.startsWith('boundary-guard-json: '))
    if (!payloadLine) continue
    diagnostics.push(
      JSON.parse(payloadLine.slice('boundary-guard-json: '.length)) as GuardDiagnostic
    )
  }
  return diagnostics
}

function runForbidImport(rule: ForbidImportRule, ctx: GuardContext): GuardDiagnostic[] {
  const diagnostics: GuardDiagnostic[] = []
  for (const file of ctx.files) {
    const content = ctx.readFile(file)
    for (const finding of ctx.parseImports(file, content)) {
      const matched = rule.match(finding.specifier)
      if (!matched) continue
      diagnostics.push(
        fieldsToDiagnostic(
          rule.id,
          {
            ...finding,
            token: typeof matched === 'string' ? matched : finding.token,
          },
          rule
        )
      )
    }
  }
  return diagnostics
}

function runForbidToken(rule: ForbidTokenRule, ctx: GuardContext): GuardDiagnostic[] {
  const diagnostics: GuardDiagnostic[] = []
  for (const file of ctx.files) {
    const lines = ctx.readFile(file).split('\n')
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index]
      const matched = rule.match(text)
      if (!matched) continue
      const finding: TokenFinding = {
        file,
        line: index + 1,
        token: typeof matched === 'string' ? matched : text.trim(),
        text,
      }
      diagnostics.push(fieldsToDiagnostic(rule.id, finding, rule))
    }
  }
  return diagnostics
}

function runRequirePresence(rule: RequirePresenceRule, ctx: GuardContext): GuardDiagnostic[] {
  for (const file of ctx.files) {
    const lines = ctx.readFile(file).split('\n')
    if (lines.some((line) => rule.match(line))) return []
  }

  const finding: PresenceFinding = { file: ctx.files[0] ?? '(surface)', line: 0 }
  return [fieldsToDiagnostic(rule.id, finding, rule)]
}

function fieldsToDiagnostic<F extends { file: string; line: number }>(
  ruleId: string,
  finding: F,
  fields: RuleFields<F>
): GuardDiagnostic {
  return {
    location: { file: finding.file, line: finding.line },
    ruleId,
    expected: resolveField(fields.expected, finding),
    got: resolveField(fields.got, finding),
    fix: resolveField(fields.fix, finding),
    why: resolveField(fields.why, finding),
    exception: resolveField(fields.exception, finding),
    doNotSuppress: resolveField(fields.doNotSuppress, finding),
  }
}

function resolveField<F>(field: FieldSpec<F>, finding: F): string {
  return typeof field === 'function' ? field(finding) : field
}

function noFilesFoundDiagnostic(surface: Surface): GuardDiagnostic {
  return {
    location: { file: '(surface)', line: 0 },
    ruleId: 'boundary-guard:no-files-found',
    expected: 'at least one file in the configured boundary-guard surface',
    got: `no files found for surface dirs=${surface.dirs.join(',') || '(none)'}`,
    fix: 'check the surface dirs, scriptPrefixes, and ignore entries',
    why: 'a boundary guard that scans zero files can silently pass while checking nothing',
    exception: 'none',
    doNotSuppress: 'fix the surface configuration or add a fixture file',
  }
}

function emitGuardDiagnostic(diagnostic: GuardDiagnostic, emit?: (text: string) => void): void {
  const text = formatGuardDiagnostic(diagnostic)
  if (emit) {
    emit(text)
    return
  }
  console.error(text)
}

function formatGuardDiagnostic(diagnostic: GuardDiagnostic): string {
  return [
    '--- boundary-guard diagnostic ---',
    `rule: ${diagnostic.ruleId}`,
    `location: ${diagnostic.location.file}:${diagnostic.location.line}`,
    'expected-vs-got:',
    `  expected: ${diagnostic.expected}`,
    `  got: ${diagnostic.got}`,
    `FIX→ ${diagnostic.fix}`,
    `WHY→ ${diagnostic.why}`,
    `EXCEPTION→ ${diagnostic.exception}`,
    `DO-NOT-SUPPRESS→ ${diagnostic.doNotSuppress}`,
    `boundary-guard-json: ${JSON.stringify(diagnostic)}`,
    '--- boundary-guard diagnostic end ---',
  ].join('\n')
}

async function collectSurfaceFiles(repoRoot: string, surface: Surface): Promise<string[]> {
  const found = new Set<string>()

  for (const dir of surface.dirs) {
    await collectDir(repoRoot, normalizeRelPath(dir), surface, found)
  }

  for (const scriptPrefix of surface.scriptPrefixes ?? []) {
    await collectScriptPrefix(repoRoot, scriptPrefix, surface, found)
  }

  return [...found].sort()
}

async function collectDir(
  repoRoot: string,
  relDir: string,
  surface: Surface,
  found: Set<string>
): Promise<void> {
  const fs = await getAsyncFs()
  const absDir = joinPath(repoRoot, relDir)
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as typeof entries
  } catch {
    return
  }

  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (isIgnored(rel, surface.ignore)) continue
    if (entry.isDirectory()) {
      await collectDir(repoRoot, rel, surface, found)
    } else if (entry.isFile()) {
      found.add(rel)
    }
  }
}

async function collectScriptPrefix(
  repoRoot: string,
  scriptPrefix: { dir: string; prefix: string },
  surface: Surface,
  found: Set<string>
): Promise<void> {
  const fs = await getAsyncFs()
  const relDir = normalizeRelPath(scriptPrefix.dir)
  const absDir = joinPath(repoRoot, relDir)
  let entries: Array<{ name: string; isFile: () => boolean }>
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as typeof entries
  } catch {
    return
  }

  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (!entry.isFile() || !entry.name.startsWith(scriptPrefix.prefix)) continue
    if (isIgnored(rel, surface.ignore)) continue
    found.add(rel)
  }
}

let asyncFs: Record<string, unknown> | undefined
async function getAsyncFs(): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  asyncFs ??= await dynamicImport('node:fs/promises')
  return asyncFs as Record<string, (...args: unknown[]) => Promise<unknown>>
}

let syncFs: { readFileSync: (path: string, encoding: string) => unknown } | undefined
function getSyncFs(): { readFileSync: (path: string, encoding: string) => unknown } {
  if (!syncFs) throw new Error('boundary-guard fs was not initialized')
  return syncFs
}

function isIgnored(rel: string, ignore: string[] = []): boolean {
  const normalized = normalizeRelPath(rel)
  return ignore.some((entry) => {
    const ignored = normalizeRelPath(entry)
    return (
      normalized === ignored ||
      normalized.startsWith(`${ignored}/`) ||
      normalized.includes(`/${ignored}/`) ||
      normalized.endsWith(`/${ignored}`)
    )
  })
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizeRelPath(path: string): string {
  return normalizePath(path).replace(/^\/+/, '').replace(/\/+/g, '/')
}

function joinPath(root: string, rel: string): string {
  return rel ? `${normalizePath(root)}/${normalizeRelPath(rel)}` : normalizePath(root)
}
