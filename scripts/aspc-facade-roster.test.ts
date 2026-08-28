/**
 * T-07314 RED (AC-11): every closed roster must admit the new composition
 * package. A package that builds, tests, publishes and links only because
 * someone remembered to add it by hand is a package that silently drops out of
 * one of those rosters later; this test is the guard.
 *
 * Not roster work (deliberately NOT asserted): apps/cli
 * prepack/postpack/bundledDependencies — the CLI does not bundle `spaces-aspc`
 * and must not start bundling the facade.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { aspPackages } from './lib/import-graph.js'
import { discoverWorkspacePackages, topologicalWorkspaceLayers } from './lib/workspace-graph.ts'

const repoRoot = new URL('..', import.meta.url).pathname

const NPM_NAME = 'spaces-aspc-facade'
const DIR_NAME = 'harness/aspc-facade'

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
  test('AC-11: the composition package is in every closed roster', async () => {
    const rootManifest = JSON.parse(read('package.json')) as RootManifest

    // Build graph: present, and AFTER spaces-aspc (it composes it).
    expect(rootManifest.scripts['build:ordered']).toBe('bun scripts/build-workspaces.ts')
    const buildLayers = topologicalWorkspaceLayers(await discoverWorkspacePackages(repoRoot))
    const facadeLayer = buildLayers.findIndex((layer) =>
      layer.some(({ name }) => name === NPM_NAME)
    )
    const aspcLayer = buildLayers.findIndex((layer) =>
      layer.some(({ name }) => name === 'spaces-aspc')
    )
    expect(facadeLayer).toBeGreaterThan(-1)
    expect(aspcLayer).toBeGreaterThan(-1)
    expect(facadeLayer).toBeGreaterThan(aspcLayer)

    // Root test loop.
    expect(rootManifest.scripts.test).toContain(NPM_NAME)

    // Import-graph ASP roster (boundary enforcement).
    expect(aspPackages).toContain(DIR_NAME)

    // Local dev publish roster, before the public CLI.
    const publish = read('scripts/publish-local-verdaccio.ts')
    const devPublishBlock = /const DEV_PUBLISH_PACKAGES = \[([\s\S]*?)\] as const/.exec(publish)
    expect(devPublishBlock).not.toBeNull()
    expect(devPublishBlock?.[1] ?? '').toContain(`'${DIR_NAME}'`)

    // justfile install links the facade package for the `aspc-facade`
    // executable; the existing harness/aspc link stays for `aspc`.
    const justfile = read('justfile')
    // Anchor on the comment that closes the link block: a lazy stop at the
    // first `fi` would cut the capture short of the `bun link` lines.
    const linkBlock =
      /link_pids=\(\)([\s\S]*?)# Publish must complete before downstream sync\./.exec(justfile)
    expect(linkBlock).not.toBeNull()
    const links = linkBlock?.[1] ?? ''
    expect(links).toContain(`cd ${DIR_NAME} && bun link`)
    expect(links).toContain('cd harness/aspc && bun link')
    // The adjacent comment must stop claiming spaces-aspc ships the facade bin.
    expect(justfile).not.toContain('spaces-aspc ships `aspc` + `aspc-facade`')
  })
})
