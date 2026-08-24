/**
 * T-07314 RED (AC-1, AC-2, AC-5): after the facade split, `spaces-aspc` is a
 * COMPILE-ONLY package. It must carry no live-broker dependency, must no longer
 * own the `aspc-facade` bin, and its `AspcService` must have lost the start
 * plane. The cohosted plane moves to the `spaces-aspc-facade` composition
 * package (see harness/aspc-facade/test/).
 *
 * The `spaces-harness-broker-protocol` / `spaces-harness-broker-client` edges
 * are accepted residual contract seams (coordinator finding 4) and are asserted
 * to REMAIN, so "drop the broker dep" cannot be over-satisfied by deleting them.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createAspcService } from '../src/service.js'

const packageRoot = new URL('..', import.meta.url).pathname
const srcRoot = join(packageRoot, 'src')

type Manifest = {
  bin?: Record<string, string> | string | undefined
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

  test('AC-2: the package no longer owns the aspc-facade bin', () => {
    const pkg = manifest()
    expect(Object.keys((pkg.bin ?? {}) as Record<string, string>)).toEqual(['aspc'])
    expect(existsSync(join(packageRoot, 'bin', 'aspc-facade.js'))).toBe(false)
    // Positive control: the compile-only CLI bin stays.
    expect(existsSync(join(packageRoot, 'bin', 'aspc.js'))).toBe(true)
  })

  test('AC-5: AspcService loses the start plane', () => {
    const service = createAspcService({})

    expect('compileAndStart' in service).toBe(false)
    // Positive control: the seven compile members remain on the service.
    for (const member of [
      'hello',
      'compileRuntimePlan',
      'catalogAgents',
      'inspectAgent',
      'catalogAgentInspection',
      'inspectAgentSelection',
      'compileHarnessInvocation',
    ]) {
      expect(typeof (service as unknown as Record<string, unknown>)[member]).toBe('function')
    }

    const serviceSource = readFileSync(join(srcRoot, 'service.ts'), 'utf8')
    const optionsBlock = /export interface AspcServiceOptions\s*\{([^}]*)\}/.exec(serviceSource)
    expect(optionsBlock).not.toBeNull()
    expect(optionsBlock?.[1] ?? '').not.toMatch(/\bbroker\b/)

    const interfaceBlock = /export interface AspcService\s*\{([\s\S]*?)\n\}/.exec(serviceSource)
    expect(interfaceBlock).not.toBeNull()
    expect(interfaceBlock?.[1] ?? '').not.toMatch(/\bcompileAndStart\b/)

    // `startFromDispatch` belongs to the composition package now.
    const withStartFromDispatch = sourceFiles(srcRoot).filter((file) =>
      /\bstartFromDispatch\b/.test(readFileSync(file, 'utf8'))
    )
    expect(withStartFromDispatch).toEqual([])
  })
})
