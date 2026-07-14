import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { shellQuote } from '../tmux-shared'
import {
  type CodexTranscriptModel,
  type CodexTranscriptWidth,
  createCodexTranscriptModel,
} from './transcript'

/**
 * T-04906 / T-04909 Phase B — the Codex app-server operator renderer.
 *
 * The renderer is a DRIVER-OWNED presentation process launched into the
 * HRC-leased `tmux-tui` pane. Its single source of truth is the broker's
 * DURABLE read surface (daedalus Q1 ruling): it bootstraps from
 * `invocation.eventsSince`, then consumes live `invocation.event`
 * notifications. It is NOT fed a driver-pushed private event stream, so its
 * output stays coherent with HRC durable attach/replay semantics. The
 * app-server JSON-RPC stdio child remains the authoritative harness transport;
 * the renderer never replaces it and never routes through `codex-cli-tmux`.
 */

export interface RendererEventsSinceRequest {
  invocationId: string
  afterSeq: number
}

export interface RendererEventsSinceResponse {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq?: number | undefined
}

/**
 * The durable broker read surface the renderer projects from. Backed in
 * production by the read-only observer/broker JSON-RPC socket (`eventsSince` +
 * the `invocation.event` notification stream); backed in tests by an in-memory
 * fake. It is deliberately read-only — mutation (e.g. Phase C `/quit`) does NOT
 * flow through here.
 */
export interface RendererDurableReadSurface {
  eventsSince: (request: RendererEventsSinceRequest) => Promise<RendererEventsSinceResponse>
  observe: (handler: (event: InvocationEventEnvelope) => void) => { close: () => void }
}

export interface RendererProjection {
  /** Bootstrap from `eventsSince`, then stream live `invocation.event`. */
  start: () => Promise<void>
  /** The rendered transcript lines, in seq order. */
  lines: () => string[]
  /**
   * Re-render everything seen so far, at whatever the width source now reports
   * (T-06365).
   *
   * A row is styled once, when it is committed, and a terminal keeps the cells it
   * was given — so every measure baked into a row is frozen at its write-time pane
   * width. The renderer is exec'd into a pane that is commonly still at tmux's
   * 80-column default and is widened moments later when a client attaches, which
   * left the whole priming block wrapped to ~78 columns and tinted only that far
   * into a much wider pane, while everything written after the attach reached the
   * edge (the T-06343 caveat). No fill strategy can fix an already-committed row;
   * the row has to be rendered again.
   *
   * Replaying the retained history through a FRESH transcript model reproduces the
   * pane exactly, because the model is a deterministic fold over the event stream
   * given a width. The CALLER is responsible for clearing the pane (and its
   * scrollback) first — this only re-emits.
   */
  redraw: () => void
  close: () => void
}

export interface RendererProjectionOptions {
  invocationId: string
  readSurface: RendererDurableReadSurface
  /** Optional side-channel for each rendered line (e.g. write to the pane). */
  sink?: (line: string) => void
  /** Emit ANSI colour (default false — enable on a TTY pane). */
  color?: boolean | undefined
  /**
   * Pane width, or a thunk resolved per row. Drives BOTH prose wrap (clamped for
   * readability, default 96) and how far a tinted band fills (unclamped — the real
   * pane). Pass a thunk from a live pane so a resize after launch is picked up.
   */
  width?: CodexTranscriptWidth | undefined
  /**
   * Called once per accepted event, AFTER its transcript lines are emitted, in the
   * same seq order and with the same dedup as the transcript itself (T-06365).
   * Exists so a pane-level presentation concern — the live status row — can follow
   * the invocation's state without opening a second subscription to the read
   * surface, which would reintroduce exactly the replay/live ordering gap this
   * projection exists to close. Observation only: it must not emit lines.
   */
  onEvent?: ((event: InvocationEventEnvelope) => void) | undefined
}

/**
 * Build the durable-read projection for one invocation. Live subscription is
 * established BEFORE the `eventsSince` bootstrap so no event slips through the
 * gap between the replay snapshot and the live stream; any replay/live overlap
 * (and any out-of-order live arrival during bootstrap) is reconciled by seq so
 * output is de-duplicated and strictly seq-ordered.
 */
