/**
 * Tiny JSON-poke helpers shared by the tmux/codex hook normalizers and
 * transcript readers. These were previously re-declared with byte-identical
 * bodies across both drivers' `hook-events.ts`, `hook-transcript.ts`, and
 * `driver.ts` modules; lifted here to a single internal module to prevent drift.
 *
 * NOTE: `codex-app-server/event-map.ts` keeps its own `asRecord` because that
 * variant intentionally treats arrays as records (no `Array.isArray` guard) and
 * is therefore NOT equivalent to the one exported here.
 */

/** Coerce a value to a plain record, mapping non-objects/arrays to `{}`. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

/** Read a string-typed field off a record, else `undefined`. */
export function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

/** Read an integer-typed field off a record, else `undefined`. */
export function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/**
 * Normalize a hook record to its inner payload: hooks may arrive flat (with a
 * top-level `hook_event_name`) or wrapped under a `hookEvent` object.
 */
export function unwrapHookPayload(hook: Record<string, unknown>): Record<string, unknown> {
  if (typeof hook['hook_event_name'] === 'string') return hook
  const hookEvent = hook['hookEvent']
  if (hookEvent !== null && typeof hookEvent === 'object' && !Array.isArray(hookEvent)) {
    const inner = hookEvent as Record<string, unknown>
    if (typeof inner['hook_event_name'] === 'string') return inner
  }
  return hook
}
