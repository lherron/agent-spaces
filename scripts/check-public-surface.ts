import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  type ExportReference,
  lineNumberForIndex,
  parseExportReferences,
  resolveImportTarget,
} from './lib/import-graph.ts'

type CliOptions = {
  root: string
  baseline: string
  updateBaseline: boolean
}

type RatifiedPackage = {
  dir: string
  fallbackName: string
}

type Surface = {
  package: string
  symbol: string
  kind: string
  file: string
  line: number
  waiver?: WaiverResult | undefined
}

type BaselineEntry = {
  package: string
  symbol: string
  kind: string
  file: string
  hash: string
  count: number
}

type BaselineFile = {
  _meta?: unknown
  surfaces?: BaselineEntry[]
}

type WaiverResult =
  | { valid: true; text: string }
  | { valid: false; text: string; reason: string }
  | undefined

type ParserDiagnostic = {
  file: string
  line: number
  message: string
}

type CoverageFile = {
  file: string
  content: string
  stringLiterals: Set<string>
}

type CommandContext = {
  surfaces: Surface[]
  visited: Set<string>
}

const ratifiedPackages: RatifiedPackage[] = [
  { dir: 'packages/agent-scope', fallbackName: 'agent-scope' },
  { dir: 'packages/aspc-protocol', fallbackName: 'spaces-aspc-protocol' },
  { dir: 'packages/harness-broker-protocol', fallbackName: 'spaces-harness-broker-protocol' },
  { dir: 'packages/spaces-runtime-contracts', fallbackName: 'spaces-runtime-contracts' },
]

const workspacePackageDirs = new Map([
  ['agent-scope', 'packages/agent-scope'],
  ['spaces-aspc-protocol', 'packages/aspc-protocol'],
  ['spaces-harness-broker-protocol', 'packages/harness-broker-protocol'],
  ['spaces-runtime-contracts', 'packages/spaces-runtime-contracts'],
])

const ignoredDirectories = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

const baselineMeta = {
  schemaVersion: 1,
  generatedBy: 'bun scripts/check-public-surface.ts --update-baseline',
  warning:
    'Grandfathers current public contract surfaces. Regenerate only after reviewed contract coverage or ticketed waiver decisions.',
}

function parseArgs(argv: string[]): CliOptions {
  let root = process.cwd()
  let baseline = join(process.cwd(), '.public-surface-baseline.json')
  let updateBaseline = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--root requires a directory')
      }
      root = resolve(value)
      index += 1
      continue
    }

    if (arg === '--baseline') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--baseline requires a path')
      }
      baseline = isAbsolute(value) ? value : resolve(process.cwd(), value)
      index += 1
      continue
    }

    if (arg === '--update-baseline') {
      updateBaseline = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return { root, baseline, updateBaseline }
}

function toSlash(path: string): string {
  return path.split(sep).join('/')
}

function repoPath(root: string, path: string): string {
  return toSlash(relative(root, path))
}

async function readText(root: string, file: string): Promise<string> {
  return readFile(join(root, file), 'utf8')
}

function identityOf(surface: Pick<Surface, 'package' | 'symbol' | 'kind'>): string {
  return `${surface.package}|${surface.symbol}|${surface.kind}`
}

function commandName(raw: string): string {
  return raw.trim().split(/\s+/)[0] ?? raw.trim()
}

function isJunkReason(reason: string): boolean {
  const normalized = reason
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim()
  return !normalized || new Set(['todo', 'temporary', 'fix later']).has(normalized)
}

function validWaiverInText(text: string): WaiverResult {
  const ticketed = text.match(/\b(CONTRACT-EXEMPT|TACIT)\(T-\d{4,}\):\s*(.+)$/)
  if (ticketed) {
    const reason = ticketed[2].replace(/\*\/\s*$/, '').trim()
    if (isJunkReason(reason)) {
      return {
        valid: false,
        text: ticketed[0],
        reason: `invalid waiver reason: ${reason || 'empty'}`,
      }
    }
    return { valid: true, text: ticketed[0] }
  }

  const bare = text.match(/\b(CONTRACT-EXEMPT|TACIT)\([^)]*\):?\s*(.*)$/)
  if (bare) {
    return { valid: false, text: bare[0], reason: 'waiver must include a T-#### ticket' }
  }

  return undefined
}

