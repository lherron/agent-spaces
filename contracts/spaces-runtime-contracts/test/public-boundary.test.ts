import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as contracts from '../src/index'

const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { exports: Record<string, unknown> }

describe('public package boundary', () => {
  test('does not publish the retired v1 compiler-plan subpath', () => {
    expect(packageManifest.exports).not.toHaveProperty('./internal/compiler-plan-v1')
  })

  test('does not expose retired route-selection values', () => {
    expect(contracts).not.toHaveProperty('RUNTIME_ROUTE_CATALOG')
    expect(contracts).not.toHaveProperty('PI_SDK_MODEL_CATALOG')
    expect(contracts).not.toHaveProperty('defineRuntimeRouteCatalog')
  })
})
