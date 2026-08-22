/**
 * T-07318 RED (AC-11): every closed roster must admit the new composition
 * package. A package that builds, tests, publishes and links only because
 * someone remembered to add it by hand is a package that silently drops out of
 * one of those rosters later; this test is the guard.
 *
 * Not roster work (deliberately NOT asserted): packages/cli
 * prepack/postpack/bundledDependencies — the CLI does not bundle `spaces-aspc`
 * and must not start bundling the facade.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname

const NPM_NAME = 'spaces-aspc-facade'
const DIR_NAME = 'packages/aspc-facade'

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

type RootManifest = {
  scripts: {
    'build:ordered': string
    test: string
  }
}

describe('spaces-aspc-facade roster membership', () => {
  test('AC-11: the composition package is in every closed roster', () => {
    const rootManifest = JSON.parse(read('package.json')) as RootManifest

    // Build order: present, and AFTER spaces-aspc (it composes it).
    const buildOrdered = rootManifest.scripts['build:ordered']
    const facadeIndex = buildOrdered.indexOf(`'${NPM_NAME}'`)
    const aspcIndex = buildOrdered.indexOf("'spaces-aspc'")
    expect(facadeIndex).toBeGreaterThan(-1)
    expect(aspcIndex).toBeGreaterThan(-1)
    expect(facadeIndex).toBeGreaterThan(aspcIndex)

    // Root test loop.
    expect(rootManifest.scripts.test).toContain(NPM_NAME)

    // Import-graph ASP roster (boundary enforcement).
    const importGraph = read('scripts/lib/import-graph.ts')
    const aspPackagesBlock = /export const aspPackages = \[([\s\S]*?)\]/.exec(importGraph)
    expect(aspPackagesBlock).not.toBeNull()
    expect(aspPackagesBlock?.[1] ?? '').toContain("'aspc-facade'")

    // Local dev publish roster, before the public CLI.
    const publish = read('scripts/publish-local-verdaccio.ts')
    const devPublishBlock = /const DEV_PUBLISH_PACKAGES = \[([\s\S]*?)\] as const/.exec(publish)
    expect(devPublishBlock).not.toBeNull()
    expect(devPublishBlock?.[1] ?? '').toContain(`'${DIR_NAME}'`)

    // justfile install links the facade package for the `aspc-facade`
    // executable; the existing packages/aspc link stays for `aspc`.
    const justfile = read('justfile')
    // Anchor on the comment that closes the link block: a lazy stop at the
    // first `fi` would cut the capture short of the `bun link` lines.
    const linkBlock =
      /link_pids=\(\)([\s\S]*?)# Publish must complete before downstream sync\./.exec(justfile)
    expect(linkBlock).not.toBeNull()
    const links = linkBlock?.[1] ?? ''
    expect(links).toContain(`cd ${DIR_NAME} && bun link`)
    expect(links).toContain('cd packages/aspc && bun link')
    // The adjacent comment must stop claiming spaces-aspc ships the facade bin.
    expect(justfile).not.toContain('spaces-aspc ships `aspc` + `aspc-facade`')
  })
})
