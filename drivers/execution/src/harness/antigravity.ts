import type { HarnessAdapter } from 'spaces-config'
import { ANTIGRAVITY_MODEL_IDS } from 'spaces-runtime-contracts'

function requiresRaspd(): never {
  throw new Error('unsupported_harness: Antigravity compilation requires raspd.')
}

export const antigravityAdapter: HarnessAdapter = {
  id: 'antigravity-hrcpty',
  name: 'Antigravity',
  models: ANTIGRAVITY_MODEL_IDS.map((id, index) => ({ id, name: id, default: index === 0 })),
  async detect() {
    const path = Bun.which('agy')
    return path
      ? { available: true, path }
      : { available: false, error: 'agy was not found on PATH' }
  },
  validateSpace: requiresRaspd,
  materializeSpace: requiresRaspd,
  composeTarget: requiresRaspd,
  buildRunArgs: requiresRaspd,
  getTargetOutputPath: requiresRaspd,
  loadTargetBundle: requiresRaspd,
  getRunEnv: requiresRaspd,
  getDefaultRunOptions: requiresRaspd,
}
