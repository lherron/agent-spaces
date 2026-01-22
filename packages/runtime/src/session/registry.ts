import type { CreateSessionOptions } from './options.js'
import type { SessionKind, UnifiedSession } from './types.js'

export type SessionFactory = (options: CreateSessionOptions) => UnifiedSession

export class SessionRegistry {
  private factories = new Map<SessionKind, SessionFactory>()

  register(kind: SessionKind, factory: SessionFactory): void {
    if (this.factories.has(kind)) {
      throw new Error(`Session factory already registered: ${kind}`)
    }
    this.factories.set(kind, factory)
  }

  get(kind: SessionKind): SessionFactory | undefined {
    return this.factories.get(kind)
  }

  getOrThrow(kind: SessionKind): SessionFactory {
    const factory = this.factories.get(kind)
    if (!factory) {
      throw new Error(`Session factory not found: ${kind}`)
    }
    return factory
  }

  getKinds(): SessionKind[] {
    return Array.from(this.factories.keys())
  }

  clear(): void {
    this.factories.clear()
  }
}
