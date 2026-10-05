/**
 * Material package fingerprints: a content hash of a packed package that
 * ignores the fields every publish wave regenerates (version, praesidiumBuild,
 * internal ASP dependency pins), so an unchanged package fingerprints the same
 * across waves.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DEPENDENCY_FIELDS, type PackageManifest } from './package-set'

const INTERNAL_ASP_DEPENDENCY_SPEC = '<asp-internal-package>'

type FingerprintInput = {
  manifest: PackageManifest
  files: Record<string, string>
  internalPackageNames: string[]
}

/** JSON with sorted object keys and undefined members dropped. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`
}

function normalizeInternalDependencySpecs(
  deps: Record<string, string> | undefined,
  internalPackageNames: Set<string>
): Record<string, string> | undefined {
  if (!deps) return undefined

  const next: Record<string, string> = {}
  for (const [name, spec] of Object.entries(deps)) {
    next[name] = internalPackageNames.has(name) ? INTERNAL_ASP_DEPENDENCY_SPEC : spec
  }
  return next
}

function normalizeManifestForFingerprint(
  manifest: PackageManifest,
  internalPackageNames: Set<string>
): Record<string, unknown> {
  const {
    version: _version,
    praesidiumBuild: _praesidiumBuild,
    ...manifestWithoutGeneratedPublicationFields
  } = manifest
  const normalized: Record<string, unknown> = {
    ...manifestWithoutGeneratedPublicationFields,
  }
  for (const field of DEPENDENCY_FIELDS) {
    normalized[field] = normalizeInternalDependencySpecs(manifest[field], internalPackageNames)
  }
  return normalized
}

export function materialPackageFingerprint(input: FingerprintInput): string {
  const internalPackageNames = new Set(input.internalPackageNames)
  const payload = {
    manifest: normalizeManifestForFingerprint(input.manifest, internalPackageNames),
    files: input.files,
  }
  return createHash('sha256').update(stableJson(payload)).digest('hex')
}

async function collectPackedFiles(packageDir: string, base = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const entries = await readdir(join(packageDir, base), { withFileTypes: true })

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      Object.assign(files, await collectPackedFiles(packageDir, rel))
    } else if (entry.isFile() && rel !== 'package.json') {
      const content = await readFile(join(packageDir, rel))
      files[rel] = createHash('sha256').update(content).digest('hex')
    }
  }

  return files
}

/** Fingerprint an extracted tarball's `package/` directory. */
export async function extractedPackageFingerprint(
  packageDir: string,
  internalPackageNames: string[]
): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(packageDir, 'package.json'), 'utf8')
  ) as PackageManifest
  const files = await collectPackedFiles(packageDir)
  return materialPackageFingerprint({ manifest, files, internalPackageNames })
}
