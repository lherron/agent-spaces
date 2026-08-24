/**
 * Shared internal runtime type guards.
 *
 * These were previously duplicated verbatim across several modules
 * (context-resolver, context-template, system-prompt, template-vars). They are
 * package-internal helpers and intentionally not re-exported from the package
 * root.
 */

/** Narrows to a plain object record (excludes arrays and `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
