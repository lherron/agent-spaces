import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Shared byte-offset JSONL tailer for the Claude and Codex transcript readers.
 * Both readers tail an append-only transcript file synchronously when their
 * serialized intake asks for a read: they remember a byte offset, read newly
 * appended bytes, buffer a trailing partial line, and emit complete
 * `\n`-terminated lines IN ORDER.
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
   * Point the tailer at a new path and rewind offset/partial. `startAtEnd`
   * snapshots an existing file's EOF as the epoch origin, so a resumed session
   * ignores history while retaining every row appended after this call. No-op
   * returning `false` when the path is unchanged; returns `true` when it
   * actually changed (the caller resets its own per-line state on a true
   * result). A real change is a source-epoch boundary: byte offsets before and
   * after it are not comparable, so `onEpochChange` fires (§7.1).
   */
  retarget(path: string, options?: { startAtEnd?: boolean | undefined }): boolean
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
   * Called when the tailer starts a NEW source epoch: a different file
   * (`retarget`), the active file shrinking below the recorded offset
   * (`truncated`), or the bytes BEHIND the recorded offset no longer matching
   * what was read from them (`replaced` — a truncate-and-rewrite that grew back
   * past the offset before the next read). Cursor comparison is valid only
   * within one epoch (§7.1), so a capture-aware caller mints a new epoch id here.
   */
  onEpochChange?: ((reason: 'retarget' | 'truncated' | 'replaced') => void) | undefined
}

/**
 * How many bytes immediately BEHIND the cursor are remembered to detect a file
 * replaced under the tailer. Small enough to be a free pread, long enough that
 * two different rollout rows cannot share it by accident.
 */
const REPLACEMENT_ANCHOR_BYTES = 64

export function createJsonlByteOffsetTailer(
  options: JsonlByteOffsetTailerOptions = {}
): JsonlByteOffsetTailer {
  const buffer = Buffer.alloc(64 * 1024)

  let activePath: string | undefined
  let offset = 0
  let partial = ''
  let lineOrdinal = 0
  /**
   * The last {@link REPLACEMENT_ANCHOR_BYTES} bytes this tailer actually read.
   * `size < offset` catches a file that is still short when we next look; it
   * does NOT catch one that was truncated and rewritten past the old offset in
   * between, which reads as a mid-line fragment followed by silently skipped
   * rows. Re-checking these bytes catches that, and costs one small pread per
   * read (§14 row 5).
   */
  let anchor = Buffer.alloc(0)

  const rewind = (): void => {
    offset = 0
    partial = ''
    lineOrdinal = 0
    anchor = Buffer.alloc(0)
  }

  /** Snapshot the current EOF, including its replacement-detection anchor. */
  const seekToEnd = (path: string): void => {
    try {
      const fd = openSync(path, 'r')
      try {
        // fstat the opened descriptor so the EOF and anchor come from the same
        // file even if the path is atomically replaced during SessionStart.
        const stats = fstatSync(fd)
        if (!stats.isFile()) return
        offset = stats.size
        if (offset === 0) return
        const anchorLength = Math.min(REPLACEMENT_ANCHOR_BYTES, offset)
        const seededAnchor = Buffer.alloc(anchorLength)
        const bytesRead = readSync(fd, seededAnchor, 0, anchorLength, offset - anchorLength)
        if (bytesRead === anchorLength) anchor = seededAnchor
      } finally {
        closeSync(fd)
      }
    } catch {
      // Match readNewLines' tolerant IO contract. A missing/unreadable resume
      // target remains at byte zero and can still appear lazily.
      rewind()
    }
  }

  /** True when the bytes behind the cursor are no longer the ones we read. */
  const anchorBroken = (path: string): boolean => {
    if (anchor.length === 0 || offset < anchor.length) return false
    const fd = openSync(path, 'r')
    try {
      const probe = Buffer.alloc(anchor.length)
      const read = readSync(fd, probe, 0, anchor.length, offset - anchor.length)
      return read !== anchor.length || !probe.equals(anchor)
    } catch {
      return false
    } finally {
      closeSync(fd)
    }
  }

  return {
    getActivePath(): string | undefined {
      return activePath
    },

    retarget(path: string, retargetOptions = {}): boolean {
      if (path === activePath) return false
      activePath = path
      rewind()
      if (retargetOptions.startAtEnd === true) seekToEnd(path)
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
        } else if (anchorBroken(activePath)) {
          // Truncated and rewritten PAST the old offset before we looked. The
          // size check cannot see this; continuing from the old offset would
          // hand the caller a mid-line fragment and drop everything before it.
          rewind()
          options.onEpochChange?.('replaced')
        }
        if (stats.size === offset) return

        const fd = openSync(activePath, 'r')
        try {
          while (offset < stats.size) {
            const bytesToRead = Math.min(buffer.length, stats.size - offset)
            const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset)
            if (bytesRead <= 0) break
            offset += bytesRead
            const chunk = buffer.subarray(0, bytesRead)
            anchor =
              chunk.length >= REPLACEMENT_ANCHOR_BYTES
                ? Buffer.from(chunk.subarray(chunk.length - REPLACEMENT_ANCHOR_BYTES))
                : Buffer.concat([anchor, chunk]).subarray(-REPLACEMENT_ANCHOR_BYTES)
            partial += chunk.toString('utf8')

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
