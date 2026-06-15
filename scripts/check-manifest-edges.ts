import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { defineGuard, runGuard } from './lib/boundary-guard/engine.ts'
import type { GuardDiagnostic } from './lib/boundary-guard/engine.ts'

type PackageInfo = {
  dir: string
  name: string
  declared: Set<string>
}

type MissingEdge = {
  packageDir: string
  packageName: string
  dependency: string
  locations: ImportLocation[]
}

type ImportLocation = {
  file: string
  line: number
}

type PackageJson = {
  name?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  peerDependencies?: unknown
}

const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp'])

async function pathExists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

async function readPackageInfo(dir: string): Promise<PackageInfo | undefined> {
  const packageJson = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson
  if (typeof packageJson.name !== 'string') {
    return undefined
  }

  const declared = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    for (const dependency of Object.keys(asRecord(packageJson[field]))) {
      declared.add(dependency)
    }
  }

  return {
    dir,
    name: packageJson.name,
    declared,
  }
}

async function workspacePackages(): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = []
  const packageRootEntries = await readdir('packages', { withFileTypes: true })

  for (const entry of packageRootEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    const info = await readPackageInfo(join('packages', entry.name))
    if (info) {
      packages.push(info)
    }
  }

  const integrationInfo = await readPackageInfo('integration-tests')
  if (integrationInfo) {
    packages.push(integrationInfo)
  }

  return packages.sort((left, right) => left.dir.localeCompare(right.dir))
}

async function collectSourceFiles(srcDir: string): Promise<string[]> {
  if (!(await pathExists(srcDir))) {
    return []
  }

  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
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

  await walk(srcDir)
  return files.sort()
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined
  }

  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    const scope = parts[0]
    const name = parts[1]
    return scope && name ? `${scope}/${name}` : undefined
  }

  return parts[0]
}

function lineNumberForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

async function importedWorkspacePackages(
  packageInfo: PackageInfo,
  workspaceNames: Set<string>
): Promise<Map<string, ImportLocation[]>> {
  const imports = new Map<string, ImportLocation[]>()
  const files = await collectSourceFiles(join(packageInfo.dir, 'src'))

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      const packageName = barePackageName(specifier)
      if (!packageName || packageName === packageInfo.name || !workspaceNames.has(packageName)) {
        continue
      }

      const importLocations = imports.get(packageName) ?? []
      importLocations.push({
        file: relative(process.cwd(), file),
        line: lineNumberForIndex(content, match.index),
      })
      imports.set(packageName, importLocations)
    }
  }

  return imports
}

async function missingManifestEdges(): Promise<MissingEdge[]> {
  const packages = await workspacePackages()
  const workspaceNames = new Set(packages.map((packageInfo) => packageInfo.name))
  const missingEdges: MissingEdge[] = []

  for (const packageInfo of packages) {
    const imports = await importedWorkspacePackages(packageInfo, workspaceNames)
    for (const [dependency, locations] of imports) {
      if (!packageInfo.declared.has(dependency)) {
        missingEdges.push({
          packageDir: packageInfo.dir,
          packageName: packageInfo.name,
          dependency,
          locations: locations.sort(
            (left, right) => left.file.localeCompare(right.file) || left.line - right.line
          ),
        })
      }
    }
  }

  return missingEdges.sort(
    (left, right) =>
      left.packageDir.localeCompare(right.packageDir) ||
      left.packageName.localeCompare(right.packageName) ||
      left.dependency.localeCompare(right.dependency)
  )
}

async function detectMissingManifestEdges(): Promise<GuardDiagnostic[]> {
  const edges = await missingManifestEdges()

  return edges.flatMap((edge) =>
    edge.locations.map((location) => ({
      location,
      ruleId: 'MANIFEST:missing-workspace-dependency',
      expected: `every imported workspace package is declared in ${edge.packageDir}/package.json dependencies`,
      got: `source imports '${edge.dependency}' without a manifest edge`,
      fix: `add '${edge.dependency}' to ${edge.packageDir}/package.json dependencies (autofix: \`cd ${edge.packageDir} && bun add ${edge.dependency}\`)`,
      why: 'undeclared workspace dependencies break isolated installs and hide the real package edge from tooling.',
      exception:
        'declaring the dependency is the fix; if it truly should not be declared, edit this rule via reviewed change with rationale.',
      doNotSuppress: 'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
    }))
  )
}

const guard = defineGuard({
  surface: {
    dirs: ['packages', 'integration-tests'],
    ignore: ['.git', 'coverage', 'dist', 'node_modules', 'tmp'],
  },
  rules: [
    {
      id: 'MANIFEST:missing-workspace-dependency',
      kind: 'custom',
      detect: detectMissingManifestEdges,
    },
  ],
})

const exitCode = await runGuard(guard)

if (exitCode === 0) {
  console.log('Manifest edge check passed.')
}

process.exit(exitCode)
