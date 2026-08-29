import { readFile, readdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, relative } from 'node:path'
import ts from 'typescript'
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

const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp'])
const workspaceRoots = ['contracts', 'core', 'drivers', 'compiler', 'harness', 'apps']

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

/**
 * Reads a directory's package.json, treating an ABSENT manifest as "not a
 * workspace package" rather than an error. A `<root>/<name>/` directory can
 * legitimately exist without a manifest — most often mid-split, when a new
 * package's tests land before its manifest does — and bun's own `<root>/*`
 * workspace globs skip such directories too. Only ENOENT is tolerated:
 * malformed JSON still throws, so a broken manifest can never be silently
 * dropped from the edge check.
 */
async function readManifest(dir: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function readPackageInfo(dir: string): Promise<PackageInfo | undefined> {
  const packageJson = await readManifest(dir)
  if (packageJson === undefined || typeof packageJson.name !== 'string') {
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
  for (const workspaceRoot of workspaceRoots) {
    const packageRootEntries = await readdir(workspaceRoot, { withFileTypes: true })

    for (const entry of packageRootEntries) {
      if (!entry.isDirectory()) {
        continue
      }

      const info = await readPackageInfo(join(workspaceRoot, entry.name))
      if (info) {
        packages.push(info)
      }
    }
  }

  const integrationInfo = await readPackageInfo('integration-tests')
  if (integrationInfo) {
    packages.push(integrationInfo)
  }

  return packages.sort((left, right) => left.dir.localeCompare(right.dir))
}

async function collectSourceFiles(packageDir: string): Promise<string[]> {
  if (!(await pathExists(packageDir))) {
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

      if (
        entry.isFile() &&
        /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(path)
      }
    }
  }

  await walk(packageDir)
  return files.sort()
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return undefined
  }

  // Runtime-provided specifiers are never manifest edges: `node:`/`bun:` prefixed
  // builtins, and the bare builtin names both runtimes expose (isBuiltin covers
  // `bun` itself when this guard runs under bun).
  if (specifier.startsWith('node:') || specifier.startsWith('bun:') || isBuiltin(specifier)) {
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

async function importedPackages(packageInfo: PackageInfo): Promise<Map<string, ImportLocation[]>> {
  const imports = new Map<string, ImportLocation[]>()
  const files = await collectSourceFiles(packageInfo.dir)

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    // Scan with the TypeScript preprocessor rather than a regex. Once this guard
    // checks EVERY bare specifier (not just workspace names), a regex is no longer
    // viable: it matches quoted text that merely looks like an import — a template
    // literal holding a script for another runtime, an option string containing
    // `from '...'` — and reports it as a missing dependency. The preprocessor sees
    // only real module references, and it sees all of them: type-only imports,
    // side-effect imports, `export ... from`, dynamic `import()`, and `require()`.
    for (const reference of ts.preProcessFile(content, true, true).importedFiles) {
      const packageName = barePackageName(reference.fileName)
      if (!packageName || packageName === packageInfo.name) {
        continue
      }

      const importLocations = imports.get(packageName) ?? []
      importLocations.push({
        file: relative(process.cwd(), file),
        line: lineNumberForIndex(content, reference.pos),
      })
      imports.set(packageName, importLocations)
    }
  }

  return imports
}

async function missingManifestEdges(): Promise<MissingEdge[]> {
  const packages = await workspacePackages()
  const missingEdges: MissingEdge[] = []

  for (const packageInfo of packages) {
    const imports = await importedPackages(packageInfo)
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
      ruleId: 'MANIFEST:missing-dependency',
      expected: `every imported package is declared in ${edge.packageDir}/package.json dependencies`,
      got: `source imports '${edge.dependency}' without a manifest edge`,
      fix: `add '${edge.dependency}' to ${edge.packageDir}/package.json dependencies (autofix: \`cd ${edge.packageDir} && bun add ${edge.dependency}\`)`,
      why: 'undeclared dependencies break isolated installs and hide the real package edge from tooling; a hoisted layout resolves them from a sibling that happens to declare them, so they only fail elsewhere.',
      exception:
        'declaring the dependency is the fix; if it truly should not be declared, edit this rule via reviewed change with rationale.',
      doNotSuppress: 'Do not suppress, silence, disable, or re-export to hide this; fix the edge.',
    }))
  )
}

const guard = defineGuard({
  surface: {
    dirs: [...workspaceRoots, 'integration-tests'],
    ignore: ['.git', 'coverage', 'dist', 'node_modules', 'tmp'],
  },
  rules: [
    {
      id: 'MANIFEST:missing-dependency',
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
