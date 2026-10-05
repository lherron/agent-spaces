import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as contracts from '../src/index'

const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { exports: Record<string, unknown> }

describe('public package boundary', () => {
  test('does not publish retired v1 compiler or execution-profile subpaths', async () => {
    expect(packageManifest.exports).not.toHaveProperty('./internal/compiler-plan-v1')
    expect(packageManifest.exports).not.toHaveProperty('./compiler-plan')
    expect(packageManifest.exports).not.toHaveProperty('./execution-profile')
    // Retired subpaths have no type declarations by design; import them through
    // a runtime string so the checker does not try to resolve them.
    const retiredSubpaths: string[] = [
      'spaces-runtime-contracts/compiler-plan',
      'spaces-runtime-contracts/execution-profile',
    ]
    for (const subpath of retiredSubpaths) {
      await expect(import(subpath)).rejects.toThrow()
    }
  })

  test('does not expose retired route-selection values', () => {
    expect(contracts).not.toHaveProperty('RUNTIME_ROUTE_CATALOG')
    expect(contracts).not.toHaveProperty('PI_SDK_MODEL_CATALOG')
    expect(contracts).not.toHaveProperty('defineRuntimeRouteCatalog')
  })

  test('does not expose the v1 profile-selection union or generic validators', () => {
    expect(contracts).not.toHaveProperty('validateExecutionProfile')
    expect(contracts).not.toHaveProperty('validateTerminalExecutionProfile')
  })
})
