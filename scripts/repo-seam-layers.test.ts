import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AspRoot,
  type AspWorkspacePackage,
  type Layer,
  aspRootDag,
  aspWorkspacePackages,
  buildDependencyGraph,
  deriveAspRootLayers,
  isForbidden,
  layerOf,
  layers,
} from './lib/import-graph.ts'

const repoRoot = new URL('..', import.meta.url).pathname

function rootLayer(root: AspRoot, candidates: readonly Layer[] = layers): Layer {
  const layer = candidates.find((candidate) => candidate.roots.includes(root))
  if (!layer) {
    throw new Error(`missing ${root} root layer`)
  }
  return layer
}

function forbids(layer: Layer, specifier: string): boolean {
  return layer.forbidden.some((token) => isForbidden(specifier, token))
}

function resolvedEdge(
  edges: Awaited<ReturnType<typeof buildDependencyGraph>>['edges'],
  fromRoot: string,
  targetPackage: string
): boolean {
  return edges.some(
    (edge) => edge.file.startsWith(`${fromRoot}/`) && edge.targetPackage === targetPackage
  )
}

describe('root-prefix architecture layers', () => {
  test('six root rules derive every prohibition from the DAG and discovered manifests', () => {
    const rootLayers = deriveAspRootLayers()
    expect(rootLayers).toHaveLength(6)
    expect(rootLayers.map((layer) => layer.roots[0])).toEqual(aspRootDag)

    for (const [layerIndex, layer] of rootLayers.entries()) {
      for (const pkg of aspWorkspacePackages) {
        const packageIndex = aspRootDag.indexOf(pkg.root)
        expect(`${layer.name}:${pkg.name}=${forbids(layer, pkg.name)}`).toBe(
          `${layer.name}:${pkg.name}=${packageIndex < layerIndex}`
        )
      }
    }

    // Synthetic future package: adding its manifest to apps is sufficient for
    // every lower root to inherit the prohibition; no layer table edit exists.
    const futureApp: AspWorkspacePackage = {
      dir: 'apps/future-app',
      name: 'spaces-future-app',
      root: 'apps',
    }
    const withFuturePackage = deriveAspRootLayers([...aspWorkspacePackages, futureApp])
    expect(forbids(rootLayer('apps', withFuturePackage), futureApp.name)).toBe(false)
    for (const root of aspRootDag.slice(1)) {
      expect(forbids(rootLayer(root, withFuturePackage), futureApp.name)).toBe(true)
    }
  })

  test('root prefixes guard non-src files and integration tests remain top-level', () => {
    expect(layerOf('harness/harness-broker/test/example.test.ts')).toBe('Harness')
    expect(layerOf('harness/future-package/scripts/generate.ts')).toBe('Harness')
    expect(layerOf('integration-tests/tests/repo-conformance.test.ts')).toBe('Apps')

    const harness = rootLayer('harness')
    expect(forbids(harness, 'spaces-turn-runner')).toBe(true)
    expect(forbids(harness, 'hrc-server')).toBe(true)

    const perPackageRoots = layers.flatMap((layer) =>
      layer.roots.filter((root) => !aspRootDag.some((candidate) => root === candidate))
    )
    expect(perPackageRoots).toEqual(['integration-tests', 'contracts/harness-broker-protocol'])
  })

  test('named permitted edges resolve and their reverse direction is forbidden', async () => {
    const graph = await buildDependencyGraph(repoRoot)
    const harness = rootLayer('harness')
    const compiler = rootLayer('compiler')
    const drivers = rootLayer('drivers')
    const contracts = rootLayer('contracts')

    expect(
      graph.edges.filter(
        (edge) =>
          edge.file.startsWith('compiler/') &&
          edge.specifier.startsWith('.') &&
          edge.targetPackage === 'apps/turn-runner'
      )
    ).toEqual([])

    // Intra-harness broker SDK edge.
    expect(
      resolvedEdge(graph.edges, 'harness/harness-broker-pi-sdk', 'harness/harness-broker')
    ).toBe(true)
    expect(forbids(harness, 'spaces-harness-broker')).toBe(false)
    expect(forbids(contracts, 'spaces-harness-broker-pi-sdk')).toBe(true)

    // Compiler -> broker protocol/client contracts retained by T-07314 AC-1.
    for (const [name, dir] of [
      ['spaces-harness-broker-protocol', 'contracts/harness-broker-protocol'],
      ['spaces-harness-broker-client', 'contracts/harness-broker-client'],
    ] as const) {
      expect(resolvedEdge(graph.edges, 'compiler', dir)).toBe(true)
      expect(forbids(compiler, name)).toBe(false)
    }
    expect(forbids(contracts, 'agent-spaces')).toBe(true)

    // T-07526 has removed the compiler -> drivers edges. Its temporary
    // enforcement exemption remains until the composition-root gate clears.
    for (const [name, dir] of [
      ['spaces-execution', 'drivers/execution'],
      ['spaces-harness-codex', 'drivers/harness-codex'],
    ] as const) {
      expect(resolvedEdge(graph.edges, 'compiler', dir)).toBe(false)
      expect(forbids(compiler, name)).toBe(false)
    }
    expect(forbids(drivers, 'agent-spaces')).toBe(true)
  })

  test('ratified protocol constraint remains an explicit documented exception', () => {
    const exception = layers.find(
      (layer) => layer.name === 'Harness Broker Protocol Contract Exception'
    )
    expect(exception).toBeDefined()
    expect(exception && forbids(exception, 'spaces-runtime-contracts')).toBe(true)
    expect(forbids(rootLayer('contracts'), 'spaces-runtime-contracts')).toBe(false)

    const source = readFileSync(join(repoRoot, 'scripts/lib/import-graph.ts'), 'utf8')
    expect(source).toContain('#20151')
    expect(source).toMatch(/ratified-deliberate/)
    expect(source).toContain('REQUIRED_BOUNDARY_CHECKS remains')
  })
})
