/**
 * T-07317 RED (AC-1…AC-4): the three FUTURE repo seams — spaces-contracts,
 * aspc, harness — guarded NOW in the layer table so P2's split is a file move,
 * not a refactor. Authority: the ratified `agent-spaces.raspc-migration-contract`
 * invariant fixes the direction harness -> aspc -> spaces-contracts.
 *
 * Every assertion goes through the exported `isForbidden(specifier, token)`
 * rather than `forbidden.toContain(name)`, because legitimate rules use prefix
 * tokens (e.g. 'spaces-harness-') and exact-token containment would both
 * under- and over-report.
 *
 * Deliberately NOT asserted here: the source-text half of the compiler
 * carve-out (owned by apps/turn-runner/src/__tests__/
 * turn-runner-package-boundary.red.test.ts), intra-CONTRACTS edges, and seam
 * membership for packages triage left on the broad ASP layer.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Layer, aspPackages, isForbidden, layers } from './lib/import-graph.ts'

const repoRoot = new URL('..', import.meta.url).pathname
const importGraphSource = readFileSync(join(repoRoot, 'scripts/lib/import-graph.ts'), 'utf8')

const CONTRACTS_DIRS = [
  'contracts/agent-scope',
  'contracts/harness-broker-protocol',
  'contracts/spaces-runtime-contracts',
  'contracts/aspc-protocol',
]

function npmName(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, packageDir, 'package.json'), 'utf8')) as {
    name?: string
  }
  const name = manifest.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${packageDir}/package.json has no name`)
  }
  return name
}

function layerRootedAt(...roots: string[]): Layer | undefined {
  return layers.find((layer) => roots.every((root) => layer.roots.includes(root)))
}

function forbids(layer: Layer, specifier: string): boolean {
  return layer.forbidden.some((token) => isForbidden(specifier, token))
}

/** Readable diffs: `['spaces-harness-pi-sdk=false']` beats `[false]`. */
function verdicts(layer: Layer, specifiers: string[]): string[] {
  return specifiers.map((specifier) => `${specifier}=${forbids(layer, specifier)}`)
}

function expected(specifiers: string[], value: boolean): string[] {
  return specifiers.map((specifier) => `${specifier}=${value}`)
}

/**
 * The source text of one layer entry, including any comment lines between the
 * previous entry and this one — that is where a seam's exceptions are named.
 */
function layerSourceBlock(layerName: string): string {
  const nameIndex = importGraphSource.indexOf(`name: '${layerName}'`)
  if (nameIndex < 0) {
    throw new Error(`no source entry for layer ${layerName}`)
  }
  const arrayStart = importGraphSource.indexOf('export const layers')
  const previousEnd = importGraphSource.lastIndexOf('\n  },', nameIndex)
  const start = previousEnd > arrayStart ? previousEnd + '\n  },'.length : arrayStart
  const end = importGraphSource.indexOf('\n  },', nameIndex)
  return importGraphSource.slice(start, end < 0 ? importGraphSource.length : end)
}

function commentTextOf(layerName: string): string {
  return layerSourceBlock(layerName)
    .split('\n')
    .filter((line) => /^(\/\/|\/\*|\*)/.test(line.trim()))
    .join('\n')
}

// Downstream of the COMPILER seam: SDK/session plane, harness plane, and the
// packages that compose the compiler rather than being composed by it.
const COMPILER_FORBIDDEN = [
  'spaces-harness-pi-sdk',
  'spaces-harness-pi',
  'spaces-harness-claude',
  'spaces-harness-broker',
  'spaces-harness-broker-pi-sdk',
  'spaces-turn-runner',
  'spaces-aspc-facade',
  '@lherron/agent-spaces',
  'hrc-server',
  'acp-server',
  'gateway-discord',
]

// Named, reasoned exceptions plus the compiler's real upstream dependencies.
const COMPILER_PERMITTED = [
  'spaces-harness-codex',
  'spaces-harness-broker-protocol',
  'spaces-harness-broker-client',
  'agent-scope',
  'spaces-config',
  'spaces-runtime',
  'spaces-execution',
  'spaces-runtime-contracts',
  'spaces-aspc-protocol',
]

// Compiler-side specifiers no harness-plane package may import.
const COMPILER_SIDE = [
  'agent-spaces',
  'spaces-aspc',
  'spaces-aspc-protocol',
  'spaces-aspc-facade',
  'spaces-turn-runner',
  '@lherron/agent-spaces',
]

