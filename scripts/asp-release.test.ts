import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { type AspReleaseManifest, inspectRelease } from './asp-release.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeRemovable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRemovable(path: string): void {
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    chmodSync(path, 0o755)
    for (const entry of readdirSync(path)) makeRemovable(join(path, entry))
  } else {
    chmodSync(path, 0o644)
  }
}

function sha256(bytes: string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

type FixtureOptions = {
  names?: string[]
  payload?: (name: string, id: string, sourceCommit: string) => string
  embeddedIdentity?: boolean
}

function fixture(options: FixtureOptions = {}): string {
  const root = join(tmpdir(), `asp-release-test-${crypto.randomUUID()}`)
  const id = 'asp-0123456789ab-20260916T120000Z-abcdef'
  const release = join(root, id)
  roots.push(root)
  mkdirSync(join(release, 'libexec'), { recursive: true })
  const executables = {} as Record<string, unknown>
  const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
  for (const name of options.names ?? ['aspc-facade', 'harness-broker']) {
    const launcher = `#!/bin/sh
printf '%s\\n' '${JSON.stringify({
      releaseId: id,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      executable: name,
      runtimeClosure: 'bun-compiled',
    })}'
`
    const payload = options.payload?.(name, id, sourceCommit) ?? '#!/bin/sh\nexit 0\n'
    writeFileSync(join(release, name), launcher, { mode: 0o555 })
    writeFileSync(join(release, 'libexec', name), payload, { mode: 0o555 })
    executables[name] = {
      launcher: name,
      launcherSha256: sha256(launcher),
      payload: `libexec/${name}`,
      payloadSha256: sha256(payload),
      runtimeClosure: 'bun-compiled',
      ...(options.embeddedIdentity === true ? { embeddedIdentity: true } : {}),
    }
  }
  const manifest: AspReleaseManifest = {
    schemaVersion: 'asp-standalone-release/v1',
    releaseId: id,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    builtAt: '2026-09-16T12:00:00.000Z',
    platform: 'darwin',
    architecture: 'arm64',
    executables: executables as AspReleaseManifest['executables'],
  }
  writeFileSync(join(release, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  chmodSync(join(release, 'release.json'), 0o444)
  chmodSync(join(release, 'libexec'), 0o555)
  chmodSync(release, 0o555)
  return release
}

describe('standalone ASP release inspection', () => {
  test('accepts a closed immutable executable set', () => {
    const release = fixture()
    const result = inspectRelease(release)
    expect(result.ok).toBe(true)
    expect(result.immutable).toBe(true)
    expect(result.runtimeClosure).toBe('bun-compiled')
    expect(result.mutableCheckoutReferences).toBe(false)
    expect(result.executableResolution['aspc-facade']?.payload.startsWith(`${release}/`)).toBe(true)
    expect(result.executableResolution['harness-broker']?.payload.startsWith(`${release}/`)).toBe(
      true
    )
    expect(result.executableResolution['aspc-facade']?.observedReleaseId).toBe(
      'asp-0123456789ab-20260916T120000Z-abcdef'
    )
  })

  test('rejects writable release content', () => {
    const release = fixture()
    chmodSync(join(release, 'release.json'), 0o644)
    expect(() => inspectRelease(release)).toThrow('release path is writable')
  })

  test('rejects payload drift', () => {
    const release = fixture()
    chmodSync(join(release, 'libexec', 'harness-broker'), 0o755)
    writeFileSync(join(release, 'libexec', 'harness-broker'), '#!/bin/sh\nexit 7\n')
    chmodSync(join(release, 'libexec', 'harness-broker'), 0o555)
    expect(() => inspectRelease(release)).toThrow('payload digest mismatch')
  })

  test('accepts an identity-bound aspd whose payloads embed the release identity', () => {
    const release = fixture({
      names: ['aspc-facade', 'harness-broker', 'aspd'],
      embeddedIdentity: true,
      payload: (_name, id, sourceCommit) => `#!/bin/sh\n# ${id} ${sourceCommit}\nexit 0\n`,
    })
    const result = inspectRelease(release)
    expect(result.executableResolution.aspd?.embeddedIdentity).toBe(true)
    expect(result.executableResolution['harness-broker']?.embeddedIdentity).toBe(true)
  })

  test('rejects a payload that claims an embedded identity it does not carry', () => {
    const release = fixture({
      names: ['aspc-facade', 'harness-broker', 'aspd'],
      embeddedIdentity: true,
    })
    expect(() => inspectRelease(release)).toThrow('does not embed its release identity')
  })

  test('rejects unknown executables and releases missing a required executable', () => {
    expect(() =>
      inspectRelease(fixture({ names: ['aspc-facade', 'harness-broker', 'rogue'] }))
    ).toThrow('unknown release executable: rogue')
    expect(() => inspectRelease(fixture({ names: ['aspc-facade', 'aspd'] }))).toThrow(
      'missing required executable: harness-broker'
    )
  })
})