function adjacentWaiver(content: string, line: number): WaiverResult {
  const lines = content.split('\n')
  const sameLine = lines[line - 1] ?? ''
  const same = validWaiverInText(sameLine)
  if (same) {
    return same
  }

  const previousLine = lines[line - 2] ?? ''
  return validWaiverInText(previousLine)
}

function resolveModule(root: string, fromFile: string, specifier: string): string | undefined {
  const resolved = resolveImportTarget(fromFile, specifier, workspacePackageDirs, root)
  if (!resolved.target) {
    return undefined
  }

  const packageIndex = `${resolved.target}/src/index.ts`
  if (!specifier.startsWith('.') && existsSync(join(root, packageIndex))) {
    return packageIndex
  }

  return resolved.target
}

function failParser(
  diagnostics: ParserDiagnostic[],
  reference: ExportReference,
  message: string
): void {
  diagnostics.push({ file: reference.file, line: reference.line, message })
}

async function packageName(root: string, pkg: RatifiedPackage): Promise<string> {
  try {
    const packageJson = JSON.parse(await readText(root, `${pkg.dir}/package.json`)) as {
      name?: unknown
    }
    return typeof packageJson.name === 'string' ? packageJson.name : pkg.fallbackName
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return pkg.fallbackName
    }
    throw error
  }
}

async function resolveSymbolOrigin(
  root: string,
  file: string,
  local: string,
  diagnostics: ParserDiagnostic[],
  visited = new Set<string>()
): Promise<
  { file: string; line: number; kind: string; waiver?: WaiverResult | undefined } | undefined
> {
  const key = `${file}:${local}`
  if (visited.has(key)) {
    return undefined
  }
  visited.add(key)

  const content = await readText(root, file)
  const refs = parseExportReferences(file, content)

  for (const ref of refs) {
    if (!ref.symbol) {
      continue
    }

    if (!ref.specifier && ref.symbol === local) {
      return {
        file,
        line: ref.line,
        kind: ref.kind === 'type' ? 'type' : 'value',
        waiver: adjacentWaiver(content, ref.line),
      }
    }

    if (ref.specifier && ref.symbol === local && ref.local) {
      const target = resolveModule(root, file, ref.specifier)
      if (!target) {
        failParser(diagnostics, ref, `cannot resolve re-export '${ref.specifier}' for ${local}`)
        return undefined
      }
      return resolveSymbolOrigin(root, target, ref.local, diagnostics, visited)
    }
  }

  for (const ref of refs) {
    if (ref.kind !== 'star' || !ref.specifier) {
      continue
    }
    const target = resolveModule(root, file, ref.specifier)
    if (!target) {
      failParser(
        diagnostics,
        ref,
        `cannot resolve star export '${ref.specifier}' while looking for ${local}`
      )
      continue
    }
    const origin = await resolveSymbolOrigin(root, target, local, diagnostics, visited)
    if (origin) {
      return origin
    }
  }

  return undefined
}

