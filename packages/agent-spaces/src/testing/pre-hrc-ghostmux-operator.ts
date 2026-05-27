/**
 * Reusable ghostmux operator-drive primitives (T-01667).
 *
 * Holds the operator-drive logic (formerly the standalone phase5 ghostmux-attach
 * gate, now retired) so the matrix `claude-tmux-ghostmux` row drives a real
 * Ghostty surface the SAME way an operator does: literal text -> 250ms pause ->
 * separate Enter (the canonical hrc-runtime idiom that defeats Claude's TUI
 * paste-burst classifier, which would otherwise swallow the Enter). No
 * harness-broker internals here, so it stays inside the contract-harness
 * boundary surface.
 */
import { existsSync, readFileSync } from 'node:fs'

export type ExecResult = { code: number; stdout: string; stderr: string }

export async function exec(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

export async function ghostmux(bin: string, gmuxArgs: string[]): Promise<ExecResult> {
  return exec([bin, ...gmuxArgs])
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export async function pollUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 1_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

export type TurnCounts = { promptSubmits: number; stops: number; total: number }

/**
 * Count REAL hook-originated turn boundaries in a streamed events ledger:
 * turn.started carrying a UserPromptSubmit rawType, and turn.completed carrying
 * a Stop rawType. Operator-typed turns therefore show up as deltas above the
 * scripted baseline.
 */
export function countTurnEvents(eventsPath: string): TurnCounts {
  let promptSubmits = 0
  let stops = 0
  let total = 0
  const raw = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : ''
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    total += 1
    let ev: { type?: string; driver?: { rawType?: string } }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const rawType = ev.driver?.rawType
    if (ev.type === 'turn.started' && rawType === 'UserPromptSubmit') promptSubmits += 1
    if (ev.type === 'turn.completed' && rawType === 'Stop') stops += 1
  }
  return { promptSubmits, stops, total }
}

/** Check the Ghostty API is reachable (else callers SKIP cleanly). */
export async function ghostmuxAvailable(
  bin: string
): Promise<{ available: boolean; reason: string }> {
  const status = await ghostmux(bin, ['status']).catch((e) => ({
    code: 1,
    stdout: '',
    stderr: String(e),
  }))
  if (status.code === 0 && /available:\s*true/i.test(status.stdout)) {
    return { available: true, reason: 'ghostmux status available: true' }
  }
  return {
    available: false,
    reason: `ghostmux status not available (${status.stdout.trim() || status.stderr.trim() || `exit ${status.code}`})`,
  }
}

/** Wait for the live Claude prompt glyph to render in the attached pane. */
export async function waitForClaudePrompt(
  bin: string,
  surfaceId: string,
  timeoutMs: number
): Promise<boolean> {
  return pollUntil(
    async () => {
      const cap = await ghostmux(bin, ['capture-pane', '-t', surfaceId])
      return cap.code === 0 && cap.stdout.includes('❯')
    },
    timeoutMs,
    1_000
  )
}

/**
 * Drive a single operator turn into a Ghostty surface: literal text, PAUSE,
 * then a separate Enter. The pause is mandatory — Claude's TUI classifies a
 * text+Enter burst as a paste and swallows the Enter.
 */
export async function driveOperatorTurn(
  bin: string,
  surfaceId: string,
  prompt: string,
  enterDelayMs: number
): Promise<void> {
  await ghostmux(bin, ['send-keys', '-t', surfaceId, '-l', '--no-enter', prompt])
  await sleep(enterDelayMs)
  await ghostmux(bin, ['send-key', '-t', surfaceId, 'Enter'])
}

export async function capturePane(bin: string, surfaceId: string): Promise<string> {
  const cap = await ghostmux(bin, ['capture-pane', '-t', surfaceId])
  return cap.code === 0 ? cap.stdout : ''
}
