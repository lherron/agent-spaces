import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const WORKSPACE_ROOTS = ['contracts', 'core', 'drivers', 'compiler', 'harness', 'apps']

export interface WorkspacePackage {
  name: string
  relativePath: string
  absolutePath: string
  internalDependencies: string[]
  scripts: Record<string, string>
}

interface PackageManifest {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function normalized(path: string): string {
  return path.split(sep).join('/')
}

export async function discoverWorkspacePackages(root: string): Promise<WorkspacePackage[]> {
  const manifests: Array<{
    name: string
    absolutePath: string
    relativePath: string
    manifest: PackageManifest
  }> = []

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const absoluteRoot = join(root, workspaceRoot)
    const entries = await readdir(absoluteRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const absolutePath = join(absoluteRoot, entry.name)
      const manifest = JSON.parse(
        await readFile(join(absolutePath, 'package.json'), 'utf8')
      ) as PackageManifest
      if (!manifest.name) continue
      manifests.push({
        name: manifest.name,
        absolutePath,
        relativePath: normalized(relative(root, absolutePath)),
        manifest,
      })
    }
  }

  const workspaceNames = new Set(manifests.map(({ name }) => name))
  return manifests
    .map(({ name, absolutePath, relativePath, manifest }) => {
      const dependencyNames = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      })
      return {
        name,
        relativePath,
        absolutePath,
        internalDependencies: dependencyNames.filter((name) => workspaceNames.has(name)).sort(),
        scripts: manifest.scripts ?? {},
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function topologicalWorkspaceLayers(packages: WorkspacePackage[]): WorkspacePackage[][] {
  const byName = new Map(packages.map((workspace) => [workspace.name, workspace]))
  const remaining = new Map(
    packages.map((workspace) => [
      workspace.name,
      new Set(workspace.internalDependencies.filter((name) => byName.has(name))),
    ])
  )
  const layers: WorkspacePackage[][] = []

  while (remaining.size > 0) {
    const readyNames = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort()
    if (readyNames.length === 0) {
      throw new Error(`Workspace dependency cycle: ${[...remaining.keys()].sort().join(', ')}`)
    }
    layers.push(
      readyNames.map((name) => {
        const workspace = byName.get(name)
        if (!workspace) throw new Error(`Missing workspace ${name}`)
        return workspace
      })
    )
    for (const name of readyNames) remaining.delete(name)
    for (const dependencies of remaining.values()) {
      for (const name of readyNames) dependencies.delete(name)
    }
  }

  return layers
}

export function reverseDependencyClosure(
  packages: WorkspacePackage[],
  seeds: Iterable<string>
): Set<string> {
  const selected = new Set(seeds)
  let changed = true
  while (changed) {
    changed = false
    for (const workspace of packages) {
      if (selected.has(workspace.name)) continue
      if (!workspace.internalDependencies.some((dependency) => selected.has(dependency))) continue
      selected.add(workspace.name)
      changed = true
    }
  }
  return selected
}

export function workspaceForPath(
  packages: WorkspacePackage[],
  path: string
): WorkspacePackage | undefined {
  const normalizedPath = normalized(path)
  return packages.find(
    (workspace) =>
      normalizedPath === workspace.relativePath ||
      normalizedPath.startsWith(`${workspace.relativePath}/`)
  )
}
