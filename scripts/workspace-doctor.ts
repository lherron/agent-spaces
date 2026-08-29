/**
 * Workspace doctor: prune nested node_modules copies of pinned dependencies.
 *
 * `bun install` writes; it does not tidy. When a manifest once declared a governed
 * dependency with a floating specifier, bun materialised a NESTED
 * `<package>/node_modules/<dep>` copy at whatever that specifier resolved to.
 * Correcting the specifier does NOT remove that directory: the lockfile now records
 * one resolution, `bun install --frozen-lockfile` reports "no changes", and the
 * stale copy stays on disk — where TypeScript's nearest-node_modules resolution keeps
 * preferring it over the root. That is the shape that made `bun run build` red on a
 * clean tree while every manifest and the lockfile looked correct (T-07690).
 *
 * Governed set is the root package.json `overrides` pin table, the same table
 * scripts/check-dependency-pins.ts enforces: an exact pin there means the workspace
 * resolves that dependency to exactly one version, so a nested copy at a DIFFERENT
 * version can only be a stale artifact and is safe to remove. A nested copy at the
 * SAME version shadows nothing and is left alone. Ungoverned dependencies are never
 * touched — bun nests those deliberately to satisfy genuinely conflicting ranges.
 *
 * `--check` reports without deleting, for use in a gate. `--root <dir>` points the
 * sweep at another tree, which is how the tests drive it over a fixture.
 */
import { readFile, readdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

function parseRoot(argv: string[]): string {
  const flag = argv.indexOf('--root')
  if (flag === -1) {
    return resolve(import.meta.dir, '..')
  }

  const value = argv[flag + 1]
  if (!value) {
    throw new Error('--root requires a directory')
  }
  return resolve(value)
}

const repoRoot = parseRoot(process.argv)
const skippedDirectories = new Set(['.git', 'coverage', 'dist', 'tmp'])
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/

type PackageJson = { overrides?: unknown; version?: unknown }

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

async function readVersion(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(packageDir, 'package.json'), 'utf8')
    ) as PackageJson
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Root `overrides` entries naming one exact version — the governed set. */
async function governedDependencies(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as PackageJson
  return Object.entries(asRecord(manifest.overrides))
    .filter(([, specifier]) => typeof specifier === 'string' && exactVersion.test(specifier))
    .map(([dependency]) => dependency)
    .sort()
}

/**
 * Every `node_modules/<dependency>` directory in the tree EXCEPT the root's own.
 * The walk descends through node_modules as well, so a copy nested inside another
 * package's install (`node_modules/x/node_modules/<dependency>`) is found too.
 */
async function nestedCopies(dependency: string): Promise<string[]> {
  const rootCopy = join(repoRoot, 'node_modules', dependency)
  const found: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || skippedDirectories.has(entry.name)) {
        continue
      }

      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') {
        const candidate = join(path, dependency)
        if (candidate !== rootCopy && (await readVersion(candidate)) !== undefined) {
          found.push(candidate)
        }
      }

      await walk(path)
    }
  }

  await walk(repoRoot)
  return found.sort()
}

const checkOnly = process.argv.includes('--check')
const dependencies = await governedDependencies()
let staleCount = 0

for (const dependency of dependencies) {
  const rootVersion = await readVersion(join(repoRoot, 'node_modules', dependency))
  for (const copy of await nestedCopies(dependency)) {
    const version = await readVersion(copy)
    const where = relative(repoRoot, copy)

    if (rootVersion === undefined) {
      console.warn(`[doctor] ${where}@${version}: no root resolution to compare against; kept`)
      continue
    }
    if (version === rootVersion) {
      continue
    }

    staleCount += 1
    console.log(`[doctor] ${where}@${version} shadows root ${dependency}@${rootVersion}`)
    if (!checkOnly) {
      await rm(copy, { recursive: true, force: true })
    }
  }
}

if (staleCount === 0) {
  console.log(
    `Workspace doctor: no stale nested copies of ${dependencies.length} pinned dependencies.`
  )
  process.exit(0)
}

if (checkOnly) {
  console.error(
    `Workspace doctor: ${staleCount} stale nested copy(ies) shadow the root resolution. Run \`just doctor\` to prune them.`
  )
  process.exit(1)
}

console.log(`Workspace doctor: pruned ${staleCount} stale nested copy(ies).`)
