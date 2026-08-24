import { compareProjections } from './compare.js'
import type { ResourceProjection } from './types.js'

/**
 * Compare rows in stable agent/mode order. Every mismatch is retained; no row
 * can make another row pass and there is intentionally no bless/skip path.
 */
export function verifyParityRows(
  rows: readonly { compiler: ResourceProjection; sdk: ResourceProjection }[]
): void {
  const mismatches = rows
    .flatMap(({ compiler, sdk }) => compareProjections(compiler, sdk))
    .sort((a, b) => {
      const left = `${a.agentId}\0${a.mode}\0${a.path}`
      const right = `${b.agentId}\0${b.mode}\0${b.path}`
      return left < right ? -1 : left > right ? 1 : 0
    })
  if (mismatches.length === 0) return
  throw new Error(
    mismatches
      .map(({ agentId, mode, path, message }) => `[${agentId}/${mode}] ${path}: ${message}`)
      .join('\n')
  )
}
