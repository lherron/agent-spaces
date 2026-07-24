import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://mini:4873/'

const PUBLIC_CLI_PACKAGE = 'packages/cli'

const DEV_PUBLISH_PACKAGES = [
  'packages/agent-scope',
  'packages/cli-kit',
  'packages/config',
  'packages/runtime',
  'packages/execution',
  'packages/harness-broker-protocol',
  'packages/harness-broker-client',
  'packages/harness-broker',
  'packages/spaces-runtime-contracts',
  'packages/aspc-protocol',
  'packages/harness-claude',
  'packages/harness-codex',
  'packages/harness-pi',
  'packages/harness-pi-sdk',
  'packages/agent-spaces',
  'packages/aspc',
] as const

export const RELEASE_PUBLISH_PACKAGES = [
  ...DEV_PUBLISH_PACKAGES,
  // Keep the public CLI last: its prepack bundles the already-built workspace
  // packages into the installable @lherron/agent-spaces artifact.
  PUBLIC_CLI_PACKAGE,
] as const

type Manifest = {
  name?: string
  version?: string
  private?: boolean
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

let publishVersionsByName = new Map<string, string>()
let publishPackages: readonly string[] = DEV_PUBLISH_PACKAGES

type Options = {
  dryRun: boolean
  force: boolean
  skipExisting: boolean
  channel?: 'dev' | 'worktree'
  tag?: string
  version?: string
  sourceVersions: boolean
}

type RegistryMetadata = {
  versions?: Record<string, RegistryPackageVersion>
  'dist-tags'?: Record<string, string>
}

type RegistryPackageVersion = {
  dist?: {
    tarball?: string
  }
}

type FingerprintInput = {
  manifest: Manifest
  files: Record<string, string>
  internalPackageNames: string[]
}

type PublishDecisionInput = {
  tag: string
  normalTimestampedDevPublish: boolean
  packages: Array<{
    name: string
    localVersion: string
    localFingerprint: string
    activeTagVersion?: string | undefined
    registryVersions: Record<string, { fingerprint?: string | undefined }>
  }>
}

type PublishPlan = {
  action: 'skip' | 'publish'
  publishPackageNames: string[]
  reason: string
}

type PackedPackage = {
  name: string
  version: string
  tarballPath: string
  tmp: string
  fingerprint: string
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const INTERNAL_ASP_DEPENDENCY_SPEC = '<asp-internal-package>'

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    force: false,
    skipExisting: false,
    sourceVersions: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--skip-existing') {
      options.skipExisting = true
    } else if (arg === '--source-versions') {
      options.sourceVersions = true
    } else if (arg === '--channel') {
      const value = argv[++i]
      if (value !== 'dev' && value !== 'worktree') {
        throw new Error('--channel must be "dev" or "worktree"')
      }
      options.channel = value
    } else if (arg.startsWith('--channel=')) {
      const value = arg.slice('--channel='.length)
      if (value !== 'dev' && value !== 'worktree') {
        throw new Error('--channel must be "dev" or "worktree"')
      }
      options.channel = value
    } else if (arg === '--version') {
      const value = argv[++i]
      if (!value) throw new Error('--version requires a value')
      options.version = value
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length)
    } else if (arg === '--tag') {
      const value = argv[++i]
      if (!value) throw new Error('--tag requires a value')
      options.tag = value
    } else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.sourceVersions && (options.version || process.env.ASP_PUBLISH_VERSION)) {
    throw new Error('--source-versions cannot be combined with --version or ASP_PUBLISH_VERSION')
  }
  if (options.force && options.skipExisting) {
    throw new Error('--force cannot be combined with --skip-existing')
  }

  return options
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/publish-local-verdaccio.ts [--dry-run]
  bun scripts/publish-local-verdaccio.ts --channel worktree [--dry-run]
  bun scripts/publish-local-verdaccio.ts --source-versions [--tag <tag>] [--force|--skip-existing] [--dry-run]
  bun scripts/publish-local-verdaccio.ts --version <semver> [--tag <tag>] [--force|--skip-existing] [--dry-run]

