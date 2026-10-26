/**
 * Code-path liveness markers (T-11825): which ASP compile, preparation and
 * materialization branches actually run, and for whom. Each marker is one
 * exact count per branch decision, aggregated by the usage-metrics writer into
 * `paths-<day>.ndjson` rows of kind `path`, one per minute per
 * (marker, caller, outcome).
 *
 * A marker never throws, never writes to stdout/stderr and never changes what
 * the code around it does. `outcome` is always a closed enum value (recipe id,
 * harness id, refusal code, hit/miss); never a path, ref, prompt or env value.
 * `caller` is a `<name>/<version>` only: the aspd request's client when one is
 * in scope, else this process's own product.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { usageMetrics, usageMetricsLabel, usageMetricsProduct } from '../usage-metrics/index.js'

/** The approved marker set (T-11825 marker list). Adding one is a reviewed change. */
export type PathMarkerId =
  | 'compile.entry'
  | 'compile.recipe'
  | 'compile.harness-source'
  | 'compile.continuation'
  | 'compile.inspection'
  | 'client.prepare-process'
  | 'client.process-spec'
  | 'client.legacy-entry'
  | 'declaration.resolve'
  | 'declaration.project-mode'
  | 'declaration.agent-root'
  | 'declaration.profile-absent'
  | 'placement.inspect'
  | 'placement.scaffold-fallback'
  | 'capability.observe'
  | 'continuation.observe'
  | 'aspc.observation-schema-fallback'
  | 'prepare.frontend'
  | 'prepare.spec-kind'
  | 'prepare.identity'
  | 'prepare.system-prompt'
  | 'prepare.codex-home'
  | 'harness.detect'
  | 'materialize.registry-fetch'
  | 'materialize.lock-write'
  | 'materialize.snapshot'
  | 'materialize.space'
  | 'materialize.agent-local'
  | 'materialize.bundle'
  | 'materialize.bundle-prune'
  | 'materialize.codex-home'
  | 'materialize.prompt-artifact'
  | 'run.entry'
  | 'run.legacy-migrate'
  | 'run.surface'
  | 'install.entry'

export const PATH_MARKER_COMPONENT = 'paths'
export const PATH_MARKER_KIND = 'path'

const callerScope = new AsyncLocalStorage<string>()

/**
 * Run `fn` with `client` (a request envelope's `<name>/<version>`) as the caller
 * every marker inside it reports. Only a host that serves other programs
 * (aspd) sets this; in-process callers are attributed to their own product.
 */
export function withPathMarkerCaller<T>(client: string | undefined, fn: () => T): T {
  let caller: string
  try {
    caller = usageMetricsLabel(client)
  } catch {
    return fn()
  }
  return callerScope.run(caller, fn)
}

/** Count one pass through `marker` with this `outcome`. Never throws. */
export function pathMarker(
  marker: PathMarkerId,
  outcome: string,
  measures?: Record<string, number>
): void {
  try {
    usageMetrics(PATH_MARKER_COMPONENT).count(
      PATH_MARKER_KIND,
      { marker, caller: callerScope.getStore() ?? usageMetricsProduct(), outcome },
      measures
    )
  } catch {
    // A marker must never disturb the path it observes.
  }
}

/** Start timing `marker`; the returned function records the outcome with `ms`. */
export function pathMarkerTimer(marker: PathMarkerId): (outcome: string) => void {
  const started = performance.now()
  return (outcome) => pathMarker(marker, outcome, { ms: performance.now() - started })
}
