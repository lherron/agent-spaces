/** Compare a scenario's normalized event stream with its committed golden JSONL. */
import { expect } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { goldenDir, repoRoot } from './fake-codex-scenario'

function normalizeEvent(event: InvocationEventEnvelope): InvocationEventEnvelope {
  const stableEvent = structuredClone(event)
  if (stableEvent.type === 'turn.started') {
    // The delivery response and the matching native notification can win the
    // dedupe race in either order. Both carry the same provider turn id; keep
    // goldens focused on that contract rather than scheduling provenance.
    stableEvent.driver = undefined
    stableEvent.provenance = {
      sourceKind: 'provider-jsonrpc',
      normalizer: { name: 'codex-app-server', version: '0.1.0' },
    }
    stableEvent.payload = { turnId: stableEvent.turnId ?? stableEvent.payload.turnId }
  }
  return JSON.parse(
    JSON.stringify(stableEvent, (key, value) => {
      if (key === 'time') return '<time>'
      if (key === 'pid') return '<pid>'
      // The source epoch is a freshly minted uuid per JSON-RPC connection
      // (§7.1). Its VALUE is not a contract; that every provider-observed event
      // carries one, and that it is stable within a run, is — asserted
      // directly in the capture tests rather than baked into a golden.
      if (key === 'sourceEpoch') return '<epoch>'
      // Raw frames can contain the checkout cwd. The journal hash is still
      // asserted by capture tests; golden event projections must be portable.
      if (key === 'rawSha256') return '<rawSha256>'
      if (key === 'durationMs') return '<durationMs>'
      if (key === 'command' && value === process.execPath) return '<bun>'
      if (typeof value === 'string' && value.startsWith(`${repoRoot}/`)) {
        return `<cwd>/${value.slice(repoRoot.length + 1)}`
      }
      if (key === 'cwd' && value === repoRoot) return '<cwd>'
      if (
        key === 'artifactPath' &&
        typeof value === 'string' &&
        value.endsWith('.provider-transcript.jsonl')
      ) {
        // Golden files assert the event contract, not the account-specific
        // temp root. The dedicated fallback-root test owns that seam.
        return join('/tmp/spaces-harness-broker-provider-transcripts', basename(value))
      }
      return value
    })
  ) as InvocationEventEnvelope
}

export async function expectGolden(
  scenario: string,
  events: InvocationEventEnvelope[]
): Promise<void> {
  const normalized = events.map(normalizeEvent)
  const executed = normalized.filter((event) => event.type === 'submission.executed')
  const canonicalOrder: InvocationEventEnvelope[] = normalized.filter(
    (event) => event.type !== 'submission.executed'
  )
  for (const disposition of executed) {
    const bracketIndex = canonicalOrder.findIndex(
      (event) => event.type === 'turn.started' && event.turnId === disposition.turnId
    )
    // A provider can flush turn/started in the same stdout batch as the
    // turn/start response. Which process consumes its continuation first is
    // not contractual; identity and uniqueness are. Canonicalize the broker
    // disposition immediately behind its matching bracket for golden files.
    canonicalOrder.splice(
      bracketIndex >= 0 ? bracketIndex + 1 : canonicalOrder.length,
      0,
      disposition
    )
  }
  canonicalOrder.forEach((event, index) => {
    event.seq = index + 1
  })
  const actual = `${canonicalOrder.map((event) => JSON.stringify(event)).join('\n')}\n`
  const goldenPath = join(goldenDir, `${scenario}.golden.jsonl`)
  // Set UPDATE_GOLDEN=1 to regenerate fixtures after a deliberate contract change.
  if (process.env['UPDATE_GOLDEN'] === '1') {
    await writeFile(goldenPath, actual)
    return
  }
  const expected = await readFile(goldenPath, 'utf8')
  expect(actual).toBe(expected)
}
