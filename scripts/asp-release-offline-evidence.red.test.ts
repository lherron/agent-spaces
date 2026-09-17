import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectRelease } from './asp-release.js'

// T-08565 red contract: historical manifests may omit this additive marker,
// but a capable frozen release must preserve it through inspection so callers
// can preflight without guessing an unknown worker subcommand.
const CAPABILITY = 'harness-broker.offline-evidence/v1'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function makeWritable(path: string): void {
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    chmodSync(path, 0o755)
    for (const name of readdirSync(path)) makeWritable(join(path, name))
  } else {
    chmodSync(path, 0o644)
  }
}

function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function releaseFixture(options: { capabilities?: string[]; readerExit?: number } = {}): string {
  const root = join(tmpdir(), `asp-offline-release-red-${crypto.randomUUID()}`)
  const releaseId = 'asp-0123456789ab-20260917T040000Z-red001'
  const release = join(root, releaseId)
  const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
  const builtAt = '2026-09-17T04:00:00.000Z'
  roots.push(root)
  mkdirSync(join(release, 'libexec'), { recursive: true })

  const executables: Record<string, unknown> = {}
  for (const name of ['aspc-facade', 'harness-broker']) {
    const releaseInfo = JSON.stringify({
      schemaVersion: 'asp-standalone-release/v1',
      releaseId,
      sourceCommit,
      builtAt,
      executable: name,
      runtimeClosure: 'bun-compiled',
    })
    const payload = `#!/bin/sh\nexit ${name === 'harness-broker' ? (options.readerExit ?? 0) : 0}\n`
    const launcher = `#!/bin/sh\nset -eu\nif [ "\${1-}" = "--release-info" ]; then\n  printf '%s\\n' '${releaseInfo}'\n  exit 0\nfi\nexec "$(dirname "$0")/libexec/${name}" "$@"\n`
    writeFileSync(join(release, name), launcher, { mode: 0o555 })
    writeFileSync(join(release, 'libexec', name), payload, { mode: 0o555 })
    executables[name] = {
      launcher: name,
      launcherSha256: digest(launcher),
      payload: `libexec/${name}`,
      payloadSha256: digest(payload),
      runtimeClosure: 'bun-compiled',
    }
  }

  const manifest = {
    schemaVersion: 'asp-standalone-release/v1',
    releaseId,
    sourceCommit,
    builtAt,
    platform: process.platform,
    architecture: process.arch,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    executables,
  }
  writeFileSync(join(release, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o444,
  })
  chmodSync(join(release, 'libexec'), 0o555)
  chmodSync(release, 0o555)
  return release
}

function capabilitiesOf(inspection: unknown): string[] {
  const capabilities = (inspection as { capabilities?: unknown }).capabilities
  return Array.isArray(capabilities)
    ? capabilities.filter((value): value is string => typeof value === 'string')
    : []
}

describe('T-08565 frozen release offline-reader preflight', () => {
  test('inspection preserves the declared offline-evidence capability', () => {
    const release = releaseFixture({ capabilities: [CAPABILITY] })
    const inspection = inspectRelease(release)

    expect(inspection.ok).toBe(true)
    expect(capabilitiesOf(inspection)).toContain(CAPABILITY)
  })

  test('a legacy manifest without capabilities remains inspectable and advertises no reader', () => {
    const release = releaseFixture()
    const inspection = inspectRelease(release)

    expect(inspection.ok).toBe(true)
    expect(capabilitiesOf(inspection)).toEqual([])
  })

  test('legacy unsupported and declared-but-failed remain distinct without guessing a spawn', () => {
    // This demonstrates the ASP manifest preflight seam a consumer can use; it
    // does not claim to test HRC's production refusal/reader adapter.
    const legacy = inspectRelease(releaseFixture({ readerExit: 7 }))
    const declaredPath = releaseFixture({ capabilities: [CAPABILITY], readerExit: 7 })
    const declared = inspectRelease(declaredPath)

    let legacySpawned = false
    let legacyDisposition = 'offline_reader_unsupported'
    if (capabilitiesOf(legacy).includes(CAPABILITY)) {
      legacySpawned = true
      legacyDisposition = 'reader_failed'
    }
    expect(legacyDisposition).toBe('offline_reader_unsupported')
    expect(legacySpawned).toBe(false)

    const capable = capabilitiesOf(declared).includes(CAPABILITY)
    const process = capable
      ? Bun.spawnSync([join(declaredPath, 'harness-broker'), 'evidence-read'], {
          stdin: Buffer.from('{}\n'),
          stdout: 'pipe',
          stderr: 'pipe',
        })
      : undefined
    const declaredDisposition = !capable
      ? 'offline_reader_unsupported'
      : process?.exitCode === 0
        ? 'reader_succeeded'
        : 'reader_failed'

    expect(declaredDisposition).toBe('reader_failed')
    expect(process?.exitCode).toBe(7)
  })
})