async function collectModuleSurfaces(
  root: string,
  packageName: string,
  file: string,
  diagnostics: ParserDiagnostic[],
  visited = new Set<string>()
): Promise<Surface[]> {
  if (visited.has(file)) {
    return []
  }
  visited.add(file)

  const content = await readText(root, file)
  const refs = parseExportReferences(file, content)
  const surfaces: Surface[] = []

  for (const ref of refs) {
    if (ref.kind === 'star') {
      if (!ref.specifier) {
        continue
      }
      const target = resolveModule(root, file, ref.specifier)
      if (!target) {
        failParser(diagnostics, ref, `cannot resolve star export '${ref.specifier}'`)
        continue
      }
      surfaces.push(
        ...(await collectModuleSurfaces(root, packageName, target, diagnostics, visited))
      )
      continue
    }

    if (!ref.symbol) {
      continue
    }

    if (ref.kind === 'namespace') {
      surfaces.push({
        package: packageName,
        symbol: ref.symbol,
        kind: 'namespace',
        file: ref.file,
        line: ref.line,
        waiver: adjacentWaiver(content, ref.line),
      })
      continue
    }

    if (!ref.specifier) {
      surfaces.push({
        package: packageName,
        symbol: ref.symbol,
        kind: ref.kind === 'type' ? 'type' : 'value',
        file: ref.file,
        line: ref.line,
        waiver: adjacentWaiver(content, ref.line),
      })
      continue
    }

    const target = resolveModule(root, file, ref.specifier)
    if (!target || !ref.local) {
      failParser(diagnostics, ref, `cannot resolve re-export '${ref.specifier}' for ${ref.symbol}`)
      continue
    }

    const origin = await resolveSymbolOrigin(root, target, ref.local, diagnostics)
    if (!origin) {
      failParser(
        diagnostics,
        ref,
        `cannot resolve exported symbol '${ref.local}' from '${ref.specifier}'`
      )
      continue
    }
    surfaces.push({
      package: packageName,
      symbol: ref.symbol,
      kind: ref.kind === 'type' ? 'type' : origin.kind,
      file: origin.file,
      line: origin.line,
      waiver: adjacentWaiver(content, ref.line) ?? origin.waiver,
    })
  }

  return surfaces
}

async function collectPackageSurfaces(
  root: string,
  diagnostics: ParserDiagnostic[]
): Promise<Surface[]> {
  const surfaces: Surface[] = []
  for (const pkg of ratifiedPackages) {
    const indexFile = `${pkg.dir}/src/index.ts`
    if (!existsSync(join(root, indexFile))) {
      continue
    }
    surfaces.push(
      ...(await collectModuleSurfaces(root, await packageName(root, pkg), indexFile, diagnostics))
    )
  }
  return surfaces
}

async function collectFiles(root: string, predicate: (file: string) => boolean): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile()) {
        const rel = repoPath(root, path)
        if (predicate(rel)) {
          files.push(rel)
        }
      }
    }
  }

  await walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function stringLiterals(content: string): Set<string> {
  const literals = new Set<string>()
  for (const match of content.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    literals.add(match[2])
  }
  return literals
}

async function collectCoverageFiles(root: string): Promise<CoverageFile[]> {
  const files = await collectFiles(root, (file) => {
    if (file === 'scripts/check-public-surface.test.ts') {
      return false
    }
    if (file.startsWith('scripts/pre-hrc-broker-matrix') && file.endsWith('.ts')) {
      return true
    }
    return (
      file.startsWith('packages/') &&
      (file.endsWith('.test.ts') || file.endsWith('.red.test.ts') || file.endsWith('.test-d.ts'))
    )
  })

  return Promise.all(
    files.map(async (file) => {
      const content = await readText(root, file)
      return { file, content, stringLiterals: stringLiterals(content) }
    })
  )
}

function symbolCovered(surface: Surface, corpus: CoverageFile[]): boolean {
  if (surface.kind === 'command') {
    const segments = surface.symbol.split(/\s+/).slice(1)
    return corpus.some((file) => {
      if (file.content.includes(surface.symbol)) {
        return true
      }
      return segments.every((segment) => file.stringLiterals.has(segment))
    })
  }

  const token = new RegExp(
    `(?<![A-Za-z0-9_$])${surface.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`
  )
  return corpus.some((file) => token.test(file.content))
}

function parseImportMap(root: string, file: string, content: string): Map<string, string> {
  const imports = new Map<string, string>()
  for (const match of content.matchAll(/\bimport\s+\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const specifier = match[2]
    const target = resolveModule(root, file, specifier)
    if (!target) {
      continue
    }
    for (const name of names) {
      const alias = name.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (alias) {
        imports.set(alias[2], target)
      } else {
        imports.set(name, target)
      }
    }
  }
  return imports
}

function findFunctionBlock(content: string, functionName: string): string | undefined {
  const pattern = new RegExp(`\\bfunction\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`, 'm')
  const match = content.match(pattern)
  if (!match || match.index === undefined) {
    return undefined
  }

  const start = match.index + match[0].length
  let depth = 1
  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return content.slice(start, index)
      }
    }
  }

  return undefined
}

