import type { EventFamily, EventProvenance } from 'spaces-harness-broker-protocol'
import type { CaptureGate, NormalizeOutcome } from '../capture/capture-gate'

/**
 * Shared hook-ingress capture seam (T-07853 §7.1).
 *
 * Every hook-driven driver does the same three things per hook payload: commit
 * the payload verbatim, normalize it while stamping its provenance on whatever
 * it emits, and report one durable disposition. This holds that shape once so
 * each driver contributes only its own vocabulary — its known hook names and
 * the family an unknown one belongs to.
 *
 * The provenance slot is a STACK, not a slot: a driver may normalize provider
 * transcript rows inside a hook's normalization, and the inner record's
 * provenance must not leak out to the events the outer hook mints afterwards.
 */
export interface HookCaptureSeam {
  /** Provenance of the record currently being normalized, if any. */
  provenance(): EventProvenance | undefined
  /** Record that the current raw record produced one broker event. */
  minted(): void
  /**
   * Commit one hook payload and normalize it. Returns whatever `normalize`
   * returns, so a driver can still answer a synchronous hook decision.
   */
  ingest<T>(
    input: { nativeType: string | undefined; hookData: unknown; turnId?: string | undefined },
    normalize: () => T
  ): T
}

export interface HookCaptureSeamOptions {
  capture?: CaptureGate | undefined
  provider: string
  driverKind: string
  invocationId: string
  /**
   * Hook names this driver is known to receive. A name outside this set is
   * vocabulary drift and must be loud rather than dropped.
   */
  knownHookNames: ReadonlySet<string>
  /**
   * Family an unknown hook name is attributed to — which is what decides how
   * LOUD the warning is. Nothing here stops capture: since T-07883 no family
   * halts the cursor.
   *
   * Every driver passes a non-load-bearing family here, and that is a corrected
   * position, not an oversight. The original reasoning was "the broker writes
   * the harness's hook configuration, so the set of names it can receive is
   * broker-controlled, and an unregistered name is therefore load-bearing
   * drift." The first live pi-tui-tmux session falsified that premise directly:
   * pi fired `before_agent_start` and `message_start`, the cursor halted (as it
   * then could), and 135 records piled up behind a hook the normalizer would
   * simply have ignored. That precedent is why the family is `diagnostic`; the
   * halt it provoked is gone fleet-wide.
   */
  unknownHookFamily: EventFamily
}

export function createHookCaptureSeam(options: HookCaptureSeamOptions): HookCaptureSeam {
  const stack: EventProvenance[] = []
  const mintedStack: number[] = []

  return {
    provenance(): EventProvenance | undefined {
      return stack.at(-1)
    },

    minted(): void {
      const depth = mintedStack.length
      if (depth > 0) {
        mintedStack[depth - 1] = (mintedStack[depth - 1] ?? 0) + 1
      }
    },

    ingest<T>(
      input: { nativeType: string | undefined; hookData: unknown; turnId?: string | undefined },
      normalize: () => T
    ): T {
      const capture = options.capture
      if (capture === undefined) {
        return normalize()
      }
      // `result` is assigned inside the normalize callback below, which the
      // gate always runs synchronously: the cursor never defers a record, so a
      // hook waiting on a synchronous decision always gets one.
      let result: T | undefined
      capture.ingest(
        {
          provider: options.provider,
          driverKind: options.driverKind,
          sourceKind: 'hook',
          sourceKey: `hook:${options.invocationId}`,
          nativeType: input.nativeType ?? '(none)',
          rawBytes: Buffer.from(JSON.stringify(input.hookData ?? null), 'utf8'),
          ...(input.turnId !== undefined ? { correlationHints: { turnId: input.turnId } } : {}),
        },
        (captured): NormalizeOutcome => {
          stack.push(captured.provenance())
          mintedStack.push(0)
          try {
            result = normalize()
            const minted = mintedStack.at(-1) ?? 0
            const name = input.nativeType
            if (name === undefined || !options.knownHookNames.has(name)) {
              return {
                disposition: 'blocked-unknown',
                family: options.unknownHookFamily,
                message: `Unknown ${options.driverKind} hook: ${name ?? '(none)'}`,
              }
            }
            return minted > 0
              ? { disposition: 'normalized', detail: name }
              : { disposition: 'state-only', detail: name }
          } finally {
            stack.pop()
            mintedStack.pop()
          }
        }
      )
      return result as T
    },
  }
}
