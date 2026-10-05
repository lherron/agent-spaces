import { type FSWatcher, existsSync, watch } from 'node:fs'

export type TranscriptWatch = (
  path: string,
  options: { persistent: false },
  listener: () => void
) => FSWatcher

export interface ClaudeTranscriptWakeupOptions {
  /** Test seam for watcher error/re-arm lifecycle; production uses node:fs. */
  watch?: TranscriptWatch | undefined
  /** Read the transcript to EOF; called on every native change notification. */
  onChange: () => void
  /** The watcher failed past its one recovery; native wakeup is gone for good. */
  onLost: (path: string, detail: string) => void
}

export interface ClaudeTranscriptWakeup {
  /** Set when native wakeup was lost; the driver then refuses preempt/interrupt. */
  readonly lostReason: string | undefined
  /** Forget everything for a fresh invocation. */
  reset(): void
  /** SessionStart named the transcript; arm now when the file already exists. */
  select(path: string): void
  /** A hook proved the selected transcript exists; arm if not yet armed. */
  available(path: string): void
  close(): void
}

/**
 * Native fs wakeup for the Claude session JSONL. A watcher error re-arms once;
 * a second error (or any arm failure other than the expected lazy ENOENT at
 * SessionStart) degrades the seat to `native_wakeup_lost`.
 */
export function createClaudeTranscriptWakeup(
  options: ClaudeTranscriptWakeupOptions
): ClaudeTranscriptWakeup {
  const transcriptWatch: TranscriptWatch =
    options.watch ?? ((path, watchOptions, listener) => watch(path, watchOptions, listener))
  let watcher: FSWatcher | undefined
  let transcriptPath: string | undefined
  let recoveryUsed = false
  let lostReason: string | undefined

  function close(): void {
    watcher?.close()
    watcher = undefined
  }

  function degrade(path: string, error: unknown): void {
    if (lostReason !== undefined) return
    lostReason = 'native_wakeup_lost'
    close()
    options.onLost(path, error instanceof Error ? error.message : String(error))
  }

  function arm(path: string, phase: 'session-start' | 'hook' | 'rearm'): boolean {
    if (lostReason !== undefined || transcriptPath !== path || watcher !== undefined) {
      return watcher !== undefined
    }
    try {
      const armed = transcriptWatch(path, { persistent: false }, options.onChange)
      watcher = armed
      armed.on('error', (error) => {
        if (watcher !== armed || transcriptPath !== path) return
        armed.close()
        watcher = undefined
        if (recoveryUsed) {
          degrade(path, error)
          return
        }
        recoveryUsed = true
        if (arm(path, 'rearm')) options.onChange()
      })
      return true
    } catch (error) {
      // Claude names the eventual transcript path before creating the file.
      // That SessionStart ENOENT is an expected lazy-arm state, not capture
      // degradation and must never escape through the hook normalizer.
      if (phase === 'session-start' && isEnoent(error)) return false
      degrade(path, error)
      return false
    }
  }

  return {
    get lostReason() {
      return lostReason
    },
    reset() {
      close()
      transcriptPath = undefined
      recoveryUsed = false
      lostReason = undefined
    },
    select(path) {
      close()
      transcriptPath = path
      recoveryUsed = false
      if (existsSync(path)) arm(path, 'session-start')
    },
    available(path) {
      if (transcriptPath === path && watcher === undefined) arm(path, 'hook')
    },
    close,
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
