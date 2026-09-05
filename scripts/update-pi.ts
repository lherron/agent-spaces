/**
 * Bump the pinned pi agent SDK across every workspace manifest that declares it.
 *
 * `@earendil-works/pi-coding-agent`, and every companion package below it, is
 * exact-pinned (not caret-ranged) in five manifests: the pi-sdk driver, the two
 * agent-harness packages, the pi-sdk broker and integration-tests. An exact pin is deliberate — a floating specifier lets bun
 * resolve one member differently from the rest and materialise a NESTED
 * node_modules copy that shadows the root for TypeScript, which is the failure shape
 * scripts/check-dependency-pins.ts exists to prevent (T-07690). The cost of that
 * safety is that a version bump is a five-file edit that has to stay in agreement,
 * so it is scripted rather than done by hand.
 *
 * With no version argument the target is the registry's `latest` dist-tag. Pass an
 * explicit version to move to a specific release (including downgrades — the script
 * does not require the target to be newer, so a bad bump can be reverted with the
 * same command). `--check` reports the drift and exits non-zero without writing,
 * which is what a gate would call; `--no-install` edits the manifests but leaves
 * `bun install` to the caller.
 *
 * Manifests are edited as TEXT, not reserialised JSON: rewriting the parsed object
 * would reformat unrelated keys and bury the one-line version change in diff noise.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const packageName = '@earendil-works/pi-coding-agent'
/**
 * Companion packages that are pinned to the SAME version as the SDK itself.
 *
 * `@earendil-works/pi-server` is not something this workspace imports. Upstream
 * 0.85.0 ships `dist/experimental/server.js` — reachable from the package root via
 * `index.js -> main.js` — importing `@earendil-works/pi-server` without declaring it,
 * so `import '@earendil-works/pi-coding-agent'` throws MODULE_NOT_FOUND on an
 * otherwise clean install. Declaring the missing package ourselves repairs the
 * resolution, and it lives here rather than in a hand-edited manifest because a
 * repair pinned outside this script is a pin that drifts on the next bump.
 */
const companionPackages = ['@earendil-works/pi-server']
const governedPackages = [packageName, ...companionPackages]
const repoRoot = resolve(import.meta.dir, '..')
const surfaceDirs = [
  'contracts',
  'core',
  'drivers',
  'compiler',
  'harness',
  'apps',
  'integration-tests',
]
const skippedDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp'])
const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/

/** Sections whose specifier this workspace actually resolves. A peerDependencies
 *  range is a compatibility statement about the consumer's tree, not a resolution
 *  here, so it is left alone for the same reason the pin guard ignores it. */
const governedSections = ['dependencies', 'devDependencies', 'overrides'] as const

type Declaration = { manifest: string; section: string; dependency: string; specifier: string }

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

async function manifestPaths(): Promise<string[]> {
  const found = ['package.json']
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(join(repoRoot, dir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
        await walk(join(dir, entry.name))
      } else if (entry.isFile() && entry.name === 'package.json') {
        found.push(join(dir, entry.name))
      }
    }
  }
  for (const dir of surfaceDirs) {
    await walk(dir)
  }
  return found.sort()
}

async function declarations(): Promise<Declaration[]> {
  const declared: Declaration[] = []
  for (const manifest of await manifestPaths()) {
    const parsed = JSON.parse(await readFile(join(repoRoot, manifest), 'utf8')) as Record<
      string,
      unknown
    >
    for (const section of governedSections) {
      for (const dependency of governedPackages) {
        const specifier = asRecord(parsed[section])[dependency]
        if (typeof specifier === 'string') {
          declared.push({ manifest, section, dependency, specifier })
        }
      }
    }
  }
  return declared
}

async function latestVersion(): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`)
  if (!response.ok) {
    throw new Error(`registry lookup failed: ${response.status} ${response.statusText}`)
  }
  const version = (await response.json()) as { version?: unknown }
  if (typeof version.version !== 'string') {
    throw new Error('registry returned no version for the latest dist-tag')
  }
  return version.version
}

/** Replace only this package's specifier, leaving every other byte of the manifest
 *  untouched so the diff is one line per file. */
function rewrite(content: string, target: string): string {
  let rewritten = content
  for (const dependency of governedPackages) {
    const declaration = new RegExp(
      `("${dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*")[^"]*(")`,
      'g'
    )
    rewritten = rewritten.replace(declaration, `$1${target}$2`)
  }
  return rewritten
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const install = !argv.includes('--no-install')
  const requested = argv.find((arg) => !arg.startsWith('--'))

  if (requested && !exactVersion.test(requested)) {
    console.error(
      `[update-pi] "${requested}" is not an exact version; the pin table holds no ranges`
    )
    return 1
  }

  const target = requested ?? (await latestVersion())
  const declared = await declarations()
  if (declared.length === 0) {
    console.error(`[update-pi] no manifest declares ${packageName}; nothing to bump`)
    return 1
  }

  const drifted = declared.filter((entry) => entry.specifier !== target)
  console.log(`[update-pi] ${packageName} -> ${target}${requested ? '' : ' (latest)'}`)
  for (const entry of declared) {
    const state = entry.specifier === target ? 'ok' : `${entry.specifier} ->`
    console.log(`  ${state.padEnd(12)} ${entry.manifest} (${entry.section}) ${entry.dependency}`)
  }

  if (drifted.length === 0) {
    console.log('[update-pi] every declaration already at target')
    return 0
  }

  if (check) {
    console.error(`[update-pi] --check: ${drifted.length} declaration(s) off target`)
    return 1
  }

  for (const manifest of new Set(drifted.map((entry) => entry.manifest))) {
    const path = join(repoRoot, manifest)
    await writeFile(path, rewrite(await readFile(path, 'utf8'), target))
  }
  console.log(`[update-pi] rewrote ${new Set(drifted.map((e) => e.manifest)).size} manifest(s)`)

  if (!install) {
    console.log('[update-pi] --no-install: run `bun install` to materialise the new resolution')
    return 0
  }

  const installed = Bun.spawnSync(['bun', 'install'], {
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (installed.exitCode !== 0) {
    console.error(
      '[update-pi] bun install failed; manifests are edited but the tree is not resolved'
    )
    return installed.exitCode ?? 1
  }

  // Readback against the real tree: a manifest edit plus a green install still leaves
  // the old copy on disk when a stale nested resolution shadows the root (T-07690),
  // so the claim "pi is at <target>" is only true if the resolved module says so.
  for (const dependency of governedPackages) {
    const resolved = join(repoRoot, 'node_modules', dependency, 'package.json')
    const onDisk = JSON.parse(await readFile(resolved, 'utf8')) as { version?: unknown }
    if (onDisk.version !== target) {
      console.error(
        `[update-pi] ${relative(repoRoot, resolved)} is ${String(onDisk.version)}, not ${target}; run \`just doctor\``
      )
      return 1
    }
  }

  // A version readback only proves WHICH copy is on disk, not that it LOADS: 0.85.0
  // resolved cleanly while every root import of it threw MODULE_NOT_FOUND on an
  // undeclared transitive. Import the package for real before reporting the bump green.
  const imported = Bun.spawnSync(['bun', '-e', `await import(${JSON.stringify(packageName)})`], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (imported.exitCode !== 0) {
    console.error(`[update-pi] ${packageName}@${target} resolved but does not import:`)
    console.error(new TextDecoder().decode(imported.stderr).trim())
    return 1
  }

  console.log(
    `[update-pi] resolved and imported ${packageName}@${target}; run \`just verify\` before committing`
  )
  return 0
}

process.exit(await main())
