/**
 * Pack one workspace package for publication: copy it to a staging dir, write
 * the publish manifest there, `bun pm pack` the copy, and validate the tarball
 * before anything reaches the registry. The checkout is only ever read: other
 * seats share it, and a killed pack must not leave tracked files rewritten.
 */

import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from './command'
import { extractedPackageFingerprint } from './fingerprint'
import { PUBLIC_CLI_PACKAGE, type PackageManifest, REPO_ROOT } from './package-set'
import { PRAESIDIUM_BUILD_FIELDS, type SourceProof, praesidiumBuildFor } from './provenance'
import { extractTarball } from './tarball'

/** What every package in one publication shares. */
export type PublicationContext = {
  versionsByName: Map<string, string>
  source: SourceProof
  builtAt: string
}

export type PackedPackage = {
  name: string
  version: string
  tarballPath: string
  tmp: string
  fingerprint: string
}

function stripBunConditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBunConditions)
  if (!value || typeof value !== 'object') return value

  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'bun') continue
    next[key] = stripBunConditions(child)
  }
  return next
}

function findBunConditions(value: unknown, path = 'exports'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => findBunConditions(child, `${path}[${index}]`))
  }
  if (!value || typeof value !== 'object') return []

  const offenders: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`
    if (key === 'bun') offenders.push(childPath)
    offenders.push(...findBunConditions(child, childPath))
  }
  return offenders
}

function exportedFilePaths(value: unknown): string[] {
  if (typeof value === 'string' && value.startsWith('./') && !value.includes('*')) {
    return [value]
  }
  if (Array.isArray(value)) return value.flatMap(exportedFilePaths)
  if (!value || typeof value !== 'object') return []

  return Object.values(value as Record<string, unknown>).flatMap(exportedFilePaths)
}

// WHY: `bin` was the one manifest surface this packer never checked, so a bin
// excluded from `files` shipped a binary that cannot start.
// NOTE the limit: this asserts the bin entry itself is packaged, NOT that what
// the bin imports is packaged. The bug that motivated it (a shipped bin
// importing unshipped ../src) passes this check. Only installing the tarball
// outside the monorepo and starting the binary catches that.
function binFilePaths(value: PackageManifest['bin']): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []

  return Object.values(value)
}

async function assertPackagedFile(packageDir: string, path: string, name: string): Promise<void> {
  const normalized = path.replace(/^\.\//, '')
  try {
    await access(join(packageDir, normalized))
  } catch {
    throw new Error(`${name} tarball references missing file: ${path}`)
  }
}

function pinInternalDependencies(
  deps: Record<string, string> | undefined,
  versionsByName: Map<string, string>
): Record<string, string> | undefined {
  if (!deps) return undefined

  let changed = false
  const next: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    const version = versionsByName.get(name)
    if (version) {
      next[name] = version
      changed = true
    } else {
      next[name] = spec
    }
  }
  return changed ? next : deps
}

/** The manifest the staged copy's package.json carries. */
function publishManifest(manifest: PackageManifest, version: string, context: PublicationContext) {
  const { private: _private, ...manifestWithoutPrivate } = manifest
  const { versionsByName } = context
  return {
    ...manifestWithoutPrivate,
    version,
    praesidiumBuild: praesidiumBuildFor(context.source, version, context.builtAt),
    dependencies: pinInternalDependencies(manifest.dependencies, versionsByName),
    devDependencies: pinInternalDependencies(manifest.devDependencies, versionsByName),
    peerDependencies: pinInternalDependencies(manifest.peerDependencies, versionsByName),
    optionalDependencies: pinInternalDependencies(manifest.optionalDependencies, versionsByName),
    exports: stripBunConditions(manifest.exports),
  }
}

/** Refuse a tarball whose manifest would not install or would lie about its build. */
async function assertPublishableTarball(packageDir: string, name: string): Promise<void> {
  const staged = JSON.parse(
    await readFile(join(packageDir, 'package.json'), 'utf8')
  ) as PackageManifest
  const offenders = findBunConditions(staged.exports)
  if (offenders.length > 0) {
    throw new Error(`${name} tarball retains bun export conditions: ${offenders.join(', ')}`)
  }
  if (staged.private) {
    throw new Error(`${name} tarball still has private=true`)
  }
  if (
    !staged.praesidiumBuild ||
    JSON.stringify(Object.keys(staged.praesidiumBuild)) !== JSON.stringify(PRAESIDIUM_BUILD_FIELDS)
  ) {
    throw new Error(`${name} tarball does not carry the exact normative praesidiumBuild tuple`)
  }
  const referencedFiles = [
    staged.main,
    staged.types,
    ...binFilePaths(staged.bin),
    ...exportedFilePaths(staged.exports),
  ].filter((path): path is string => Boolean(path))
  for (const path of new Set(referencedFiles)) {
    await assertPackagedFile(packageDir, path, name)
  }
}

/**
 * Copy a package dir into stageDir, minus its node_modules (symlinks into the
 * workspace; the CLI's bundled copies are rebuilt by its prepack) and the
 * prepack backup.
 */
async function stagePackage(pkgDir: string, stageDir: string): Promise<void> {
  const skipped = new Set(['node_modules', '.asp-prepack-backup'].map((dir) => join(pkgDir, dir)))
  await cp(pkgDir, stageDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !skipped.has(source),
  })
}

export async function packForPublish(
  rel: string,
  context: PublicationContext
): Promise<PackedPackage> {
  const pkgDir = join(REPO_ROOT, rel)
  const manifest = JSON.parse(
    await readFile(join(pkgDir, 'package.json'), 'utf8')
  ) as PackageManifest
  if (!manifest.name || !manifest.version) {
    throw new Error(`${rel}/package.json must include name and version`)
  }
  const packagePublishVersion = context.versionsByName.get(manifest.name)
  if (!packagePublishVersion) {
    throw new Error(`no publish version resolved for ${manifest.name}`)
  }

  const tmp = await mkdtemp(join(tmpdir(), 'asp-publish-'))
  try {
    const stageDir = join(tmp, 'stage')
    await stagePackage(pkgDir, stageDir)
    await writeFile(
      join(stageDir, 'package.json'),
      `${JSON.stringify(publishManifest(manifest, packagePublishVersion, context), null, 2)}\n`
    )

    if (rel === PUBLIC_CLI_PACKAGE) {
      // The public CLI's package is self-contained. Its prepack copies and
      // rewrites workspace dependencies under the staged node_modules;
      // --ignore-scripts intentionally prevents npm/bun from doing this
      // implicitly (in place).
      const prepack = run('bun', ['scripts/prepack.ts', '--into', stageDir], pkgDir)
      if (prepack.status !== 0) {
        throw new Error(`prepack failed for ${manifest.name}: ${prepack.out}`)
      }
    }

    const pack = run('bun', ['pm', 'pack', '--destination', tmp, '--ignore-scripts'], stageDir)
    if (pack.status !== 0) {
      throw new Error(`bun pm pack failed for ${manifest.name}: ${pack.out}`)
    }

    const entries = await readdir(tmp)
    const tarball = entries.find((entry) => entry.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`bun pm pack produced no tarball for ${manifest.name}`)
    }

    const tarballPath = join(tmp, tarball)
    const extractedPackageDir = extractTarball(tarballPath, join(tmp, 'extract'), manifest.name)
    await assertPublishableTarball(extractedPackageDir, manifest.name)

    return {
      name: manifest.name,
      version: packagePublishVersion,
      tarballPath,
      tmp,
      fingerprint: await extractedPackageFingerprint(extractedPackageDir, [
        ...context.versionsByName.keys(),
      ]),
    }
  } catch (error) {
    await rm(tmp, { recursive: true, force: true })
    throw error
  }
}
