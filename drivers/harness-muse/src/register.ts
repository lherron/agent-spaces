import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { museAdapter } from './adapters/muse-adapter.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(museAdapter)
}
