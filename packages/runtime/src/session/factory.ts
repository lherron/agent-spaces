import type { CreateSessionOptions } from './options.js'
import type { SessionRegistry } from './registry.js'
import type { UnifiedSession } from './types.js'

let sessionRegistry: SessionRegistry | undefined

export function setSessionRegistry(registry: SessionRegistry): void {
  sessionRegistry = registry
}

export function createSession(options: CreateSessionOptions): UnifiedSession {
  if (!sessionRegistry) {
    throw new Error('Session registry not configured')
  }
  return sessionRegistry.getOrThrow(options.kind)(options)
}