function registrarIdentifiers(content: string): string[] {
  const match = content.match(/COMMAND_REGISTRARS[\s\S]*?=\s*\[([\s\S]*?)\]/)
  if (!match) {
    return []
  }
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^register[A-Za-z0-9_$]+$/.test(part))
}

function addCommandSurface(
  context: CommandContext,
  symbol: string,
  file: string,
  line: number,
  content: string
): void {
  context.surfaces.push({
    package: 'asp-cli',
    symbol,
    kind: 'command',
    file,
    line,
    waiver: adjacentWaiver(content, line),
  })
}

function scanCommandChains(
  block: string,
  file: string,
  content: string,
  receiverPrefixes: Map<string, string[]>,
  context: CommandContext
): void {
  for (const match of block.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*((?:\.\s*command\(\s*['"][^'"]+['"]\s*\))+)/g
  )) {
    const receiver = match[1]
    const prefix = receiverPrefixes.get(receiver)
    if (!prefix) {
      continue
    }

    let current = [...prefix]
    const chain = match[2]
    for (const command of chain.matchAll(/\.command\(\s*['"]([^'"]+)['"]/g)) {
      current = [...current, commandName(command[1])]
      addCommandSurface(
        context,
        ['asp', ...current].join(' '),
        file,
        lineNumberForIndex(content, content.indexOf(command[0], content.indexOf(match[0]))),
        content
      )
    }
  }
}

async function scanRegistrar(
  root: string,
  file: string,
  functionName: string,
  prefix: string[],
  context: CommandContext
): Promise<void> {
  const key = `${file}:${functionName}:${prefix.join('/')}`
  if (context.visited.has(key)) {
    return
  }
  context.visited.add(key)

  const content = await readText(root, file)
  const imports = parseImportMap(root, file, content)
  const block = findFunctionBlock(content, functionName) ?? content
  const receiverPrefixes = new Map<string, string[]>([['program', prefix]])

  for (const match of block.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.command\(\s*['"]([^'"]+)['"]/g
  )) {
    const receiver = match[2]
    const receiverPrefix = receiverPrefixes.get(receiver)
    if (!receiverPrefix) {
      continue
    }
    const current = [...receiverPrefix, commandName(match[3])]
    receiverPrefixes.set(match[1], current)
    addCommandSurface(
      context,
      ['asp', ...current].join(' '),
      file,
      lineNumberForIndex(content, content.indexOf(match[0])),
      content
    )
  }

  scanCommandChains(block, file, content, receiverPrefixes, context)

  for (const match of block.matchAll(/\b(register[A-Za-z0-9_$]+)\(([^)]*)\)/g)) {
    const target = imports.get(match[1])
    if (!target) {
      continue
    }
    const arg = match[2].split(',')[0]?.trim()
    const childPrefix = arg ? receiverPrefixes.get(arg) : undefined
    if (childPrefix) {
      await scanRegistrar(root, target, match[1], childPrefix, context)
    }
  }
}

async function collectCliSurfaces(root: string): Promise<Surface[]> {
  const registry = 'packages/cli/src/command-registry.ts'
  if (!existsSync(join(root, registry))) {
    return []
  }

  const content = await readText(root, registry)
  const imports = parseImportMap(root, registry, content)
  const context: CommandContext = { surfaces: [], visited: new Set() }

  scanCommandChains(content, registry, content, new Map([['program', []]]), context)

  for (const identifier of registrarIdentifiers(content)) {
    const target = imports.get(identifier)
    if (target) {
      await scanRegistrar(root, target, identifier, [], context)
    }
  }

  return context.surfaces
}

function dedupeSurfaces(surfaces: Surface[]): Surface[] {
  const byIdentity = new Map<string, Surface>()
  for (const surface of surfaces) {
    const identity = identityOf(surface)
    const existing = byIdentity.get(identity)
    if (!existing || surface.file.localeCompare(existing.file) < 0) {
      byIdentity.set(identity, surface)
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    identityOf(left).localeCompare(identityOf(right))
  )
}

function baselineEntries(surfaces: Surface[]): BaselineEntry[] {
  const grouped = new Map<string, Surface[]>()
  for (const surface of surfaces) {
    const identity = identityOf(surface)
    grouped.set(identity, [...(grouped.get(identity) ?? []), surface])
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hash, group]) => {
      const first = group.sort((left, right) => left.file.localeCompare(right.file))[0]
      return {
        package: first.package,
        symbol: first.symbol,
        kind: first.kind,
        file: first.file,
        hash,
        count: group.length,
      }
    })
}

