import { KeyedRegistry } from '../keyed-registry.js'
import type { CreateSessionOptions } from './options.js'
import type { SessionKind, UnifiedSession } from './types.js'

export type SessionFactory = (options: CreateSessionOptions) => UnifiedSession

export class SessionRegistry extends KeyedRegistry<SessionKind, SessionFactory> {
  register(kind: SessionKind, factory: SessionFactory): void {
    this.registerEntry(kind, factory, 'Session factory already registered: ')
  }

  get(kind: SessionKind): SessionFactory | undefined {
    return this.getEntry(kind)
  }

  getOrThrow(kind: SessionKind): SessionFactory {
    return this.getEntryOrThrow(kind, 'Session factory not found: ')
  }

  /**
   * Create a session via this registry's factory for `options.kind`. Prefer
   * this over the module-level {@link createSession} when a caller already
   * holds a registry instance, so the dependency is passed explicitly rather
   * than read from ambient module state.
   */
  createSession(options: CreateSessionOptions): UnifiedSession {
    return this.getOrThrow(options.kind)(options)
  }

  getKinds(): SessionKind[] {
    return this.keys()
  }

  clear(): void {
    this.clearEntries()
  }
}
