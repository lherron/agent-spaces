import type { UsageUpdatedPayload } from 'spaces-harness-broker-protocol'
import { asRecord, getString } from '../hook-json'
import { claudeUsageContext } from '../usage-context'

/**
 * Native type of the record the materialized `statusline.sh` posts through the
 * hook bridge (T-10929). Claude Code's statusLine input carries no
 * `hook_event_name`, so the bridge names it on the envelope instead and the
 * committed raw bytes stay the statusline JSON verbatim.
 */
export const CLAUDE_STATUS_LINE_RECORD = 'StatusLine'

/**
 * Launch env var holding the full bridge command line `statusline.sh` pipes its
 * stdin through. Absent outside a broker-launched Claude, which keeps the
 * script's behavior byte-identical there.
 */
export const CLAUDE_STATUS_LINE_BRIDGE_ENV = 'HARNESS_BROKER_STATUSLINE_BRIDGE'

/**
 * Claude Code's statusline input is the ONE source of the Claude context
 * reading (T-10929): both the fill (`current_usage`, summed exactly as the
 * transcript row's usage was under T-10927) and the window
 * (`context_window_size`). Claude re-renders the statusline far more often than
 * the reading changes, so a record mints `usage.updated` only when it carries a
 * fill and `(usedTokens, windowTokens, model.id)` differs from the last reading
 * this reader minted. Everything else is state-only.
 *
 * State depends only on earlier StatusLine records, so replaying the committed
 * records in commit order mints the same readings.
 */
export interface ClaudeStatusLineReader {
  /** The payload to mint for one StatusLine record, or undefined (state-only). */
  observe(raw: unknown): UsageUpdatedPayload | undefined
}

export function createClaudeStatusLineReader(): ClaudeStatusLineReader {
  let lastMintedKey: string | undefined
  return {
    observe(raw) {
      const record = asRecord(raw)
      const contextWindow = asRecord(record['context_window'])
      const context = claudeUsageContext(
        contextWindow['current_usage'],
        contextWindow['context_window_size']
      )
      if (context === undefined) return undefined
      const modelId = getString(asRecord(record['model']), 'id')
      const model = modelId !== undefined && modelId.length > 0 ? modelId : undefined
      const key = JSON.stringify([context.usedTokens, context.windowTokens ?? null, model ?? null])
      if (key === lastMintedKey) return undefined
      lastMintedKey = key
      return {
        usage: record['context_window'],
        ...(model !== undefined
          ? { model: { id: model, source: 'provider-response' as const } }
          : {}),
        context,
      }
    },
  }
}
