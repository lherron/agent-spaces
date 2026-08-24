import type { Dirent } from 'node:fs'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

export type ImportReference = {
  file: string
  line: number
  specifier: string
}

export type ExportReference = {
  file: string
  line: number
  kind: 'star' | 'namespace' | 'type' | 'value'
  statement: string
  symbol?: string | undefined
  local?: string | undefined
  specifier?: string | undefined
}

export type ImportEdge = ImportReference & {
  target?: string
  targetPackage?: string
}

export type DependencyGraph = {
  files: string[]
  edges: ImportEdge[]
  packageNames: Map<string, string>
}

export const aspRootDag = ['apps', 'harness', 'compiler', 'drivers', 'core', 'contracts'] as const

export type AspRoot = (typeof aspRootDag)[number]

export type AspWorkspacePackage = {
  dir: string
  name: string
  root: AspRoot
}

const aspWorkspaceRoots: readonly AspRoot[] = aspRootDag
const importGraphRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const externalForbidden = [
  'hrc-',
  'acp-',
  'gateway-',
  'coordination-substrate',
  'wrkq-lib',
  'wlearn',
]

export function discoverAspWorkspacePackages(
  repoRoot = importGraphRepoRoot
): AspWorkspacePackage[] {
  const packages: AspWorkspacePackage[] = []

  for (const root of aspRootDag) {
    const rootDir = join(repoRoot, root)
    if (!existsSync(rootDir)) {
      continue
    }

    for (const entry of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const dir = `${root}/${entry.name}`
      const manifestPath = join(repoRoot, dir, 'package.json')
      if (!entry.isDirectory() || !existsSync(manifestPath)) {
        continue
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`${dir}/package.json has no package name`)
      }
      packages.push({ dir, name: manifest.name, root })
    }
  }

  return packages
}

export const aspWorkspacePackages = discoverAspWorkspacePackages()
export const aspPackages = aspWorkspacePackages.map(({ dir }) => dir)

function layerName(root: AspRoot): string {
  return `${root[0]?.toUpperCase()}${root.slice(1)}`
}

/**
 * Root order is the architecture: apps -> harness -> compiler -> drivers ->
 * core -> contracts. A root rejects every package strictly above it. Package
 * names are discovered from manifests, so adding a package cannot create an
 * unguarded hole or require another copied forbidden list.
 *
 * integration-tests is intentionally governed with apps: repo-level suites
 * may compose every ASP root, but still inherit the external-package guard.
 *
 * Compiler is the one deliberately narrower root: it may reach only core and
 * contracts, never the driver/SDK plane. The compiler's contract dependencies
 * (including broker protocol/client per T-07314 AC-1) remain permitted by
 * direction. Harness broker pi-sdk -> harness broker is intra-root and legal.
 */
export function deriveAspRootLayers(
  workspacePackages: readonly AspWorkspacePackage[] = aspWorkspacePackages
): Layer[] {
  return aspRootDag.map((root, rootIndex) => ({
    name: layerName(root),
    roots: root === 'apps' ? [root, 'integration-tests'] : [root],
    forbidden: [
      ...new Set([
        ...workspacePackages
          .filter(
            (pkg) =>
              aspRootDag.indexOf(pkg.root) < rootIndex ||
              (root === 'compiler' && pkg.root === 'drivers')
          )
          .map((pkg) => pkg.name),
        ...externalForbidden,
      ]),
    ],
  }))
}

export const layers: Layer[] = [
  ...deriveAspRootLayers(),
  // Documented intra-CONTRACTS exception to the root-is-seam rule. Primary
  // ruling #20151 makes this prohibition ratified-deliberate: the zero-dep
  // broker wire protocol must not reach spaces-runtime-contracts to share the
  // permanently excluded broker-plane canonical-JSON implementations.
  {
    name: 'Harness Broker Protocol Contract Exception',
    roots: ['contracts/harness-broker-protocol'],
    forbidden: ['spaces-runtime-contracts'],
  },
]

