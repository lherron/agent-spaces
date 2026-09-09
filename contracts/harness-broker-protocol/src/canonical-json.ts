/**
 * Deterministic JSON serialization used by every protocol-level digest.
 *
 * Extracted from `lifecycle.ts` (where it backed only the lifecycle-policy
 * hash) so the participant start-attempt digest (§C.5.1) hashes the SAME bytes
 * for the same value. A second, privately-written canonicalizer would let two
 * digests of one request disagree, which is exactly the conflict the immutable
 * start request is supposed to detect.
 *
 * Deliberately NOT re-exported from the package barrel: it is an internal
 * serialization detail shared by two modules, not a protocol surface.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null'
  const valueType = typeof value
  if (valueType === 'string') return JSON.stringify(value)
  if (valueType === 'boolean') return value ? 'true' : 'false'
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('canonical json forbids non-finite number')
    }
    return JSON.stringify(value)
  }
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') {
    return 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }
  if (typeof value !== 'object') {
    return JSON.stringify(String(value))
  }

  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const child = record[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalizeJson(child)}`)
  }
  return `{${parts.join(',')}}`
}
