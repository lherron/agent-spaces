import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Shared byte-offset JSONL tailer for the hook-driven transcript readers
 * (claude-code-tmux and codex-cli-tmux). Both readers tail an append-only
 * transcript file synchronously from hook processing: they remember a byte
 * offset, read newly appended bytes, buffer a trailing partial line, and emit
 * complete `\n`-terminated lines IN ORDER.
 *
 * Only the file-tailing mechanics are shared here. The per-line state machine
 * (what each line MEANS, and what events it produces) stays divergent and lives
 * in each reader, passed in as the `onLine` callback.
 */
export interface JsonlByteOffsetTailer {
  /** The active file path, or undefined when none is set. */
  getActivePath(): string | undefined
  /**
   * Point the tailer at a new path and rewind offset/partial. No-op returning
   * `false` when the path is unchanged; returns `true` when it actually changed
   * (the caller resets its own per-line state on a true result).
   */
  retarget(path: string): boolean
  /** Forget the active path and rewind offset/partial. */
  clear(): void
  /**
   * Read newly appended bytes from the active file and invoke `onLine` once per
   * complete line, in order. Tolerates a missing/non-file path and truncation
   * (rewinds to 0 when the file shrinks below the offset); swallows IO errors.
   */
  readNewLines(onLine: (line: string) => void): void
}

export function createJsonlByteOffsetTailer(): JsonlByteOffsetTailer {
  const buffer = Buffer.alloc(64 * 1024)

  let activePath: string | undefined
  let offset = 0
  let partial = ''

  const rewind = (): void => {
    offset = 0
    partial = ''
  }

  return {
    getActivePath(): string | undefined {
      return activePath
    },

    retarget(path: string): boolean {
      if (path === activePath) return false
      activePath = path
      rewind()
      return true
    },

    clear(): void {
      activePath = undefined
      rewind()
    },

    readNewLines(onLine: (line: string) => void): void {
      if (activePath === undefined) return
      try {
        if (!existsSync(activePath)) return
        const stats = statSync(activePath)
        if (!stats.isFile()) return
        if (stats.size < offset) {
          offset = 0
          partial = ''
        }
        if (stats.size === offset) return

        const fd = openSync(activePath, 'r')
        try {
          while (offset < stats.size) {
            const bytesToRead = Math.min(buffer.length, stats.size - offset)
            const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset)
            if (bytesRead <= 0) break
            offset += bytesRead
            partial += buffer.subarray(0, bytesRead).toString('utf8')

            let newlineIndex = partial.indexOf('\n')
            while (newlineIndex >= 0) {
              const line = partial.slice(0, newlineIndex)
              partial = partial.slice(newlineIndex + 1)
              onLine(line)
              newlineIndex = partial.indexOf('\n')
            }
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        return
      }
    },
  }
}
