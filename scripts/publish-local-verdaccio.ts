/**
 * Publish the ASP package set to the local Verdaccio registry.
 *
 * The steps live in scripts/lib/asp-publish/: options (flags, version, tag),
 * provenance (source proof + praesidiumBuild), pack (stage, pack, validate),
 * fingerprint + publish-plan (active-tag skip) and registry (reads). This
 * entry point sequences them and owns the writes: publish and canonical proof.
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { run } from './lib/asp-publish/command'
import { stableJson } from './lib/asp-publish/fingerprint'
import {
  type PublishOptions,
  isNormalTimestampedDevPublish,
  parseArgs,
  publishPackagesFor,
  resolvePublishVersion,
  resolveTag,
} from './lib/asp-publish/options'
import { type PackedPackage, type PublicationContext, packForPublish } from './lib/asp-publish/pack'
import { type PackageManifest, REPO_ROOT } from './lib/asp-publish/package-set'
import { praesidiumBuildFor, provePublicationSource } from './lib/asp-publish/provenance'
import {
  type PublishDecisionInput,
  type PublishPlan,
  resolvePublishPlanForActiveTag,
} from './lib/asp-publish/publish-plan'
import {
  REGISTRY,
  fetchTarballUncached,
  fingerprintRegistryTarball,
  registryMetadata,
  taggedVersion,
  versionExists,
} from './lib/asp-publish/registry'
import { withExtractedTarball } from './lib/asp-publish/tarball'

/** One publication run: parsed options plus the resolved tag and package context. */
type Publication = PublicationContext & {
  options: PublishOptions
  tag: string
}

async function packageVersionsByName(
  packages: readonly string[],
  versionOverride?: string
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    packages.map(async (rel) => {
      const manifest = (await Bun.file(
        join(REPO_ROOT, rel, 'package.json')
      ).json()) as PackageManifest
      if (!manifest.name || !manifest.version) {
        throw new Error(`${rel}/package.json must include name and version`)
      }
      return [manifest.name, versionOverride ?? manifest.version] as const
    })
  )
  return new Map(entries)
}

async function resolvePublishPlanForPackedPackages(
  publication: Publication,
  packedPackages: PackedPackage[]
): Promise<PublishPlan> {
  const internalPackageNames = [...publication.versionsByName.keys()]
  const packages: PublishDecisionInput['packages'] = []

  for (const packed of packedPackages) {
    const metadata = await registryMetadata(packed.name)
    const activeTagVersion = metadata?.['dist-tags']?.[publication.tag]
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
    tag: publication.tag,
    normalTimestampedDevPublish: isNormalTimestampedDevPublish(
      publication.options,
      publication.tag
    ),
    packages,
  })
}

async function publishPackedPackage(publication: Publication, packed: PackedPackage) {
  const { options, tag } = publication
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
    console.log(`DRY_RUN  ${id} --tag ${tag}`)
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
    tag,
  ])
  if (publish.status !== 0) {
    throw new Error(`npm publish failed for ${id}: ${publish.out}`)
  }

  const tagged = await taggedVersion(packed.name, tag)
  if (tagged !== packed.version) {
    throw new Error(`registry ${tag} after publishing ${id} is ${tagged ?? '<missing>'}`)
  }

  console.log(`PUBLISHED  ${id} --tag ${tag}`)
}

export async function assertNoCanonicalVersionReplacement(
  packages: Array<{ name: string; version: string }>,
  exists: (name: string, version: string) => Promise<boolean> = versionExists
): Promise<void> {
  for (const packed of packages) {
    if (await exists(packed.name, packed.version)) {
      throw new Error(
        `Canonical publication refuses same-name/version replacement: ${packed.name}@${packed.version} already exists in ${REGISTRY}`
      )
    }
  }
}

