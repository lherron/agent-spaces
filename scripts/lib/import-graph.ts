import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

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

export const aspPackages = [
  'contracts/agent-scope',
  'contracts/harness-broker-protocol',
  'contracts/spaces-runtime-contracts',
  'contracts/aspc-protocol',
  'contracts/harness-broker-client',
  'core/config',
  'core/runtime',
  'drivers/harness-claude',
  'drivers/harness-codex',
  'drivers/harness-pi',
  'drivers/harness-pi-sdk',
  'drivers/execution',
  'compiler/agent-spaces',
  'compiler/aspc',
  'harness/harness-broker-pi-sdk',
  'harness/aspc-facade',
  'apps/cli-kit',
  'apps/turn-runner',
  'apps/cli',
]

const aspWorkspaceRoots = ['contracts', 'core', 'drivers', 'compiler', 'harness', 'apps']

export const hrcPackages = [
  'agent-action-render',
  'hrc-core',
  'hrc-events',
  'hrc-store-sqlite',
  'hrc-server',
  'hrc-sdk',
  'hrc-cli',
  'hrcchat-cli',
  'hrc-frame-render',
]

export const layers: Layer[] = [
  // CONTRACTS seam (future `spaces-contracts` repo): the zero-dep wire protocol,
  // the innermost layer of the ratified `agent-spaces.raspc-migration-contract`
  // direction harness -> aspc -> spaces-contracts.
  // Its spaces-runtime-contracts prohibition is ratified-deliberate, not an
  // accident of history: primary ruling #20151 classifies the broker-plane
  // canonical-JSON implementations as a permanent exclusion from the
  // single-implementation property, so this layer must not reach up into
  // spaces-runtime-contracts to share them.
  {
    name: 'Harness Broker Protocol',
    roots: ['contracts/harness-broker-protocol/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-runtime-contracts',
      'spaces-execution',
      'spaces-harness-',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'spaces-aspc-facade',
      'spaces-turn-runner',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // CONTRACTS seam: forbids every downstream ASP package. Intra-CONTRACTS edges
  // (this layer's own dependency on spaces-harness-broker-protocol) are not
  // re-litigated here.
  {
    name: 'Runtime Contracts',
    roots: ['contracts/spaces-runtime-contracts/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker',
      'spaces-harness-broker-client',
      'spaces-harness-broker-pi-sdk',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'spaces-aspc-facade',
      'spaces-turn-runner',
      'agent-spaces',
      '@lherron/agent-spaces',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // CONTRACTS seam: forbids every downstream ASP package.
  {
    name: 'ASPC Protocol',
    roots: ['contracts/aspc-protocol/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker-client',
      'spaces-harness-broker-pi-sdk',
      'spaces-harness-broker',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc',
      'spaces-aspc-facade',
      'spaces-turn-runner',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // CONTRACTS seam: agent-scope is the zero-dep root of the contracts repo, so
  // every non-contracts ASP package is downstream of it.
  {
    name: 'Agent Scope',
    roots: ['contracts/agent-scope/src'],
    forbidden: [
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-runtime-contracts',
      'spaces-execution',
      'spaces-harness-',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'spaces-aspc-facade',
      'spaces-turn-runner',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'Harness Broker Client',
    roots: ['contracts/harness-broker-client/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'agent-spaces',
      '@lherron/agent-spaces',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // HARNESS seam (future harness repo). Compiler-side packages are forbidden so
  // P2's split is a file move: spaces-aspc-facade and spaces-turn-runner are
  // named explicitly because 'spaces-aspc' is exact-or-slash and never reaches
  // the facade.
  // Deliberate exception: spaces-harness-pi-sdk is NOT forbidden here. The
  // broker owns its own driver plane, and this omission is intentional rather
  // than an oversight — 'spaces-harness-pi' is exact-or-slash and does not reach
  // 'spaces-harness-pi-sdk', so without this note the exception would be silent.
  // Ratified permitted-not-compelled (primary #20151): spaces-runtime-contracts
  // stays importable here, but nothing compels its use.
  {
    name: 'Harness Broker',
    roots: ['harness/harness-broker/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'spaces-aspc-facade',
      'spaces-turn-runner',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // HARNESS seam: the broker's pi-sdk driver. Matched by no layer before
  // T-07317, so it escaped even the broad ASP prohibitions. Its real
  // dependencies — spaces-harness-broker and spaces-harness-broker-protocol —
  // stay permitted; every compiler-side package is forbidden.
  {
    name: 'Harness Broker Pi SDK',
    roots: ['harness/harness-broker-pi-sdk/src'],
    forbidden: [
      'agent-scope',
      'cli-kit',
      'spaces-config',
      'spaces-runtime',
      'spaces-execution',
      'spaces-harness-claude',
      'spaces-harness-codex',
      'spaces-harness-pi',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc-protocol',
      'spaces-aspc',
      'spaces-aspc-facade',
      'spaces-turn-runner',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // COMPILER seam (future `aspc` repo). The compiler plane owns mechanics only,
  // so post carve-out it must not reach the SDK/session plane, nor anything
  // downstream of itself (turn-runner, the aspc facade, the CLI).
  // Tokens are enumerated rather than written as a 'spaces-harness-' prefix,
  // because a prefix would swallow deliberate, named exceptions. Temporary
  // root-layer exemption (removal owner: T-07526): compiler/agent-spaces may
  // import drivers/execution (10 imports across 9 files) and
  // drivers/harness-codex (3 imports). This is the pre-existing T-07317
  // "accepted residual" made visible, not a new violation.
  //   - spaces-harness-codex: `buildCodexAppServerLaunchDescriptor` is a
  //     declarative compile-plane descriptor builder, not an SDK/session import.
  //   - spaces-harness-broker-protocol and spaces-harness-broker-client: these
  //     edges are retained deliberately — T-07314 AC-1 asserts they REMAIN
  //     after the aspc facade split, so forbidding them would break landed work.
  // 'spaces-harness-broker' is exact-or-slash, which is what leaves those two
  // permitted while still forbidding the broker itself.
  // Accepted residual: this is a DIRECT-import guard only. The chain
  // agent-spaces -> spaces-execution -> spaces-harness-pi-sdk/pi-session still
  // leaks the SDK transitively; removing the spaces-execution edge is a refactor
  // and is out of scope here.
  {
    name: 'ASPC Compiler',
    roots: ['compiler/agent-spaces/src', 'compiler/aspc/src'],
    forbidden: [
      'spaces-harness-claude',
      'spaces-harness-pi',
      'spaces-harness-pi-sdk',
      'spaces-harness-broker',
      'spaces-harness-broker-pi-sdk',
      'spaces-turn-runner',
      'spaces-aspc-facade',
      '@lherron/agent-spaces',
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'ASP',
    roots: [...aspPackages, 'integration-tests'],
    forbidden: ['hrc-', 'acp-', 'gateway-', 'coordination-substrate', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC',
    roots: hrcPackages.map((name) => `packages/${name}`),
    forbidden: [
      'acp-',
      'gateway-discord',
      'gateway-ios',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
]

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
