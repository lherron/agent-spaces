/**
 * T-07314 RED (AC-1): after the facade split, `spaces-aspc` is a COMPILE-ONLY
 * package. It must carry no live-broker dependency. The start-plane absence is
 * pinned by the exact registered method set in compile-only-registration.test.ts.
 * The cohosted plane moves to the `spaces-aspc-facade` composition
 * package (see harness/aspc-facade/test/).
 *
 * The `spaces-harness-broker-protocol` / `spaces-harness-broker-client` edges
 * are accepted residual contract seams (coordinator finding 4) and are asserted
 * to REMAIN, so "drop the broker dep" cannot be over-satisfied by deleting them.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const packageRoot = new URL('..', import.meta.url).pathname
const srcRoot = join(packageRoot, 'src')

type Manifest = {
  dependencies?: Record<string, string> | undefined
  devDependencies?: Record<string, string> | undefined
  peerDependencies?: Record<string, string> | undefined
  optionalDependencies?: Record<string, string> | undefined
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const LIVE_BROKER_PACKAGE = 'spaces-harness-broker'
// Exact specifier or a subpath of it — deliberately does NOT match the
// `-protocol` / `-client` sibling packages, which stay.
const LIVE_BROKER_IMPORT = /['"]spaces-harness-broker(\/[^'"]*)?['"]/

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Manifest
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('spaces-aspc is compile-only', () => {
  test('AC-1: no live-broker dependency in the manifest or in src/**', () => {
    const pkg = manifest()

    for (const field of DEPENDENCY_FIELDS) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain(LIVE_BROKER_PACKAGE)
    }

    const offenders = sourceFiles(srcRoot).filter((file) =>
      LIVE_BROKER_IMPORT.test(readFileSync(file, 'utf8'))
    )
    expect(offenders).toEqual([])

    // Positive control (coordinator finding 4): the protocol/client contract
    // seams are accepted residual and must NOT be removed by this task.
    expect(Object.keys(pkg.dependencies ?? {})).toContain('spaces-harness-broker-protocol')
    expect(Object.keys(pkg.dependencies ?? {})).toContain('spaces-harness-broker-client')
  })
})
