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
  'agent-scope',
  'cli-kit',
  'config',
  'runtime',
  'execution',
  'harness-claude',
  'harness-codex',
  'harness-pi',
  'harness-pi-sdk',
  'harness-broker-protocol',
  'spaces-runtime-contracts',
  'aspc-protocol',
  'harness-broker-client',
  'agent-spaces',
  'aspc',
  'cli',
]

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
  {
    name: 'Harness Broker Protocol',
    roots: ['packages/harness-broker-protocol/src'],
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
      'hrc-',
      'acp-',
      'gateway-',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  {
    name: 'Runtime Contracts',
    roots: ['packages/spaces-runtime-contracts/src'],
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
  {
    name: 'ASPC Protocol',
    roots: ['packages/aspc-protocol/src'],
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
      'spaces-harness-broker',
      'agent-spaces',
      '@lherron/agent-spaces',
      'spaces-aspc',
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
    roots: ['packages/harness-broker-client/src'],
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
  {
    name: 'Harness Broker',
    roots: ['packages/harness-broker/src'],
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
    roots: [...aspPackages.map((name) => `packages/${name}`), 'integration-tests'],
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
  if (parts[0] === 'packages' && parts[1]) {
    return `packages/${parts[1]}`
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
  const packagesDir = join(repoRoot, 'packages')
  let entries: Dirent[]
  try {
    entries = await readdir(packagesDir, { withFileTypes: true })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return packageNames
    }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const packageDir = `packages/${entry.name}`
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
  roots = ['packages', 'integration-tests']
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
