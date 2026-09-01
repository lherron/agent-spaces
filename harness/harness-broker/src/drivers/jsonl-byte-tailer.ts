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
/** Where a line sat in its file, for the raw record's `sourceCursor` (§7.1). */
export interface JsonlLineCursor {
  /** Byte offset of the line's first byte within the file. */
  byteOffset: number
  /** 1-based line ordinal within the CURRENT source epoch. */
  line: number
}

export interface JsonlByteOffsetTailer {
  /** The active file path, or undefined when none is set. */
  getActivePath(): string | undefined
  /**
   * Point the tailer at a new path and rewind offset/partial. No-op returning
   * `false` when the path is unchanged; returns `true` when it actually changed
   * (the caller resets its own per-line state on a true result). A real change
   * is a source-epoch boundary: byte offsets before and after it are not
   * comparable, so `onEpochChange` fires (§7.1).
   */
  retarget(path: string): boolean
  /** Forget the active path and rewind offset/partial. */
  clear(): void
  /**
   * Read newly appended bytes from the active file and invoke `onLine` once per
   * complete line, in order. Tolerates a missing/non-file path and truncation
   * (rewinds to 0 when the file shrinks below the offset); swallows IO errors.
   */
  readNewLines(onLine: (line: string, cursor: JsonlLineCursor) => void): void
}

export interface JsonlByteOffsetTailerOptions {
  /**
   * Called when the tailer starts a NEW source epoch: a different file, or the
   * active file shrinking below the recorded offset (replacement/truncation).
   * Cursor comparison is valid only within one epoch (§7.1), so a capture-aware
   * caller mints a new epoch id here.
   */
  onEpochChange?: ((reason: 'retarget' | 'truncated') => void) | undefined
}

export function createJsonlByteOffsetTailer(
  options: JsonlByteOffsetTailerOptions = {}
): JsonlByteOffsetTailer {
  const buffer = Buffer.alloc(64 * 1024)

  let activePath: string | undefined
  let offset = 0
  let partial = ''
  let lineOrdinal = 0

  const rewind = (): void => {
    offset = 0
    partial = ''
    lineOrdinal = 0
  }

  return {
    getActivePath(): string | undefined {
      return activePath
    },

    retarget(path: string): boolean {
      if (path === activePath) return false
      activePath = path
      rewind()
      options.onEpochChange?.('retarget')
      return true
    },

    clear(): void {
      activePath = undefined
      rewind()
    },

    readNewLines(onLine: (line: string, cursor: JsonlLineCursor) => void): void {
      if (activePath === undefined) return
      try {
        if (!existsSync(activePath)) return
        const stats = statSync(activePath)
        if (!stats.isFile()) return
        if (stats.size < offset) {
          // The file shrank under us: replaced or truncated. Byte offsets from
          // before this point address a different file, so this is a new epoch
          // and re-reading from 0 is a fresh read, not a duplicate.
          rewind()
          options.onEpochChange?.('truncated')
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
              // Offset of the line's FIRST byte. `offset` is the read cursor,
              // which has already advanced past everything still buffered in
              // `partial` — and `partial` still begins with this line, so the
              // line starts exactly one buffer-length back from the cursor.
              const byteOffset = offset - Buffer.byteLength(partial, 'utf8')
              partial = partial.slice(newlineIndex + 1)
              lineOrdinal += 1
              onLine(line, { byteOffset, line: lineOrdinal })
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
