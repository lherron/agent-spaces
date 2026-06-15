import type { UnifiedSession, UnifiedSessionEvent } from 'spaces-execution'

import type { InFlightRunContext } from './run-tracker.js'
import { shouldDrainOutstandingTurn } from './run-turn-helpers.js'
import { mapUnifiedEvents } from './session-events.js'

export interface AttachTurnDriverOptions {
  /**
   * Called when the unified session reports a continuation key. Each call site
   * captures it differently (closure var, context field, event-emitter
   * setContinuation, or some combination) — so the wiring is delegated here.
   */
  onContinuationKey: (key: string) => void
  /**
   * Invoked exactly when an outstanding turn drains to zero. The in-flight CLI
   * driver resolves the completion promise via completeInFlightSuccess; the
   * placement driver flips the completion sentinel and idles the emitter. The
   * caller owns that distinction.
   */
  onDrained: (context: InFlightRunContext) => void
}

/**
 * Install the shared in-flight turn-driver event loop on a unified session.
 *
 * This is the common state machine behind {@link InFlightRunContext}-based
 * drivers (the in-flight CLI turn and the placement turn): guard against a
 * completed run, map each unified event (emitting mapped events + capturing
 * continuation keys), and drain `outstandingTurns` via
 * {@link shouldDrainOutstandingTurn}. When the count reaches zero, `onDrained`
 * fires with the context.
 *
 * The non-inflight `runTurnNonInteractive` driver deliberately does NOT use this
 * helper — it completes on a simple `turnEnded` boolean off `result.turnEnded`
 * rather than draining `outstandingTurns`, and forcing it through this shape
 * would change when `turn_end` resolves.
 */
export function attachTurnDriver(
  session: UnifiedSession,
  context: InFlightRunContext,
  options: AttachTurnDriverOptions
): void {
  session.onEvent((event: UnifiedSessionEvent) => {
    if (context.completion.done) return

    const mapped = mapUnifiedEvents(
      event,
      (mappedEvent) => {
        void context.eventEmitter.emit(mappedEvent)
      },
      options.onContinuationKey,
      context.assistantState,
      { allowSessionIdUpdate: context.allowSessionIdUpdate }
    )

    if (!shouldDrainOutstandingTurn(event, mapped, context)) return

    context.outstandingTurns = Math.max(0, context.outstandingTurns - 1)
    if (context.outstandingTurns !== 0) return

    options.onDrained(context)
  })
}