/** Cache-empty fetch every published tarball and verify its build tuple. */
async function verifyCanonicalPublishedSet(
  publication: Publication,
  packedPackages: PackedPackage[]
): Promise<Array<{ name: string; version: string; tarball: string; bytes: number }>> {
  const proof: Array<{ name: string; version: string; tarball: string; bytes: number }> = []

  for (const packed of packedPackages) {
    const metadata = await registryMetadata(packed.name)
    const tarballUrl = metadata?.versions?.[packed.version]?.dist?.tarball
    if (!tarballUrl) {
      throw new Error(`Published metadata is missing ${packed.name}@${packed.version}`)
    }

    const response = await fetchTarballUncached(tarballUrl)
    if (!response.ok) {
      throw new Error(
        `Cache-empty tarball fetch failed for ${packed.name}@${packed.version}: ` +
          `${response.status} ${response.statusText}`
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) {
      throw new Error(`Cache-empty tarball fetch returned no bytes for ${packed.name}`)
    }

    await withExtractedTarball(bytes, 'asp-published-proof-', packed.name, async (packageDir) => {
      const manifest = JSON.parse(
        await readFile(join(packageDir, 'package.json'), 'utf8')
      ) as PackageManifest
      const expectedBuild = praesidiumBuildFor(
        publication.source,
        packed.version,
        publication.builtAt
      )
      if (stableJson(manifest.praesidiumBuild) !== stableJson(expectedBuild)) {
        throw new Error(`Published provenance mismatch for ${packed.name}@${packed.version}`)
      }
    })

    proof.push({
      name: packed.name,
      version: packed.version,
      tarball: tarballUrl,
      bytes: bytes.byteLength,
    })
  }

  return proof
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const canonical = options.channel === 'canonical' && !options.force && !options.skipExisting
  const source = provePublicationSource({ canonical })
  const builtAt = new Date().toISOString()
  if (!canonical) {
    console.log(
      `NON_CANONICAL publication channel=${options.channel ?? 'dev'} ` +
        `force=${options.force} skipExisting=${options.skipExisting}`
    )
  }
  const publishPackages = publishPackagesFor(options)
  const ping = run('npm', ['ping', '--registry', REGISTRY])
  if (ping.status !== 0) {
    throw new Error(`Verdaccio is not reachable at ${REGISTRY}: ${ping.out}`)
  }

  const firstPackage = publishPackages[0] as string
  const firstManifest = (await Bun.file(
    join(REPO_ROOT, firstPackage, 'package.json')
  ).json()) as PackageManifest
  if (!firstManifest.version) {
    throw new Error(`${firstPackage}/package.json must include version`)
  }
  const tag = resolveTag(options)
  const versionOverride = options.sourceVersions
    ? undefined
    : resolvePublishVersion(firstManifest.version, options)
  const publication: Publication = {
    options,
    tag,
    source,
    builtAt,
    versionsByName: await packageVersionsByName(publishPackages, versionOverride),
  }

  const mode = options.dryRun ? 'Dry-run publishing' : 'Publishing'
  const versionLabel = options.sourceVersions
    ? 'source manifest versions'
    : [...new Set(publication.versionsByName.values())].join(', ')
  console.log(
    `${mode} ${publishPackages.length} ASP package(s) as ${versionLabel} --tag ${tag} to ${REGISTRY}`
  )

  const packedPackages: PackedPackage[] = []
  try {
    for (const rel of publishPackages) {
      packedPackages.push(await packForPublish(rel, publication))
    }

    const plan = await resolvePublishPlanForPackedPackages(publication, packedPackages)
    if (plan.action === 'skip') {
      console.log(`SKIPPED    ${publishPackages.length} ASP package(s): ${plan.reason}`)
      return
    }

    if (isNormalTimestampedDevPublish(options, tag)) {
      console.log(`PUBLISHING full ASP wave: ${plan.reason}`)
    }

    if (canonical) {
      await assertNoCanonicalVersionReplacement(packedPackages)
    }

    for (const packed of packedPackages) {
      await publishPackedPackage(publication, packed)
    }

    if (canonical && !options.dryRun) {
      const fetched = await verifyCanonicalPublishedSet(publication, packedPackages)
      console.log(
        `PRAESIDIUM_PUBLISH_PROOF ${JSON.stringify({
          schema: 1,
          canonical: true,
          canonicalRef: source.canonicalRef,
          repository: source.repository,
          canonicalRemote: source.canonicalRemote,
          sourceCommit: source.sourceCommit,
          setName: 'asp',
          builtAt,
          packages: fetched,
        })}`
      )
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