describe('future repo seams guarded in the layer table', () => {
  test('AC-1: COMPILER seam forbids the SDK/session plane and everything downstream', () => {
    const layer = layerRootedAt('compiler/agent-spaces/src', 'compiler/aspc/src')
    expect(layer).toBeDefined()
    if (!layer) {
      return
    }

    expect(verdicts(layer, COMPILER_FORBIDDEN)).toEqual(expected(COMPILER_FORBIDDEN, true))
    expect(verdicts(layer, COMPILER_PERMITTED)).toEqual(expected(COMPILER_PERMITTED, false))

    // Each exception must be named with its reason, not silently absent from
    // the forbidden list; the two broker edges cite the AC that keeps them.
    const comment = commentTextOf(layer.name)
    expect(comment).toContain('spaces-harness-codex')
    expect(comment).toContain('spaces-harness-broker-protocol')
    expect(comment).toContain('spaces-harness-broker-client')
    expect(comment).toContain('T-07314')
    expect(comment).toContain('AC-1')
    // Accepted residual: agent-spaces -> spaces-execution -> *-pi-sdk/pi-session
    // still leaks the SDK transitively; this seam is a DIRECT-import guard.
    expect(comment).toMatch(/transitiv/i)
    expect(comment).toContain('spaces-execution')
  })

  test('AC-2: HARNESS seam forbids compiler-side imports, pi-sdk exception explicit', () => {
    const broker = layerRootedAt('harness/harness-broker/src')
    expect(broker).toBeDefined()
    const brokerPiSdk = layerRootedAt('harness/harness-broker-pi-sdk/src')
    expect(brokerPiSdk).toBeDefined()
    if (!broker || !brokerPiSdk) {
      return
    }

    expect(verdicts(broker, COMPILER_SIDE)).toEqual(expected(COMPILER_SIDE, true))
    // pi-sdk: the broker's own driver plane. Ratified permitted-not-compelled:
    // spaces-runtime-contracts (primary #20151).
    const brokerPermitted = ['spaces-harness-pi-sdk', 'spaces-runtime-contracts']
    expect(verdicts(broker, brokerPermitted)).toEqual(expected(brokerPermitted, false))
    const brokerComment = commentTextOf(broker.name)
    expect(brokerComment).toContain('spaces-harness-pi-sdk')
    expect(brokerComment).toMatch(/exception/i)

    expect(verdicts(brokerPiSdk, COMPILER_SIDE)).toEqual(expected(COMPILER_SIDE, true))
    const piSdkPermitted = ['spaces-harness-broker', 'spaces-harness-broker-protocol']
    expect(verdicts(brokerPiSdk, piSdkPermitted)).toEqual(expected(piSdkPermitted, false))
  })

  test('AC-3: CONTRACTS layers forbid every downstream ASP package, derived not listed', () => {
    const contractsNames = new Set(CONTRACTS_DIRS.map(npmName))
    const failures: string[] = []

    for (const contractsDir of CONTRACTS_DIRS) {
      const layer = layerRootedAt(`${contractsDir}/src`)
      if (!layer) {
        failures.push(`${contractsDir}/src: no layer`)
        continue
      }

      // Derived at test time from aspPackages: a package added to the roster
      // later cannot silently escape the contracts seam.
      for (const packageDir of aspPackages) {
        const name = npmName(packageDir)
        if (contractsNames.has(name)) {
          continue
        }
        if (!forbids(layer, name)) {
          failures.push(`${layer.name}: ${name} not forbidden`)
        }
      }
    }

    expect(failures).toEqual([])
  })

  test('AC-4: roster hole closed and the ratified protocol prohibition is marked', () => {
    expect(aspPackages).toContain('harness/harness-broker-pi-sdk')

    const protocol = layerRootedAt('contracts/harness-broker-protocol/src')
    expect(protocol).toBeDefined()
    if (!protocol) {
      return
    }
    expect(forbids(protocol, 'spaces-runtime-contracts')).toBe(true)

    const comment = commentTextOf(protocol.name)
    expect(comment).toContain('spaces-runtime-contracts')
    expect(comment).toContain('#20151')
    expect(comment).toMatch(/ratified/i)
  })
})
