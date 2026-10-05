/** Read side of the Verdaccio registry the ASP set publishes to. */

import { extractedPackageFingerprint } from './fingerprint'
import { withExtractedTarball } from './tarball'

export const REGISTRY = process.env.VERDACCIO_REGISTRY ?? 'http://mini:4873/'

type RegistryPackageVersion = {
  dist?: {
    tarball?: string
  }
}

export type RegistryMetadata = {
  versions?: Record<string, RegistryPackageVersion>
  'dist-tags'?: Record<string, string>
}

export async function registryMetadata(name: string): Promise<RegistryMetadata | undefined> {
  const response = await fetch(`${REGISTRY.replace(/\/$/, '')}/${encodeURIComponent(name)}`)
  if (!response.ok) return undefined

  return (await response.json()) as RegistryMetadata
}

export async function taggedVersion(name: string, tag: string): Promise<string | undefined> {
  const metadata = await registryMetadata(name)
  const version = metadata?.['dist-tags']?.[tag]
  return version && metadata?.versions?.[version] ? version : undefined
}

export async function versionExists(name: string, version: string): Promise<boolean> {
  const metadata = await registryMetadata(name)
  return Boolean(metadata?.versions?.[version])
}

/** Material fingerprint of a published version, or undefined if it cannot be fetched. */
export async function fingerprintRegistryTarball(
  version: string,
  metadata: RegistryMetadata,
  internalPackageNames: string[]
): Promise<string | undefined> {
  const tarballUrl = metadata.versions?.[version]?.dist?.tarball
  if (!tarballUrl) return undefined

  try {
    const response = await fetch(tarballUrl)
    if (!response.ok) return undefined

    return await withExtractedTarball(
      new Uint8Array(await response.arrayBuffer()),
      'asp-registry-publish-',
      version,
      (packageDir) => extractedPackageFingerprint(packageDir, internalPackageNames)
    )
  } catch {
    return undefined
  }
}

/** Fetch a tarball bypassing every cache between here and the registry store. */
export async function fetchTarballUncached(tarballUrl: string): Promise<Response> {
  return fetch(
    `${tarballUrl}${tarballUrl.includes('?') ? '&' : '?'}praesidium_no_cache=${Date.now()}`,
    {
      cache: 'no-store',
      headers: {
        'cache-control': 'no-cache, no-store, max-age=0',
        pragma: 'no-cache',
      },
    }
  )
}