export function createCodexAppServerRendererProjection(
  options: RendererProjectionOptions
): RendererProjection {
  const { invocationId, readSurface, sink } = options
  const lines: string[] = []
  const seenSeqs = new Set<number>()
  let bootstrapping = true
  const deferredLive: InvocationEventEnvelope[] = []
  let subscription: { close: () => void } | undefined
  let closed = false

  /**
   * Everything committed to the pane, in the order it was committed, so a redraw
   * can reproduce it at a new width. Read failures are retained ALONGSIDE the
   * events rather than in a side list: they must survive a redraw (a retention gap
   * is never silently dropped — daedalus invariant), and only an ordered log keeps
   * one sitting where it actually happened.
   */
  type HistoryEntry =
    | { kind: 'event'; event: InvocationEventEnvelope }
    | { kind: 'readFailure'; text: string }
  const history: HistoryEntry[] = []

  function pushLine(line: string): void {
    lines.push(line)
    sink?.(line)
  }

  // The presentation layer: folds the durable event stream into an
  // hrcchat-turn-style transcript (palette + glyphs + rail, assistant deltas
  // coalesced, tool calls grouped). The projection owns ordering/dedup; the
  // model owns styling.
  const buildTranscript = (): CodexTranscriptModel =>
    createCodexTranscriptModel({
      invocationId,
      emit: pushLine,
      ...(options.color !== undefined ? { color: options.color } : {}),
      ...(options.width !== undefined ? { width: options.width } : {}),
    })

  let transcript = buildTranscript()

  function applyEntry(entry: HistoryEntry): void {
    if (entry.kind === 'event') transcript.apply(entry.event)
    else transcript.readFailure(entry.text)
  }

  function render(event: InvocationEventEnvelope): void {
    if (event.invocationId !== invocationId) return
    if (seenSeqs.has(event.seq)) return
    seenSeqs.add(event.seq)
    const entry: HistoryEntry = { kind: 'event', event }
    history.push(entry)
    applyEntry(entry)
    // Live path only. A redraw must NOT re-fire this: re-observing a replayed
    // `turn.started` would restart the status row's elapsed clock, so a pane resize
    // would visibly reset a counter the operator is timing a real wait against.
    options.onEvent?.(event)
  }

  function onLive(event: InvocationEventEnvelope): void {
    if (closed) return
    if (event.invocationId !== invocationId) return
    // While bootstrapping, defer live events so they are flushed in seq order
    // AFTER the replay snapshot — never interleaved ahead of it.
    if (bootstrapping) {
      deferredLive.push(event)
      return
    }
    render(event)
  }

  return {
    async start(): Promise<void> {
      subscription = readSurface.observe(onLive)
      try {
        const response = await readSurface.eventsSince({ invocationId, afterSeq: 0 })
        for (const event of [...response.events].sort((a, b) => a.seq - b.seq)) {
          render(event)
        }
      } catch (error) {
        const entry: HistoryEntry = { kind: 'readFailure', text: formatReadFailure(error) }
        history.push(entry)
        applyEntry(entry)
      } finally {
        bootstrapping = false
        // Flush any live events captured during bootstrap, in seq order.
        for (const event of deferredLive.sort((a, b) => a.seq - b.seq)) {
          render(event)
        }
        deferredLive.length = 0
      }
    },
    lines(): string[] {
      return [...lines]
    },
    redraw(): void {
      if (closed) return
      lines.length = 0
      transcript = buildTranscript()
      for (const entry of history) applyEntry(entry)
    },
    close(): void {
      closed = true
      subscription?.close()
      subscription = undefined
    },
  }
}

/**
 * Render a durable-read failure VISIBLY (daedalus invariant): a retention-gap
 * (`EventReplayUnavailable`) or any other read-surface error must surface in
 * the renderer output, never be silently dropped.
 */
export function formatReadFailure(error: unknown): string {
  const err = (error ?? {}) as {
    code?: unknown
    message?: unknown
    data?: { retentionFloorSeq?: unknown } | undefined
  }
  const code = err.code !== undefined ? String(err.code) : 'unknown'
  const floor = err.data?.retentionFloorSeq
  const floorNote = floor !== undefined ? ` retentionFloorSeq=${String(floor)}` : ''
  const message = typeof err.message === 'string' ? err.message : String(error)
  return `renderer durable read failed (${code})${floorNote}: ${message}`
}

/**
 * Resolve the absolute path to the renderer entry process that ships beside
 * this module (`renderer-entry.ts` in dev, `.js` once built by tsc). The launch
 * command invokes it directly inside the leased pane.
 */
export function resolveRendererEntryPath(): string {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), `renderer-entry${extname(self)}`)
}

export interface RendererLaunchOptions {
  invocationId: string
  /** Read-only observer/broker socket the renderer connects to. */
  observerSocketPath: string
  /** Fenced renderer->driver control socket for lifecycle intent such as /quit. */
  controlSocketPath: string
  runtimeId?: string | undefined
  rendererEntryPath?: string | undefined
}

/**
 * Build the command line pasted into the leased pane to launch the renderer.
 * It names the durable read source explicitly — bootstrap method
 * `invocation.eventsSince` and live notification `invocation.event` — so the
 * launch is self-documenting and a driver-pushed private feed can never satisfy
 * it. Never references `codex-cli-tmux`: the app-server JSON-RPC child stays the
 * harness transport.
 */
export function buildRendererLaunchCommand(options: RendererLaunchOptions): string {
  const entry = options.rendererEntryPath ?? resolveRendererEntryPath()
  return [
    'exec bun',
    shellQuote(entry),
    '--driver codex-app-server',
    `--invocation-id ${shellQuote(options.invocationId)}`,
    `--observer-socket ${shellQuote(options.observerSocketPath)}`,
    `--control-socket ${shellQuote(options.controlSocketPath)}`,
    ...(options.runtimeId !== undefined ? [`--runtime-id ${shellQuote(options.runtimeId)}`] : []),
    '--bootstrap-method invocation.eventsSince',
    '--live-method invocation.event',
  ].join(' ')
}