// REQUIRED_BOUNDARY_CHECKS remains the contract-side shape declaration with
// its T-07317 test guard. Consumption remains owned by hrc-runtime; this root
// rewrite neither consumes nor duplicates it.

export const ignoredDirectories = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

export const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

export async function collectTsFiles(root: string): Promise<string[]> {
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

      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path)
      }
    }
  }

  await walk(root)
  return files
}

export function packageGroup(file: string): string {
  const parts = file.split('/')
  if (parts[0] && parts[1]) {
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0] ?? dirname(file)
}

export function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

export function parseImportReferences(file: string, content: string): ImportReference[] {
  const imports: ImportReference[] = []
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2]
    if (!specifier) {
      continue
    }

    imports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      specifier,
    })
  }
  return imports
}

function lineNumberForExportMember(
  content: string,
  fallbackIndex: number,
  memberIndex: number
): number {
  return lineNumberForIndex(content, memberIndex >= 0 ? memberIndex : fallbackIndex)
}

function parseExportMembers(text: string): string[] {
  return text
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean)
}

function cleanExportMember(
  text: string
): { local: string; symbol: string; typeOnly: boolean } | undefined {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (!withoutComments) {
    return undefined
  }

  const typeOnly = withoutComments.startsWith('type ')
  const cleaned = typeOnly ? withoutComments.replace(/^type\s+/, '').trim() : withoutComments
  const aliasMatch = cleaned.match(/^([A-Za-z_$][\w$]*|default)\s+as\s+([A-Za-z_$][\w$]*)$/)
  if (aliasMatch) {
    return { local: aliasMatch[1], symbol: aliasMatch[2], typeOnly }
  }

  const nameMatch = cleaned.match(/^([A-Za-z_$][\w$]*|default)$/)
  if (nameMatch) {
    return { local: nameMatch[1], symbol: nameMatch[1], typeOnly }
  }

  return undefined
}

export function parseExportReferences(file: string, content: string): ExportReference[] {
  const exports: ExportReference[] = []

  for (const match of content.matchAll(
    /\bexport\s+(type\s+)?\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?/g
  )) {
    const typeOnlyBlock = Boolean(match[1])
    const members = match[2] ?? ''
    const specifier = match[3]
    const statement = match[0]
    const statementIndex = match.index

    for (const member of parseExportMembers(members)) {
      const parsed = cleanExportMember(member)
      if (!parsed) {
        continue
      }

      const memberIndex = content.indexOf(member, statementIndex)
      exports.push({
        file,
        line: lineNumberForExportMember(content, statementIndex, memberIndex),
        kind: typeOnlyBlock || parsed.typeOnly ? 'type' : 'value',
        statement,
        symbol: parsed.symbol,
        local: parsed.local,
        specifier,
      })
    }
  }

  for (const match of content.matchAll(
    /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g
  )) {
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: 'namespace',
      statement: match[0],
      symbol: match[1],
      local: '*',
      specifier: match[2],
    })
  }

  for (const match of content.matchAll(/\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: 'star',
      statement: match[0],
      specifier: match[1],
    })
  }

  for (const match of content.matchAll(
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(type|interface|const|let|var|async\s+function|function|class|enum)\s+([A-Za-z_$][\w$]*)/g
  )) {
    const declarationKind = match[1]
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: declarationKind === 'type' || declarationKind === 'interface' ? 'type' : 'value',
      statement: match[0],
      symbol: match[2],
      local: match[2],
    })
  }

  for (const match of content.matchAll(
    /\bexport\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)?/g
  )) {
    exports.push({
      file,
      line: lineNumberForIndex(content, match.index),
      kind: 'value',
      statement: match[0],
      symbol: 'default',
      local: match[1] || 'default',
    })
  }

  return exports.sort(
    (left, right) => left.line - right.line || left.symbol?.localeCompare(right.symbol ?? '') || 0
  )
}

