import { describe, expect, test } from 'bun:test'

import {
  ALWAYS_ON_PACKAGE_NAMES,
  isPublicSurfaceRelevant,
  selectAffectedPackageNames,
} from './lib/hook-optimization.ts'
import {
  reverseDependencyClosure,
  topologicalWorkspaceLayers,
  workspaceForPath,
} from './lib/workspace-graph.ts'
import type { WorkspacePackage } from './lib/workspace-graph.ts'

function workspace(
  name: string,
  relativePath: string,
  internalDependencies: string[] = []
): WorkspacePackage {
  return { name, relativePath, internalDependencies, absolutePath: `/${relativePath}`, scripts: {} }
}

const packages = [
  workspace('foundation', 'contracts/foundation'),
  workspace('consumer', 'core/consumer', ['foundation']),
  workspace('application', 'apps/application', ['consumer']),
  ...[...ALWAYS_ON_PACKAGE_NAMES].map((name) => workspace(name, `contracts/${name}`)),
]

describe('hook optimization graph', () => {
  test('build layers preserve dependencies while exposing independent work', () => {
    expect(
      topologicalWorkspaceLayers(packages.slice(0, 3)).map((layer) => layer.map(({ name }) => name))
    ).toEqual([['foundation'], ['consumer'], ['application']])
  })

  test('reverse closure and path ownership include downstream consumers', () => {
    expect([...reverseDependencyClosure(packages, ['foundation'])].sort()).toEqual([
      'application',
      'consumer',
      'foundation',
    ])
    expect(workspaceForPath(packages, 'core/consumer/src/index.ts')?.name).toBe('consumer')
  })

  test('source changes select downstream suites plus always-on contracts', () => {
    const selection = selectAffectedPackageNames(packages, ['core/consumer/src/index.ts'], false)
    expect(selection.full).toBeFalse()
    expect(selection.packageNames).toEqual(
      new Set([...ALWAYS_ON_PACKAGE_NAMES, 'consumer', 'application'])
    )
  })

  test('test-only changes stay within their owner and root uncertainty fails safe', () => {
    const testSelection = selectAffectedPackageNames(
      packages,
      ['core/consumer/src/index.test.ts'],
      false
    )
    expect(testSelection.packageNames.has('consumer')).toBeTrue()
    expect(testSelection.packageNames.has('application')).toBeFalse()

    expect(selectAffectedPackageNames(packages, ['tsconfig.json'], false).full).toBeTrue()
    expect(selectAffectedPackageNames(packages, undefined, true).full).toBeTrue()
  })

  test('script changes run script tests and runner changes fail safe to the full suite', () => {
    const ordinary = selectAffectedPackageNames(
      packages,
      ['scripts/check-doc-reachability.ts'],
      false
    )
    expect(ordinary).toMatchObject({ full: false, includeScripts: true })
    expect(selectAffectedPackageNames(packages, ['scripts/test-fast.ts'], false)).toMatchObject({
      full: true,
      includeScripts: true,
    })
  })

  test('public-surface relevance is limited to API-bearing inputs', () => {
    expect(isPublicSurfaceRelevant('core/config/src/index.ts')).toBeTrue()
    expect(isPublicSurfaceRelevant('core/config/package.json')).toBeTrue()
    expect(isPublicSurfaceRelevant('.public-surface-baseline.json')).toBeTrue()
    expect(isPublicSurfaceRelevant('scripts/test-fast.ts')).toBeFalse()
    expect(isPublicSurfaceRelevant('lefthook.yml')).toBeFalse()
  })
})
