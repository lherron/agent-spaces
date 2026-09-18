import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import type { JsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { type MuseCliTmuxLogEventNormalizer, parseMuseSessionLine } from './log-events'

export interface MuseCliSessionTranscriptReader {
  /** Discover the session log (or keep waiting) and emit new envelopes. */
  poll(): InvocationEventEnvelope[]
  reset(): void
}

export interface MuseCliSessionTranscriptReaderOptions {
  /** `<home>/.local/share/muse` — sessions live under `<dataDir>/sessions/`. */
  dataDir: string
  normalizer: MuseCliTmuxLogEventNormalizer
  tailer?: JsonlByteOffsetTailer | undefined
}

/**
 * Locate this invocation's `session.jsonl`. The TUI takes no `--session-id`,
 * so with a per-invocation isolated HOME the sessions tree holds exactly one
 * session. Returns undefined until the TUI has booted far enough to create
 * it (the driver keeps polling); when several appear it holds its first
 * choice rather than flapping between logs.
 */
export function discoverMuseSessionLog(
  dataDir: string,
  stickyPath?: string | undefined
): string | undefined {
  if (stickyPath !== undefined) return stickyPath
  const root = join(dataDir, 'sessions')
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const path = join(dir, entry)
      if (entry === 'session.jsonl') {
        try {
          if (statSync(path).isFile()) found.push(path)
        } catch {
          continue
        }
        continue
      }
      walk(path, depth + 1)
    }
  }
  walk(root, 0)
  if (found.length === 0) return undefined
  found.sort()
  return found[0]
}

export function createMuseCliSessionTranscriptReader(
  options: MuseCliSessionTranscriptReaderOptions
): MuseCliSessionTranscriptReader {
  const tailer = options.tailer ?? createJsonlByteOffsetTailer()
  let stickyPath: string | undefined

  return {
    poll(): InvocationEventEnvelope[] {
      const path = discoverMuseSessionLog(options.dataDir, stickyPath)
      if (path === undefined) return []
      if (stickyPath === undefined) {
        stickyPath = path
        tailer.retarget(path)
      }
      const out: InvocationEventEnvelope[] = []
      tailer.readNewLines((line) => {
        for (const record of parseMuseSessionLine(line)) {
          out.push(...options.normalizer.normalizeRecord(record))
        }
      })
      return out
    },

    reset(): void {
      stickyPath = undefined
      tailer.clear()
    },
  }
}