export async function parseFileImports(
  file: string,
  repoRoot = process.cwd()
): Promise<ImportReference[]> {
  const content = await readFile(join(repoRoot, file), 'utf8')
  return parseImportReferences(file, content)
}

export function isForbidden(specifier: string, token: string): boolean {
  if (token.endsWith('-')) {
    return specifier.startsWith(token)
  }
  return specifier === token || specifier.startsWith(`${token}/`)
}

export function layerOf(file: string): string {
  const normalized = file.split(sep).join('/')
  const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`
  for (const layer of layers) {
    if (
      layer.roots.some((root) => {
        const rootPrefix = root.endsWith('/') ? root : `${root}/`
        return normalized === root || withSlash.startsWith(rootPrefix)
      })
    ) {
      return layer.name
    }
  }
  return 'Unclassified'
}

export function repoPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

async function buildPackageNameMap(repoRoot: string): Promise<Map<string, string>> {
  const packageNames = new Map<string, string>()
  for (const workspaceRoot of aspWorkspaceRoots) {
    const workspaceDir = join(repoRoot, workspaceRoot)
    let entries: Dirent[]
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        continue
      }
      throw error
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const packageDir = `${workspaceRoot}/${entry.name}`
      try {
        const packageJson = JSON.parse(
          await readFile(join(repoRoot, packageDir, 'package.json'), 'utf8')
        ) as {
          name?: string
        }
        if (typeof packageJson.name === 'string') {
          packageNames.set(packageJson.name, packageDir)
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'ENOENT') {
          throw error
        }
      }
    }
  }

  return packageNames
}

function existingRepoPath(repoRoot: string, absoluteBase: string): string | undefined {
  const candidates =
    extname(absoluteBase) === ''
      ? [
          absoluteBase,
          `${absoluteBase}.ts`,
          `${absoluteBase}.tsx`,
          join(absoluteBase, 'index.ts'),
          join(absoluteBase, 'index.tsx'),
        ]
      : [
          absoluteBase,
          absoluteBase.replace(/\.(js|mjs|cjs)$/, '.ts'),
          absoluteBase.replace(/\.(js|mjs|cjs)$/, '.tsx'),
        ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return repoPath(repoRoot, candidate)
    }
  }

  return undefined
}

export function resolveImportTarget(
  fromFile: string,
  specifier: string,
  packageNames: Map<string, string>,
  repoRoot = process.cwd()
): Pick<ImportEdge, 'target' | 'targetPackage'> {
  if (specifier.startsWith('.')) {
    const absoluteFrom = join(repoRoot, fromFile)
    const target = existingRepoPath(repoRoot, resolve(dirname(absoluteFrom), specifier))
    return target ? { target, targetPackage: packageGroup(target) } : {}
  }

  const [scopeOrName, maybeName] = specifier.split('/')
  const packageName = specifier.startsWith('@') ? `${scopeOrName}/${maybeName}` : scopeOrName
  if (packageName) {
    const targetPackage = packageNames.get(packageName)
    if (targetPackage) {
      return { target: targetPackage, targetPackage }
    }
  }

  return {}
}

export async function buildDependencyGraph(
  repoRoot = process.cwd(),
  roots = [...aspWorkspaceRoots, 'integration-tests']
): Promise<DependencyGraph> {
  const packageNames = await buildPackageNameMap(repoRoot)
  const files = (
    await Promise.all(roots.map((root) => collectTsFiles(join(repoRoot, root))))
  ).flat()
  const edges: ImportEdge[] = []

  for (const absoluteFile of files.sort()) {
    const file = repoPath(repoRoot, absoluteFile)
    const content = await readFile(absoluteFile, 'utf8')
    for (const reference of parseImportReferences(file, content)) {
      edges.push({
        ...reference,
        ...resolveImportTarget(reference.file, reference.specifier, packageNames, repoRoot),
      })
    }
  }

  return {
    files: files.map((file) => repoPath(repoRoot, file)).sort(),
    edges,
    packageNames,
  }
}
