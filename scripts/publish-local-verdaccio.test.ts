import { describe, expect, test } from 'bun:test'
import {
  PRAESIDIUM_BUILD_FIELDS,
  RELEASE_PUBLISH_PACKAGES,
  assertNoCanonicalVersionReplacement,
  createPraesidiumBuild,
  timestampVersion,
} from './publish-local-verdaccio'

test('publishes the installable public CLI after its workspace package set', () => {
  expect(RELEASE_PUBLISH_PACKAGES.at(-1)).toBe('apps/cli')
  expect(RELEASE_PUBLISH_PACKAGES.filter((rel) => rel === 'apps/cli')).toHaveLength(1)
})

test('stages the exact normative praesidiumBuild tuple and no package fingerprint', () => {
  const build = createPraesidiumBuild({
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: 'a'.repeat(40),
    setVersion: '0.1.1-dev.20260725010101',
    builtAt: '2026-07-25T01:01:01.000Z',
  })

  expect(Object.keys(build)).toEqual(PRAESIDIUM_BUILD_FIELDS)
  expect(build).toEqual({
    schema: 1,
    repository: 'agent-spaces',
    canonicalRemote: 'git@github.com:lherron/agent-spaces.git',
    sourceCommit: 'a'.repeat(40),
    setName: 'asp',
    setVersion: '0.1.1-dev.20260725010101',
    builtAt: '2026-07-25T01:01:01.000Z',
  })
  expect(build).not.toHaveProperty('fingerprint')
})

test('canonical publication refuses same-name/version replacement before publishing', async () => {
  const checked: string[] = []
  await expect(
    assertNoCanonicalVersionReplacement(
      [
        { name: 'agent-scope', version: '0.1.1-dev.same' },
        { name: 'spaces-config', version: '0.1.1-dev.same' },
      ],
      async (name, version) => {
        checked.push(`${name}@${version}`)
        return name === 'spaces-config'
      }
    )
  ).rejects.toThrow(/refuses same-name\/version replacement/)
  expect(checked).toEqual(['agent-scope@0.1.1-dev.same', 'spaces-config@0.1.1-dev.same'])
})

describe('publish-local-verdaccio channel versions', () => {
  const now = new Date('2026-07-06T22:13:14Z')

  test('keeps the default dev channel shape unchanged', () => {
    expect(timestampVersion('0.1.1', 'dev', now, 'abc123')).toBe('0.1.1-dev.20260706221314')
  })

  test('uses a distinct worktree prerelease channel with the source short sha', () => {
    const version = timestampVersion('0.1.1', 'worktree', now, 'abc123def456')
    expect(version).toBe('0.1.1-worktree.20260706221314.abc123def456')
    expect(version).not.toContain('-dev.')
  })
})

