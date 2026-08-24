import type { PermissionDecision, PermissionRequestParams } from 'spaces-harness-broker-protocol'

export type PermissionRequestHandler = (
  request: PermissionRequestParams
) => Promise<PermissionDecision>

/** Optional sink for control-flow warnings; defaults to {@link console.warn}. */
export type PermissionWarnFn = (message: string) => void

/** Safe-default permission decision applied when no handler answers. */
export const DEFAULT_DENY_DECISION: PermissionDecision = { decision: 'deny' }

/**
 * Routes inbound broker-to-client `invocation.permission.request` calls to a
 * single registered handler. Falls back to the request's `defaultDecision`
 * (or {@link DEFAULT_DENY_DECISION}) when no handler is registered or the
 * handler throws.
 */
export class PermissionRouter {
  #handler: PermissionRequestHandler | undefined
  #warn: PermissionWarnFn

  constructor(warn: PermissionWarnFn = (message) => console.warn(message)) {
    this.#warn = warn
  }

  /**
   * Register the single permission handler. Last-writer-wins: a second call
   * replaces the previous handler. Returns a disposer that clears the handler
   * iff it is still the one registered here (a no-op once superseded).
   */
  setHandler(handler: PermissionRequestHandler): () => void {
    this.#handler = handler
    return () => {
      if (this.#handler === handler) {
        this.#handler = undefined
      }
    }
  }

  async handle(params: unknown): Promise<PermissionDecision> {
    const request = params as PermissionRequestParams
    if (!this.#handler) {
      this.#warn(
        `Broker permission request ${request.permissionRequestId} has no client handler; broker defaultDecision will apply.`
      )
      return this.#fallback(request)
    }

    try {
      return await this.#handler(request)
    } catch (error) {
      this.#warn(
        `Broker permission handler failed for ${request.permissionRequestId}: ${
          error instanceof Error ? error.message : String(error)
        }; broker defaultDecision will apply.`
      )
      return this.#fallback(request)
    }
  }

  #fallback(request: PermissionRequestParams): PermissionDecision {
    return request.defaultDecision !== undefined
      ? { decision: request.defaultDecision }
      : DEFAULT_DENY_DECISION
  }
}
