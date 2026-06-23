/**
 * Clamp a number to an inclusive integer range.
 *
 * Truncates `value` toward zero (via `Math.trunc`) before clamping, so
 * non-integer inputs collapse to their integer part first.
 *
 * @throws {RangeError} when `min` is greater than `max`.
 */
export function clampInt(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clampInt: min (${min}) must not be greater than max (${max})`)
  }
  const truncated = Math.trunc(value)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}
