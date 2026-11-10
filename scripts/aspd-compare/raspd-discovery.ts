/** Explicit raspd discovery departures (T-13018 section 3).
 * Assert both sides' exact values before removing them from the parity diff;
 * report the values, as the runner reports version.frontDoor's declared extra.
 */
export const REFUSED_CAPABILITIES = [
  'catalogAgentInspection',
  'inspectAgentSelection',
  'prepareProcessInvocation',
  'prepareProcessInvocationTaskContext',
] as const

export function takeRaspdDiscoveryDifferences(
  bun: Map<string, unknown>,
  raspd: Map<string, unknown>
) {
  const declared: Record<string, { bun: unknown; raspd: unknown }> = {}
  const violations: string[] = []
  for (const [path, value] of raspd) {
    const capability = path.match(/\.capabilities\.(?:aspc\.)?([^.[\]]+)$/)?.[1]
    if (REFUSED_CAPABILITIES.some((key) => key === capability)) {
      const original = bun.get(path)
      if (original !== true || value !== false)
        violations.push(`${path}: expected Bun true and raspd false, got ${original}/${value}`)
      declared[path] = { bun: original, raspd: value }
      bun.delete(path)
      raspd.delete(path)
    } else if (/\.ops\[\d+\]\.supported$/.test(path)) {
      const op = raspd.get(path.replace(/supported$/, 'op'))
      const expected = !REFUSED_CAPABILITIES.some((key) => `aspc.${key}` === op)
      if (bun.has(path) || typeof op !== 'string' || value !== expected)
        violations.push(`${path}: invalid supported declaration for ${op}: ${value}`)
      declared[path] = { bun: undefined, raspd: value }
      raspd.delete(path)
    }
  }
  return { declared, violations }
}
