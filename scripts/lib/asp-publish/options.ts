/** publish-local-verdaccio command line: flags, channel, version and tag. */

import { run } from './command'
import { DEV_PUBLISH_PACKAGES, RELEASE_PUBLISH_PACKAGES } from './package-set'

export type Channel = 'canonical' | 'dev' | 'worktree'

export type PublishOptions = {
  dryRun: boolean
  force: boolean
  skipExisting: boolean
  channel?: Channel
  tag?: string
  version?: string
  sourceVersions: boolean
}

function parseChannel(value: string | undefined): Channel {
  if (value !== 'canonical' && value !== 'dev' && value !== 'worktree') {
    throw new Error('--channel must be "canonical", "dev", or "worktree"')
  }
  return value
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

export function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = {
    dryRun: false,
    force: false,
    skipExisting: false,
    sourceVersions: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--skip-existing') {
      options.skipExisting = true
    } else if (arg === '--source-versions') {
      options.sourceVersions = true
    } else if (arg === '--channel') {
      options.channel = parseChannel(argv[++i])
    } else if (arg.startsWith('--channel=')) {
      options.channel = parseChannel(arg.slice('--channel='.length))
    } else if (arg === '--version') {
      options.version = requiredValue('--version', argv[++i])
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length)
    } else if (arg === '--tag') {
      options.tag = requiredValue('--tag', argv[++i])
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
  bun scripts/publish-local-verdaccio.ts --channel canonical [--dry-run]
  bun scripts/publish-local-verdaccio.ts --channel worktree [--dry-run]
  bun scripts/publish-local-verdaccio.ts --source-versions [--tag <tag>] [--force|--skip-existing] [--dry-run]
  bun scripts/publish-local-verdaccio.ts --version <semver> [--tag <tag>] [--force|--skip-existing] [--dry-run]

Default mode publishes a non-canonical timestamped dev set as <base>-dev.YYYYMMDDHHMMSS.
Canonical mode applies source/ref refusal gates and cache-empty published-set verification.
Worktree channel publishes <base>-worktree.YYYYMMDDHHMMSS.<shortsha> tagged worktree.
Source-version mode publishes each package at the version declared in its package.json.
Explicit --version publishes that exact version. Stable versions default to --tag latest.
Explicit prerelease versions require --tag.`)
}

/** Explicit or source versions publish the release set, which includes the public CLI. */
export function publishPackagesFor(options: PublishOptions): readonly string[] {
  return options.version || options.sourceVersions || process.env.ASP_PUBLISH_VERSION
    ? RELEASE_PUBLISH_PACKAGES
    : DEV_PUBLISH_PACKAGES
}

function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version)
}

export function resolvePublishVersion(baseVersion: string, options: PublishOptions): string {
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

export function resolveTag(options: PublishOptions): string {
  return options.tag ?? (options.channel === 'worktree' ? 'worktree' : 'latest')
}

/** Only the plain `latest` dev wave may skip publishing an unchanged set. */
export function isNormalTimestampedDevPublish(
  options: PublishOptions,
  publishTag: string
): boolean {
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

function gitShortSha(): string {
  const result = run('git', ['rev-parse', '--short=12', 'HEAD'])
  return result.status === 0 && result.out.trim() ? result.out.trim() : 'nogit'
}

export function timestampVersion(
  baseVersion: string,
  channel: Channel = 'dev',
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
