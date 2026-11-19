import type { EventProvenance } from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import type { DriverContext } from '../driver'
import { asRecord, getNumber, getString } from '../hook-json'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { ANTIGRAVITY_DRIVER_KIND } from './launch'

export type TranscriptRow = {
  step: number
  type: string
  source?: string | undefined
  time?: string | undefined
  content?: string | undefined
  error?: string | undefined
  status?: string | undefined
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  model?: string | undefined
}

export function framedUserRequest(content: string | undefined): string | undefined {
  return content?.match(/^<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>(?:\n|$)/u)?.[1]
}

export function stopContinuationText(content: string | undefined): string | undefined {
  return content?.match(
    /\n<SYSTEM_MESSAGE>\nStop hook blocked termination: ([\s\S]*?)\n<\/SYSTEM_MESSAGE>$/u
  )?.[1]
}

export function createAntigravityTranscript(ctx: DriverContext) {
  const tailer = createJsonlByteOffsetTailer({
    onEpochChange() {
      const path = tailer.getActivePath()
      if (path !== undefined) ctx.capture?.rotateEpoch(path)
    },
  })
  // PreInvocation reports the count including the just-submitted prompt.
  // On resume this skips old rows while keeping the first new user message.
  let lastStep = -1
  return {
    get nextStep() {
      return lastStep + 1
    },
    drain(
      path: string,
      firstStep: number,
      observe: (row: TranscriptRow, provenance?: EventProvenance) => void
    ) {
      if (tailer.retarget(path)) lastStep = firstStep - 1
      tailer.readNewLines((line, cursor) => {
        let value: Record<string, unknown>
        try {
          value = asRecord(JSON.parse(line))
        } catch {
          return
        }
        const step = getNumber(value, 'step_index')
        const type = getString(value, 'type')
        if (step === undefined || type === undefined || step <= lastStep) return
        lastStep = step
        const row: TranscriptRow = {
          step,
          type,
          source: getString(value, 'source'),
          time: getString(value, 'created_at'),
          content: getString(value, 'content'),
          error: getString(value, 'error'),
          status: getString(value, 'status'),
          inputTokens: getNumber(value, 'input_tokens'),
          outputTokens: getNumber(value, 'output_tokens'),
          cacheReadTokens: getNumber(value, 'cache_read_tokens'),
          model: getString(value, 'model'),
        }
        const normalize = (provenance?: EventProvenance): NormalizeOutcome => {
          observe(row, provenance)
          return { disposition: 'normalized' }
        }
        if (ctx.capture === undefined) {
          normalize()
        } else {
          ctx.capture.ingest(
            {
              provider: 'google',
              driverKind: ANTIGRAVITY_DRIVER_KIND,
              sourceKind: 'provider-jsonl',
              sourceKey: path,
              sourceCursor: { ...cursor },
              nativeType: type,
              nativeId: String(step),
              rawBytes: Buffer.from(line),
            },
            (record) => normalize(record.provenance())
          )
        }
      })
    },
  }
}