async function readBaseline(path: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BaselineFile
    return new Set(
      (parsed.surfaces ?? []).map(
        (entry) => entry.hash ?? `${entry.package}|${entry.symbol}|${entry.kind}`
      )
    )
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return new Set()
    }
    throw error
  }
}

async function writeBaseline(path: string, surfaces: Surface[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const payload = {
    _meta: baselineMeta,
    surfaces: baselineEntries(surfaces),
  }
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`)
}

function printSurfaceViolation(surface: Surface): void {
  console.error('    x PUBLIC_SURFACE new public surface lacks contract coverage')
  console.error(`      ${surface.file}:${surface.line}`)
  console.error(
    `      expected: public surface '${surface.package}|${surface.symbol}|${surface.kind}' is in .public-surface-baseline.json, covered by the allowed corpus, or has a ticketed adjacent waiver; got: new uncovered public surface`
  )
  console.error(
    '      FIX -> add a symbol-level contract test/matrix row, regenerate the baseline after reviewed approval, or add an adjacent ticketed waiver.'
  )
  console.error(
    '      WHY -> public contract surfaces are compatibility promises; new ones need tests or an explicit tracked exception.'
  )
  console.error(
    '      EXCEPTION -> // CONTRACT-EXEMPT(T-####): reason or // TACIT(T-####): reason on the same or immediately preceding line.'
  )
  if (surface.waiver && !surface.waiver.valid) {
    console.error(`      waiver rejected: ${surface.waiver.reason} (${surface.waiver.text})`)
  }
  console.error('      Do not suppress, silence, disable, or re-export to hide this; cover it.')
}

function printParserDiagnostic(diagnostic: ParserDiagnostic): void {
  console.error('    x PUBLIC_SURFACE_PARSER_SUPPORT unresolved public barrel export')
  console.error(`      ${diagnostic.file}:${diagnostic.line}`)
  console.error(
    `      expected: barrel export resolves to origin symbols; got: ${diagnostic.message}`
  )
  console.error(
    '      FIX -> extend scripts/lib/import-graph.ts export parsing or adjust the barrel to a supported explicit export form.'
  )
  console.error(
    '      WHY -> unresolved barrels cannot be safely treated as covered or waived without hiding public contract drift.'
  )
  console.error(
    '      EXCEPTION -> no inline exception for parser support gaps; make the scanner understand the export.'
  )
  console.error(
    '      Do not suppress, silence, disable, or re-export to hide this; fix the parser support.'
  )
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const diagnostics: ParserDiagnostic[] = []
  const surfaces = dedupeSurfaces([
    ...(await collectPackageSurfaces(options.root, diagnostics)),
    ...(await collectCliSurfaces(options.root)),
  ])

  if (diagnostics.length > 0) {
    console.error('Public surface check failed: unsupported public barrel export form.')
    for (const diagnostic of diagnostics) {
      printParserDiagnostic(diagnostic)
    }
    process.exit(1)
  }

  if (options.updateBaseline) {
    await writeBaseline(options.baseline, surfaces)
    console.log(`Public surface baseline updated: ${repoPath(options.root, options.baseline)}`)
    process.exit(0)
  }

  const baseline = await readBaseline(options.baseline)
  const corpus = await collectCoverageFiles(options.root)
  const violations = surfaces.filter((surface) => {
    if (baseline.has(identityOf(surface))) {
      return false
    }
    if (symbolCovered(surface, corpus)) {
      return false
    }
    return !surface.waiver?.valid
  })

  if (violations.length === 0) {
    console.log('Public surface check passed.')
    process.exit(0)
  }

  console.error('Public surface check failed: new uncovered public contract surfaces found.')
  for (const violation of violations) {
    printSurfaceViolation(violation)
  }
  process.exit(1)
}

await main()
