// WHY: Verify that the ASP cross-repo boundary packages pack into tarballs with
// no `bun` export condition (which would resolve cross-repo consumers to the
// unshipped ./src/*.ts). Each package goes through the publisher's own pack
// path (packForPublish: staged copy, publish manifest, `bun pm pack`, tarball
// validation), so this smoke checks what actually ships and only ever reads
// the checkout: other seats share it, and a killed run must leave no tracked
// file rewritten. The untarred manifest is then checked independently of the
// publisher's own assertion. Exit 0 = all pass.

import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type PublicationContext, packForPublish } from './lib/asp-publish/pack'
import {
  type PackageManifest,
  RELEASE_PUBLISH_PACKAGES,
  REPO_ROOT,
} from './lib/asp-publish/package-set'
import { extractTarball } from './lib/asp-publish/tarball'

const PACKAGES = [
  'contracts/agent-scope',
  'apps/cli-kit',
  'core/config',
  'core/runtime',
  'drivers/execution',
  'drivers/harness-claude',
  'drivers/harness-codex',
  'drivers/harness-pi',
  'drivers/harness-pi-sdk',
  'harness/harness-broker-pi-sdk',
  'harness/agent-harness-runtime',
  'harness/agent-harness',
  'contracts/spaces-runtime-contracts',
  'contracts/aspc-protocol',
  'compiler/agent-spaces',
] as const

type CheckOutcome =
  | { pkg: string; status: 'pass' }
  | { pkg: string; status: 'fail'; reason: string }

function findBunCondition(exportsField: unknown): string[] {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return []
  const offenders: string[] = []
  for (const [key, v] of Object.entries(exportsField as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      'bun' in (v as Record<string, unknown>)
    ) {
      offenders.push(key)
    }
  }
  return offenders
}

/** A smoke publication: source manifest versions, never sent to a registry. */
async function smokeContext(): Promise<PublicationContext> {
  const versionsByName = new Map<string, string>()
  for (const rel of RELEASE_PUBLISH_PACKAGES) {
    const manifest = JSON.parse(
      await readFile(join(REPO_ROOT, rel, 'package.json'), 'utf8')
    ) as PackageManifest
    if (manifest.name && manifest.version) versionsByName.set(manifest.name, manifest.version)
  }
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  return {
    versionsByName,
    builtAt: new Date().toISOString(),
    source: {
      repository: 'agent-spaces',
      canonicalRemote: 'smoke-pack-cross-repo',
      sourceCommit,
      canonicalRef: 'origin/main',
      canonical: false,
    },
  }
}

async function checkPackage(rel: string, context: PublicationContext): Promise<CheckOutcome> {
  let packed: Awaited<ReturnType<typeof packForPublish>>
  try {
    packed = await packForPublish(rel, context)
  } catch (error) {
    return { pkg: rel, status: 'fail', reason: (error as Error).message }
  }
  try {
    const extracted = extractTarball(packed.tarballPath, join(packed.tmp, 'smoke'), packed.name)
    const stagedPkg = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'))
    const offenders = findBunCondition(stagedPkg.exports)
    if (offenders.length > 0) {
      return {
        pkg: rel,
        status: 'fail',
        reason: `tarball package.json retains exports[*].bun for: ${offenders.join(', ')}`,
      }
    }
    return { pkg: rel, status: 'pass' }
  } catch (error) {
    return { pkg: rel, status: 'fail', reason: (error as Error).message }
  } finally {
    await rm(packed.tmp, { recursive: true, force: true })
  }
}

async function main() {
  const context = await smokeContext()
  let failed = false
  for (const rel of PACKAGES) {
    const outcome = await checkPackage(rel, context)
    if (outcome.status === 'pass') {
      console.log(`PASS  ${rel}`)
    } else {
      console.log(`FAIL  ${rel}  ${outcome.reason}`)
      failed = true
      break
    }
  }
  process.exit(failed ? 1 : 0)
}

await main()
