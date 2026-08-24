import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { piAdapter } from './adapters/pi-adapter.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(piAdapter)
}
