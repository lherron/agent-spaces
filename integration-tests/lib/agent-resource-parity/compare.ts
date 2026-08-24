import { createHash } from 'node:crypto'

import type { ParityMismatch, ResourceProjection } from './types.js'

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left !== undefined && right !== undefined && Buffer.compare(left, right) === 0
}

function byteDiagnostic(left: Uint8Array | undefined, right: Uint8Array | undefined): string {
  const a = left ?? new Uint8Array()
  const b = right ?? new Uint8Array()
  const index = Math.min(a.length, b.length)
  let differing = index
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) {
      differing = i
      break
    }
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  return `bytes differ at ${differing}; left length=${a.length} sha256=${hash(a)}, right length=${b.length} sha256=${hash(b)}`
}

export function compareProjections(
  left: ResourceProjection,
  right: ResourceProjection
): ParityMismatch[] {
  const mismatches: ParityMismatch[] = []
  const fail = (path: string, message: string) =>
    mismatches.push({ agentId: left.agentId, mode: left.mode, path, message })
  if (left.agentId !== right.agentId || left.mode !== right.mode) fail('.', 'row identity differs')
  if (left.prompt.mode !== right.prompt.mode)
    fail('prompt/mode.txt', `${left.prompt.mode} != ${right.prompt.mode}`)
  if (!bytesEqual(left.prompt.content, right.prompt.content))
    fail('prompt/content.bin', byteDiagnostic(left.prompt.content, right.prompt.content))
  if (left.reminder.present !== right.reminder.present)
    fail('reminder/presence.txt', `${left.reminder.present} != ${right.reminder.present}`)
  if (left.reminder.present && !bytesEqual(left.reminder.content, right.reminder.content))
    fail('reminder/content.bin', byteDiagnostic(left.reminder.content, right.reminder.content))
  const leftCatalog = JSON.stringify(left.skills.catalog)
  const rightCatalog = JSON.stringify(right.skills.catalog)
  if (leftCatalog !== rightCatalog) fail('skills/catalog.json', 'catalog differs')
  if (!bytesEqual(left.skills.catalogText, right.skills.catalogText))
    fail('skills/catalog.txt', byteDiagnostic(left.skills.catalogText, right.skills.catalogText))
  const names = [
    ...new Set([...left.skills.packages.keys(), ...right.skills.packages.keys()]),
  ].sort()
  for (const name of names) {
    const a = JSON.stringify(left.skills.packages.get(name), (_, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value
    )
    const b = JSON.stringify(right.skills.packages.get(name), (_, value) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value
    )
    if (a !== b) fail(`skills/packages/${name}`, 'selected package tree differs')
  }
  return mismatches
}
