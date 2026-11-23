import { existsSync, utimesSync } from 'node:fs'

/**
 * Keep a live seat's regular files in the broker's /private/tmp namespace from
 * aging out.
 *
 * macOS runs /usr/libexec/tmp_cleaner nightly (launchd com.apple.tmp_cleaner),
 * which deletes regular files under /tmp whose atime, mtime and ctime are all
 * more than three days old. Sockets and symlinks survive. Without this, a
 * codex-tui seat older than three days loses its attach token, rollout marker
 * and hook script while its sockets live on, and the next attach shows a blank
 * pane. Touching the files while the broker lives keeps them; a dead seat's
 * files still age out on their own, which is the cleanup we want.
 *
 * A file that is already gone is rewritten through its `restore`, when the
 * entry has one and it can still say what to write.
 */
export type TmpKeepaliveEntry = {
  path: () => string | undefined
  restore?: (path: string) => Promise<void>
}

export type TmpKeepalive = { stop(): void; tick(): Promise<void> }

export const TMP_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000

export function startTmpKeepalive(
  entries: readonly TmpKeepaliveEntry[],
  intervalMs = TMP_KEEPALIVE_INTERVAL_MS
): TmpKeepalive {
  const tick = async (): Promise<void> => {
    const now = new Date()
    for (const entry of entries) {
      const path = entry.path()
      if (path === undefined) continue
      try {
        if (existsSync(path)) utimesSync(path, now, now)
        else await entry.restore?.(path)
      } catch {
        // Best effort: the next tick tries again.
      }
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
