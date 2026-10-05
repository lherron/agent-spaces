/**
 * Turn progress cards — plan, diff and reasoning summaries — carried as
 * `diagnostic` events discriminated by `kind`, so the renderer gets structure
 * without a protocol event type of its own.
 */
import type { MappedEvent } from './event-map'
import { asRecord, asTurnId, stringValue } from './native-params'

interface DiffFileStat {
  path: string
  added: number
  removed: number
}

interface DiffSummary {
  files: DiffFileStat[]
  totalAdded: number
  totalRemoved: number
  /** Files beyond the per-summary cap, elided from `files`. */
  truncated: number
}

const MAX_DIFF_FILES = 8

/**
 * Reasoning summaries are durable churn-forensics evidence, not a token stream.
 * Keep one bounded summary per completed reasoning item: enough to explain the
 * model's next action without turning the broker ledger into a second rollout.
 */
const MAX_REASONING_SUMMARY_PARTS = 8
const MAX_REASONING_SUMMARY_CHARS = 4_096

/**
 * Summarize a unified diff into compact per-file add/remove counts. Only the
 * `diff --git` file boundaries and `+`/`-` body lines are counted; the `+++`/
 * `---` headers and hunk markers are excluded. The full diff body is discarded —
 * only counts survive, keeping the derived event payload small.
 */
function summarizeUnifiedDiff(diff: string): DiffSummary {
  const files: DiffFileStat[] = []
  let current: DiffFileStat | undefined
  let totalAdded = 0
  let totalRemoved = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = /[ ]b\/(.+)$/.exec(line)
      current = { path: match?.[1] ?? 'file', added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      current.added += 1
      totalAdded += 1
    } else if (line.startsWith('-')) {
      current.removed += 1
      totalRemoved += 1
    }
  }
  return {
    files: files.slice(0, MAX_DIFF_FILES),
    totalAdded,
    totalRemoved,
    truncated: Math.max(0, files.length - MAX_DIFF_FILES),
  }
}

/**
 * The last diff summary emitted per turn, so an unchanged repeat can be dropped
 * (T-06350). Keyed by turnId and cleared on `turn/started`, so each turn always
 * renders its first diff even if it happens to match the previous turn's last.
 */
export type LastDiffSignatures = Map<string, string>

/**
 * `turn/diff/updated` → a compact per-file filestat card, deduped per turn.
 *
 * Codex sends this event carrying a CUMULATIVE snapshot of the whole turn's diff
 * rather than a delta, and re-sends it unchanged on every
 * `account/rateLimits/updated` telemetry heartbeat. Measured over the largest real
 * captured transcripts: of 992 fires, the 822 that followed a heartbeat carried a
 * byte-identical diff (100%), while the 170 that followed an actual
 * `item/completed(fileChange)` carried none (0%). Mapping each fire repainted the
 * same card down the pane (T-06350).
 *
 * Dedupe on the SUMMARY rather than on which method preceded the event: it states
 * the real invariant — never emit a card that says nothing new — and it does not
 * couple us to a heartbeat-pairing detail of a provider we do not control. It also
 * correctly drops the case where the diff body moved but the rendered `+/-` stats
 * did not (an in-place edit at equal line counts), where the card would be identical.
 */
export function mapDiffUpdated(
  params: Record<string, unknown>,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const diff = stringValue(params['diff'])
  if (diff === undefined || diff.trim().length === 0) return []
  const summary = summarizeUnifiedDiff(diff)
  if (summary.files.length === 0) return []
  const turnId = stringValue(params['turnId']) ?? ''
  const signature = JSON.stringify(summary)
  if (lastDiffSignatures.get(turnId) === signature) return []
  lastDiffSignatures.set(turnId, signature)
  // Only the compact per-file +/- summary is carried (never the full diff body), so
  // the payload stays small and survives event-size truncation.
  return [
    {
      type: 'diagnostic',
      payload: {
        level: 'info',
        source: 'driver',
        kind: 'diff',
        message: `diff updated (${summary.files.length} file${summary.files.length === 1 ? '' : 's'}, +${summary.totalAdded} -${summary.totalRemoved})`,
        data: summary,
      },
    },
  ]
}

function normalizeReasoningSummary(
  item: Record<string, unknown>
): { summary: string; truncated: boolean } | undefined {
  const rawSummary = item['summary']
  if (!Array.isArray(rawSummary)) return undefined

  const parts = rawSummary.flatMap((part) => {
    const text = stringValue(part)?.trim()
    return text !== undefined && text.length > 0 ? [text] : []
  })
  if (parts.length === 0) return undefined

  const selected = parts.slice(0, MAX_REASONING_SUMMARY_PARTS)
  const joined = selected.join('\n\n')
  const truncated = parts.length > selected.length || joined.length > MAX_REASONING_SUMMARY_CHARS
  return {
    summary: joined.slice(0, MAX_REASONING_SUMMARY_CHARS),
    truncated,
  }
}

/** `turn/plan/updated` → a checklist card of `{ step, status }`. */
export function mapPlanUpdated(params: Record<string, unknown>): MappedEvent[] {
  const rawPlan = params['plan']
  const steps = Array.isArray(rawPlan)
    ? rawPlan.flatMap((entry) => {
        const rec = asRecord(entry)
        const step = stringValue(rec['step'])
        return step !== undefined ? [{ step, status: stringValue(rec['status']) ?? 'pending' }] : []
      })
    : []
  if (steps.length === 0) return []
  const explanation = stringValue(params['explanation'])
  // Routed through `diagnostic` (no strict payload validator) rather than a
  // new protocol event type, so the renderer gets the structured plan without
  // a cross-repo protocol bump. `kind` discriminates it from a log line.
  return [
    {
      type: 'diagnostic',
      payload: {
        level: 'info',
        source: 'driver',
        kind: 'plan',
        message: `plan updated (${steps.length} step${steps.length === 1 ? '' : 's'})`,
        data: { steps, ...(explanation !== undefined ? { explanation } : {}) },
      },
    },
  ]
}

/** A completed `reasoning` item → its bounded summary, when it has one. */
export function mapReasoningItem(
  item: Record<string, unknown>,
  turnId: string,
  itemId: string
): MappedEvent[] {
  const summary = normalizeReasoningSummary(item)
  if (summary === undefined) return []
  return [
    {
      type: 'diagnostic',
      payload: {
        level: 'debug',
        source: 'driver',
        kind: 'reasoning',
        message: 'Codex reasoning summary captured',
        data: summary,
      },
      extra: { turnId: asTurnId(turnId), itemId },
    },
  ]
}
