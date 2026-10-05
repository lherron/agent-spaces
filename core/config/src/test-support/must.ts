/**
 * Narrow a possibly-undefined test value, failing the test with a clear message
 * when it is missing. Use instead of `!` so a missing value reports what was absent.
 */
export function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${label} to be defined`)
  }
  return value
}