type PackageManifestSnapshot = {
  name: string
  version: string
  main?: string
  types?: string
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type FingerprintInput = {
  manifest: PackageManifestSnapshot
  files: Record<string, string>
  internalPackageNames: string[]
}

type FingerprintInputOverrides = {
  manifest?: Partial<PackageManifestSnapshot>
  files?: Record<string, string>
  internalPackageNames?: string[]
}

type PublishDecisionInput = {
  tag: string
  normalTimestampedDevPublish: boolean
  packages: Array<{
    name: string
    localVersion: string
    localFingerprint: string
    activeTagVersion?: string
    registryVersions: Record<string, { fingerprint: string }>
  }>
}

async function loadPublishPlanningApi() {
  const mod = (await import('./publish-local-verdaccio')) as Record<string, unknown>
  expect(mod.materialPackageFingerprint).toBeFunction()
  expect(mod.resolvePublishPlanForActiveTag).toBeFunction()

  return mod as {
    materialPackageFingerprint(input: FingerprintInput): string
    resolvePublishPlanForActiveTag(input: PublishDecisionInput): {
      action: 'skip' | 'publish'
      publishPackageNames: string[]
      reason: string
    }
  }
}

function packageSnapshot(overrides: FingerprintInputOverrides = {}): FingerprintInput {
  return {
    manifest: {
      name: 'spaces-config',
      version: '0.1.1-dev.20260706221314',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
      dependencies: {
        'agent-scope': '0.1.1-dev.20260706221314',
        zod: '^3.25.0',
      },
      ...overrides.manifest,
    },
    files: {
      'dist/index.d.ts': 'export declare const value: string\n',
      'dist/index.js': 'export const value = "same"\n',
      ...overrides.files,
    },
    internalPackageNames: overrides.internalPackageNames ?? ['agent-scope', 'spaces-config'],
  }
}

describe('publish-local-verdaccio material publish planning', () => {
  test('material package fingerprints ignore generated versions and internal ASP pins only', async () => {
    const { materialPackageFingerprint } = await loadPublishPlanningApi()
    const baseline = materialPackageFingerprint(packageSnapshot())

    // Generated publish-wave data must not force a new Verdaccio wave by itself.
    expect(
      materialPackageFingerprint(
        packageSnapshot({
          manifest: {
            version: '0.1.1-dev.20260706221455',
            dependencies: {
              'agent-scope': '0.1.1-dev.20260706221455',
              zod: '^3.25.0',
            },
          },
        })
      )
    ).toBe(baseline)

    expect(
      materialPackageFingerprint(
        packageSnapshot({
          manifest: {
            dependencies: {
              'agent-scope': '0.1.1-dev.20260706221455',
              zod: '^3.26.0',
            },
          },
        })
      )
    ).not.toBe(baseline)

    expect(
      materialPackageFingerprint(
        packageSnapshot({
          files: {
            'dist/index.js': 'export const value = "changed"\n',
          },
        })
      )
    ).not.toBe(baseline)
  })

  test('active tag must be a coherent full matching set before skipping a publish wave', async () => {
    const { resolvePublishPlanForActiveTag } = await loadPublishPlanningApi()
    const coherentPackages: PublishDecisionInput['packages'] = [
      {
        name: 'agent-scope',
        localVersion: '0.1.1-dev.20260706230000',
        localFingerprint: 'agent-scope-fp',
        activeTagVersion: '0.1.1-dev.20260706221314',
        registryVersions: {
          '0.1.1-dev.20260706221314': { fingerprint: 'agent-scope-fp' },
        },
      },
      {
        name: 'spaces-config',
        localVersion: '0.1.1-dev.20260706230000',
        localFingerprint: 'spaces-config-fp',
        activeTagVersion: '0.1.1-dev.20260706221314',
        registryVersions: {
          '0.1.1-dev.20260706221314': { fingerprint: 'spaces-config-fp' },
        },
      },
    ]

    expect(
      resolvePublishPlanForActiveTag({
        tag: 'latest',
        normalTimestampedDevPublish: true,
        packages: coherentPackages,
      })
    ).toEqual({
      action: 'skip',
      publishPackageNames: [],
      reason: 'active tag latest already contains a coherent unchanged ASP publish set',
    })

    // Negative guard: matching content from different active-tag versions is torn history,
    // so it must publish the complete package set rather than skip.
    expect(
      resolvePublishPlanForActiveTag({
        tag: 'latest',
        normalTimestampedDevPublish: true,
        packages: [
          coherentPackages[0],
          {
            ...coherentPackages[1],
            activeTagVersion: '0.1.1-dev.20260706220000',
            registryVersions: {
              '0.1.1-dev.20260706220000': { fingerprint: 'spaces-config-fp' },
            },
          },
        ],
      })
    ).toEqual({
      action: 'publish',
      publishPackageNames: ['agent-scope', 'spaces-config'],
      reason: 'active tag latest is not version-coherent across the ASP publish set',
    })

    // Changed waves must stay complete; per-package skip would preserve the torn-latest hazard.
    expect(
      resolvePublishPlanForActiveTag({
        tag: 'latest',
        normalTimestampedDevPublish: true,
        packages: [
          coherentPackages[0],
          {
            ...coherentPackages[1],
            localFingerprint: 'changed-spaces-config-fp',
          },
        ],
      })
    ).toEqual({
      action: 'publish',
      publishPackageNames: ['agent-scope', 'spaces-config'],
      reason: 'spaces-config differs from the active latest package',
    })
  })
})
