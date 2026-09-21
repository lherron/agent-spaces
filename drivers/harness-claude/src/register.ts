import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { claudeAdapter } from './adapters/claude-adapter.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(claudeAdapter)
}