Default mode publishes a timestamped dev set as <base>-dev.YYYYMMDDHHMMSS tagged latest.
Worktree channel publishes <base>-worktree.YYYYMMDDHHMMSS.<shortsha> tagged worktree.
Source-version mode publishes each package at the version declared in its package.json.
Explicit --version publishes that exact version. Stable versions default to --tag latest.
Explicit prerelease versions require --tag.`)
}

function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version)
}

function resolvePublishVersion(baseVersion: string, options: Options): string {
  const version =
    options.version ??
    process.env.ASP_PUBLISH_VERSION ??
    timestampVersion(baseVersion, options.channel ?? 'dev')
  if (!isSemver(version)) {
    throw new Error(`Publish version must be valid semver: ${version}`)
  }
  if (options.version && isPrerelease(version) && !options.tag && options.channel !== 'worktree') {
    throw new Error('Explicit prerelease publishes require --tag')
  }
  return version
}

function resolveTag(options: Options): string {
  return options.tag ?? (options.channel === 'worktree' ? 'worktree' : 'latest')
}

function run(cmd: string, args: string[], cwd = ROOT): { status: number; out: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function stableJson(value: unknown): string {
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
  manifest: Manifest,
  internalPackageNames: Set<string>
): Record<string, unknown> {
  const { version: _version, ...manifestWithoutVersion } = manifest
  const normalized: Record<string, unknown> = { ...manifestWithoutVersion }
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

export function resolvePublishPlanForActiveTag(input: PublishDecisionInput): PublishPlan {
  const publishPackageNames = input.packages.map((pkg) => pkg.name)
  if (!input.normalTimestampedDevPublish) {
    return {
      action: 'publish',
      publishPackageNames,
      reason: 'active-tag skip only applies to the normal timestamped dev publish path',
    }
  }

  const activeTagVersions: string[] = []
  for (const pkg of input.packages) {
    const activeTagVersion = pkg.activeTagVersion
    if (!activeTagVersion) {
      return {
        action: 'publish',
        publishPackageNames,
        reason: `${pkg.name} does not have active tag ${input.tag}`,
      }
    }

    const registryVersion = pkg.registryVersions[activeTagVersion]
    if (!registryVersion) {
      return {
        action: 'publish',
        publishPackageNames,
        reason: `${pkg.name}@${activeTagVersion} is missing from the registry`,
      }
    }

    if (!registryVersion.fingerprint) {
      return {
        action: 'publish',
        publishPackageNames,
        reason: `${pkg.name}@${activeTagVersion} could not be fingerprinted`,
      }
    }

    activeTagVersions.push(activeTagVersion)
  }

  if (new Set(activeTagVersions).size !== 1) {
    return {
      action: 'publish',
      publishPackageNames,
      reason: `active tag ${input.tag} is not version-coherent across the ASP publish set`,
    }
  }

  for (const pkg of input.packages) {
    const activeTagVersion = pkg.activeTagVersion
    if (!activeTagVersion) continue
    const registryVersion = pkg.registryVersions[activeTagVersion]
    if (registryVersion?.fingerprint !== pkg.localFingerprint) {
      return {
        action: 'publish',
        publishPackageNames,
        reason: `${pkg.name} differs from the active ${input.tag} package`,
      }
    }
  }

  return {
    action: 'skip',
    publishPackageNames: [],
    reason: `active tag ${input.tag} already contains a coherent unchanged ASP publish set`,
  }
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
function binFilePaths(value: Manifest['bin']): string[] {
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

async function registryMetadata(name: string): Promise<RegistryMetadata | undefined> {
  const response = await fetch(`${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`)
  if (!response.ok) return undefined

  return (await response.json()) as RegistryMetadata
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

async function extractedPackageFingerprint(
  packageDir: string,
  internalPackageNames: string[]
): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as Manifest
  const files = await collectPackedFiles(packageDir)
  return materialPackageFingerprint({ manifest, files, internalPackageNames })
}

async function fingerprintRegistryTarball(
  version: string,
  metadata: RegistryMetadata,
  internalPackageNames: string[]
): Promise<string | undefined> {
  const tarballUrl = metadata.versions?.[version]?.dist?.tarball
  if (!tarballUrl) return undefined

  let tmp = ''
  try {
    tmp = await mkdtemp(join(tmpdir(), 'asp-registry-publish-'))
    const response = await fetch(tarballUrl)
    if (!response.ok) return undefined

    const tarballPath = join(tmp, 'package.tgz')
    await writeFile(tarballPath, new Uint8Array(await response.arrayBuffer()))

    const extractDir = join(tmp, 'extract')
    const mkdir = run('mkdir', ['-p', extractDir])
    if (mkdir.status !== 0) return undefined

    const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir])
    if (tar.status !== 0) return undefined

    return await extractedPackageFingerprint(join(extractDir, 'package'), internalPackageNames)
  } catch {
    return undefined
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  }
}

async function taggedVersion(name: string, tag: string): Promise<string | undefined> {
  const metadata = await registryMetadata(name)
  const version = metadata?.['dist-tags']?.[tag]
  return version && metadata?.versions?.[version] ? version : undefined
}

async function versionExists(name: string, version: string): Promise<boolean> {
  const metadata = await registryMetadata(name)
  return Boolean(metadata?.versions?.[version])
}

function gitShortSha(): string {
  const result = run('git', ['rev-parse', '--short=12', 'HEAD'])
  return result.status === 0 && result.out.trim() ? result.out.trim() : 'nogit'
}

export function timestampVersion(
  baseVersion: string,
  channel: 'dev' | 'worktree' = 'dev',
  now = new Date(),
  shortSha = gitShortSha()
): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const base = baseVersion.split('-')[0]
  return channel === 'worktree' ? `${base}-worktree.${stamp}.${shortSha}` : `${base}-dev.${stamp}`
}

async function packageVersionsByName(versionOverride?: string): Promise<Map<string, string>> {
  const entries = await Promise.all(
    publishPackages.map(async (rel) => {
      const manifest = (await Bun.file(join(ROOT, rel, 'package.json')).json()) as Manifest
      if (!manifest.name || !manifest.version) {
        throw new Error(`${rel}/package.json must include name and version`)
      }
      return [manifest.name, versionOverride ?? manifest.version] as const
    })
  )
  return new Map(entries)
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

async function packForPublish(rel: string): Promise<{
  name: string
  version: string
  tarballPath: string
  tmp: string
  fingerprint: string
}> {
  const pkgDir = join(ROOT, rel)
  const packageJsonPath = join(pkgDir, 'package.json')
  const originalPackageJson = await readFile(packageJsonPath, 'utf8')
  let tmp = ''
  let ranPackagePrepack = false
  let packedPackage: PackedPackage | undefined
  let operationError: unknown

  try {
    tmp = await mkdtemp(join(tmpdir(), 'asp-publish-'))
    const manifest = JSON.parse(originalPackageJson) as Manifest
    if (!manifest.name || !manifest.version) {
      throw new Error(`${rel}/package.json must include name and version`)
    }
    const packagePublishVersion = publishVersionsByName.get(manifest.name)
    if (!packagePublishVersion) {
      throw new Error(`no publish version resolved for ${manifest.name}`)
    }

    const { private: _private, ...manifestWithoutPrivate } = manifest
    const publishManifest = {
      ...manifestWithoutPrivate,
      version: packagePublishVersion,
      dependencies: pinInternalDependencies(manifest.dependencies, publishVersionsByName),
      devDependencies: pinInternalDependencies(manifest.devDependencies, publishVersionsByName),
      peerDependencies: pinInternalDependencies(manifest.peerDependencies, publishVersionsByName),
      optionalDependencies: pinInternalDependencies(
        manifest.optionalDependencies,
        publishVersionsByName
      ),
      exports: stripBunConditions(manifest.exports),
    }

    await writeFile(packageJsonPath, `${JSON.stringify(publishManifest, null, 2)}\n`)

    if (rel === PUBLIC_CLI_PACKAGE) {
      // The public CLI's package is self-contained. Its prepack copies and
      // rewrites workspace dependencies under node_modules; --ignore-scripts
      // intentionally prevents npm/bun from doing this implicitly.
      ranPackagePrepack = true
      const prepack = run('bun', ['scripts/prepack.ts'], pkgDir)
      if (prepack.status !== 0) {
        throw new Error(`prepack failed for ${manifest.name}: ${prepack.out}`)
      }
    }

    const pack = run('bun', ['pm', 'pack', '--destination', tmp, '--ignore-scripts'], pkgDir)
    if (pack.status !== 0) {
      throw new Error(`bun pm pack failed for ${manifest.name}: ${pack.out}`)
    }

    const entries = await readdir(tmp)
    const tarball = entries.find((entry) => entry.endsWith('.tgz'))
    if (!tarball) {
      throw new Error(`bun pm pack produced no tarball for ${manifest.name}`)
    }

    const extractDir = join(tmp, 'extract')
    const mkdir = run('mkdir', ['-p', extractDir])
    if (mkdir.status !== 0) throw new Error(`mkdir failed for ${manifest.name}: ${mkdir.out}`)

    const tarballPath = join(tmp, tarball)
    const tar = run('tar', ['-xzf', tarballPath, '-C', extractDir])
    if (tar.status !== 0) throw new Error(`tar failed for ${manifest.name}: ${tar.out}`)

    const stagedManifest = JSON.parse(
      await readFile(join(extractDir, 'package', 'package.json'), 'utf8')
    ) as Manifest
    const offenders = findBunConditions(stagedManifest.exports)
    if (offenders.length > 0) {
      throw new Error(
        `${manifest.name} tarball retains bun export conditions: ${offenders.join(', ')}`
      )
    }
    if (stagedManifest.private) {
      throw new Error(`${manifest.name} tarball still has private=true`)
    }
    const extractedPackageDir = join(extractDir, 'package')
    const referencedFiles = [
      stagedManifest.main,
      stagedManifest.types,
      ...binFilePaths(stagedManifest.bin),
      ...exportedFilePaths(stagedManifest.exports),
    ].filter((path): path is string => Boolean(path))
    for (const path of new Set(referencedFiles)) {
      await assertPackagedFile(extractedPackageDir, path, manifest.name)
    }

    const fingerprint = await extractedPackageFingerprint(extractedPackageDir, [
      ...publishVersionsByName.keys(),
    ])

    packedPackage = {
      name: manifest.name,
      version: packagePublishVersion,
      tarballPath,
      tmp,
      fingerprint,
    }
  } catch (error) {
    operationError = error
  }

  const cleanupErrors: Error[] = []
  if (ranPackagePrepack) {
    const postpack = run('bun', ['scripts/postpack.ts'], pkgDir)
    if (postpack.status !== 0) {
      cleanupErrors.push(new Error(`postpack failed for ${rel}: ${postpack.out}`))
    }
  }
  try {
    await writeFile(packageJsonPath, originalPackageJson)
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
  }

  const failures = operationError ? [operationError, ...cleanupErrors] : cleanupErrors
  if (failures.length > 0) {
    if (tmp) await rm(tmp, { recursive: true, force: true })
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, `packing ${rel} failed and cleanup also reported errors`)
  }
  if (!packedPackage) throw new Error(`packing ${rel} produced no package`)
  return packedPackage
}

function isNormalTimestampedDevPublish(options: Options, publishTag: string): boolean {
  return (
    !options.force &&
    !options.skipExisting &&
    !options.sourceVersions &&
    !options.version &&
    !process.env.ASP_PUBLISH_VERSION &&
    (options.channel === undefined || options.channel === 'dev') &&
    publishTag === 'latest'
  )
}

async function resolvePublishPlanForPackedPackages(
  packedPackages: PackedPackage[]
): Promise<PublishPlan> {
  const internalPackageNames = [...publishVersionsByName.keys()]
  const packages: PublishDecisionInput['packages'] = []

  for (const packed of packedPackages) {
    const metadata = await registryMetadata(packed.name)
    const activeTagVersion = metadata?.['dist-tags']?.[publishTag]
    const registryVersions: Record<string, { fingerprint?: string | undefined }> = {}

    if (metadata && activeTagVersion && metadata.versions?.[activeTagVersion]) {
      registryVersions[activeTagVersion] = {
        fingerprint: await fingerprintRegistryTarball(
          activeTagVersion,
          metadata,
          internalPackageNames
        ),
      }
    }

    packages.push({
      name: packed.name,
      localVersion: packed.version,
      localFingerprint: packed.fingerprint,
      activeTagVersion,
      registryVersions,
    })
  }

  return resolvePublishPlanForActiveTag({
    tag: publishTag,
    normalTimestampedDevPublish: isNormalTimestampedDevPublish(options, publishTag),
    packages,
  })
}

async function publishPackedPackage(packed: PackedPackage): Promise<void> {
  const id = `${packed.name}@${packed.version}`

  const exists = await versionExists(packed.name, packed.version)
  if (exists && options.skipExisting) {
    console.log(`SKIPPED    ${id} already exists in ${REGISTRY}`)
    return
  }
  if (exists && !options.force) {
    throw new Error(`${id} already exists in ${REGISTRY}; use --force to replace it`)
  }

  if (options.dryRun) {
    console.log(`DRY_RUN  ${id} --tag ${publishTag}`)
    return
  }

  if (options.force) {
    const unpublish = run('npm', ['unpublish', id, '--force', '--registry', REGISTRY])
    if (unpublish.status !== 0 && !/E404|404 Not Found|not found/i.test(unpublish.out)) {
      throw new Error(`npm unpublish failed for ${id}: ${unpublish.out}`)
    }
  }

  const publish = run('npm', [
    'publish',
    packed.tarballPath,
    '--ignore-scripts',
    '--registry',
    REGISTRY,
    '--tag',
    publishTag,
  ])
  if (publish.status !== 0) {
    throw new Error(`npm publish failed for ${id}: ${publish.out}`)
  }

  const tagged = await taggedVersion(packed.name, publishTag)
  if (tagged !== packed.version) {
    throw new Error(`registry ${publishTag} after publishing ${id} is ${tagged ?? '<missing>'}`)
  }

  console.log(`PUBLISHED  ${id} --tag ${publishTag}`)
}

let options: Options
let publishTag = 'latest'

async function main(argv = process.argv.slice(2)) {
  options = parseArgs(argv)
  publishPackages =
    options.version || options.sourceVersions || process.env.ASP_PUBLISH_VERSION
      ? RELEASE_PUBLISH_PACKAGES
      : DEV_PUBLISH_PACKAGES
  const ping = run('npm', ['ping', '--registry', REGISTRY])
  if (ping.status !== 0) {
    throw new Error(`Verdaccio is not reachable at ${REGISTRY}: ${ping.out}`)
  }

  const firstManifest = (await Bun.file(
    join(ROOT, publishPackages[0], 'package.json')
  ).json()) as Manifest
  if (!firstManifest.version) {
    throw new Error(`${publishPackages[0]}/package.json must include version`)
  }
  publishTag = resolveTag(options)
  const versionOverride = options.sourceVersions
    ? undefined
    : resolvePublishVersion(firstManifest.version, options)
  publishVersionsByName = await packageVersionsByName(versionOverride)

  const mode = options.dryRun ? 'Dry-run publishing' : 'Publishing'
  const versionLabel = options.sourceVersions
    ? 'source manifest versions'
    : [...new Set(publishVersionsByName.values())].join(', ')
  console.log(
    `${mode} ${publishPackages.length} ASP package(s) as ${versionLabel} --tag ${publishTag} to ${REGISTRY}`
  )

  const packedPackages: PackedPackage[] = []
  try {
    for (const rel of publishPackages) {
      packedPackages.push(await packForPublish(rel))
    }

    const plan = await resolvePublishPlanForPackedPackages(packedPackages)
    if (plan.action === 'skip') {
      console.log(`SKIPPED    ${publishPackages.length} ASP package(s): ${plan.reason}`)
      return
    }

    if (isNormalTimestampedDevPublish(options, publishTag)) {
      console.log(`PUBLISHING full ASP wave: ${plan.reason}`)
    }

    for (const packed of packedPackages) {
      await publishPackedPackage(packed)
    }
  } finally {
    await Promise.all(
      packedPackages.map((packed) => rm(packed.tmp, { recursive: true, force: true }))
    )
  }
}

if (import.meta.main) {
  await main()
}
