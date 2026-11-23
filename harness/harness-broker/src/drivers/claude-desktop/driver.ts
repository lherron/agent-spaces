import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
  type InvocationCapabilities,
} from 'spaces-harness-broker-protocol'
import type { CaptureGate } from '../../capture/capture-gate'
import { BrokerError, errorMessage } from '../../errors'
import { CLAUDE_CODE_TMUX_DRIVER_KIND } from '../claude-code-tmux/hook-events'
import {
  type ClaudeTranscriptWakeup,
  type TranscriptWatch,
  createClaudeTranscriptWakeup,
} from '../claude-code-tmux/transcript-wakeup'
import type { Driver, DriverContext } from '../driver'
import { CLAUDE_DESKTOP_AUTHORITY } from '../evidence-authority'
import { type HookListenerHandle, listenForHookEnvelopes } from '../hook-callback/listener'
import { asRecord, getString, unwrapHookPayload } from '../hook-json'
import { type ClaudeDesktopObserver, createClaudeDesktopObserver } from './transcript-observer'
import {
  CLAUDE_DESKTOP_DRIVER_KIND,
  CLAUDE_DESKTOP_DRIVER_VERSION,
  locateClaudeTranscript,
  planClaudeDesktopReplay,
  writeClaudeDesktopCursor,
} from './transcript-plan'

const capabilities: InvocationCapabilities = {
  admission: { classes: [] },
  bracketMintingMode: 'observed',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: null },
  input: {
    user: false,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: false,
  },
  turns: { concurrency: 'single', interrupt: 'unsupported' },
  continuation: { supported: false },
  events: {
    assistantDeltas: false,
    toolCalls: true,
    usage: true,
    diagnostics: true,
    replay: true,
    ack: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    status: true,
    snapshot: true,
    eventsSince: true,
    eventTypeFilter: true,
    liveness: 'cached',
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

/** The per-session hint socket the joining hook writes to (T-14464). */
export function claudeDesktopHookSocketPath(claudeHome: string, sessionId: string): string {
  return join(claudeHome, 'hrc-desktop', sessionId, 'hook.sock')
}

/** One hint per connection: the hook's own stdin JSON, verbatim. */
type ClaudeDesktopHint = { hookData?: unknown }

export interface ClaudeDesktopDriverOptions {
  sessionId: string
  /** `~/.claude`: holds `projects/` (transcripts) and `hrc-desktop/` (state). */
  claudeHome: string
  /** The safety net under the native watcher; also how an absent transcript is found. */
  pollIntervalMs?: number | undefined
  /** Test seam; `false` disables the native watcher. */
  watchTranscript?: TranscriptWatch | false | undefined
  /** Defaults to {@link claudeDesktopHookSocketPath}; `false` binds none. */
  hookSocketPath?: string | false | undefined
  now?: (() => Date) | undefined
}

/**
 * Stamp this driver's kind on what the shared Claude modules emit and commit.
 * They say `claude-code-tmux`, the tmux driver's name, not a fact about the
 * evidence (same rewrite as claude-code-hrcpty).
 */
function withDesktopDriverKind(ctx: DriverContext): DriverContext {
  const relabel = <
    E extends { driver?: { kind: string; rawType?: string | undefined } | undefined },
  >(
    extra: E | undefined
  ): E | undefined =>
    extra?.driver?.kind === CLAUDE_CODE_TMUX_DRIVER_KIND
      ? { ...extra, driver: { ...extra.driver, kind: CLAUDE_DESKTOP_DRIVER_KIND } }
      : extra
  const capture: CaptureGate | undefined =
    ctx.capture === undefined
      ? undefined
      : {
          ...ctx.capture,
          ingest: (input, normalize) =>
            ctx.capture?.ingest(
              input.driverKind === CLAUDE_CODE_TMUX_DRIVER_KIND
                ? { ...input, driverKind: CLAUDE_DESKTOP_DRIVER_KIND }
                : input,
              normalize
            ),
        }
  return {
    ...ctx,
    ...(capture !== undefined ? { capture } : {}),
    emit: (type, payload, extra) => ctx.emit(type, payload, relabel(extra)),
    emitEvent: (event, extra) => ctx.emitEvent(event, relabel(extra)),
  }
}

/**
 * Observe a desktop-owned Claude session. The session transcript is the source
 * of truth: every turn, typed, peer-sent or app-injected, is read from it,
 * including where it starts and ends. Hooks are only wake-ups, so a lost hook
 * delays a read by at most one poll and loses nothing. A restarted broker
 * replays the transcript from byte zero with publishing muted up to just past
 * the last row it journaled, so it neither re-emits nor skips a turn.
 * Delivery into the session is a separate concern (T-14466).
 */
export function createClaudeDesktopDriver(options: ClaudeDesktopDriverOptions): Driver {
  const { sessionId, claudeHome } = options
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const now = options.now ?? (() => new Date())
  let ctx: DriverContext | undefined
  let cwd: string | undefined
  let observer: ClaudeDesktopObserver | undefined
  let transcriptPath: string | undefined
  let hookListener: HookListenerHandle | undefined
  let poller: ReturnType<typeof setInterval> | undefined
  let chain: Promise<void> = Promise.resolve()
  let stopped = true
  let healthReason: string | undefined = 'claude_desktop_transcript_unavailable'

  const wakeup: ClaudeTranscriptWakeup | undefined =
    options.watchTranscript === false
      ? undefined
      : createClaudeTranscriptWakeup({
          ...(options.watchTranscript !== undefined ? { watch: options.watchTranscript } : {}),
          onChange: () => schedule(read),
          // The poller still reads, so losing the watcher costs latency only.
          onLost: (path, detail) =>
            ctx?.emit(
              'driver.notice',
              {
                message: `Claude desktop transcript watcher lost; polling continues: ${detail}`,
                code: 'CLAUDE_DESKTOP_WATCH_LOST',
                data: { transcriptPath: path },
              },
              { driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType: 'transcript.watch' } }
            ),
        })

  function schedule(step: () => void): void {
    if (stopped) return
    chain = chain
      .then(step)
      .catch((error) => reportHealth(`observer read failed: ${errorMessage(error)}`))
  }

  function reportHealth(reason: string | undefined): void {
    if (healthReason === reason) return
    healthReason = reason
    ctx?.emit(
      'driver.notice',
      {
        message:
          reason === undefined
            ? 'Claude desktop transcript observation is healthy'
            : `Claude desktop transcript observation degraded: ${reason}`,
        code:
          reason === undefined
            ? 'CLAUDE_DESKTOP_OBSERVER_HEALTHY'
            : 'CLAUDE_DESKTOP_OBSERVER_DEGRADED',
        data: { observer: reason === undefined ? 'healthy' : 'degraded' },
      },
      { driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType: 'observer.health' } }
    )
  }

  let publishedThrough: number | undefined

  function saveCursor(stateDir: string | undefined, nextByte: number): void {
    publishedThrough = nextByte
    if (stateDir === undefined || transcriptPath === undefined) return
    try {
      writeClaudeDesktopCursor(stateDir, transcriptPath, nextByte)
    } catch (error) {
      reportHealth(`cursor write failed: ${errorMessage(error)}`)
    }
  }

  /** Attach to the transcript once it exists, then read whatever is new. */
  function read(hintedPath?: string): void {
    if (ctx === undefined || observer === undefined) return
    if (transcriptPath === undefined) {
      const path =
        hintedPath !== undefined && existsSync(hintedPath)
          ? hintedPath
          : locateClaudeTranscript(claudeHome, sessionId, cwd)
      if (path === undefined) return
      const plan = planClaudeDesktopReplay(ctx.capture, path, ctx.durableStateDir)
      transcriptPath = path
      publishedThrough = undefined
      observer.open(path, plan)
      // A first join that published nothing still records where it attached,
      // so rows written before the next broker starts are not skipped.
      if (publishedThrough === undefined) saveCursor(ctx.durableStateDir, plan.liveFromByte)
      wakeup?.select(path)
      ctx.emit(
        'driver.notice',
        {
          message: `Claude desktop transcript attached (${plan.mode}) at byte ${plan.liveFromByte}`,
          code: 'CLAUDE_DESKTOP_TRANSCRIPT_ATTACHED',
          data: {
            mode: plan.mode,
            liveFromByte: plan.liveFromByte,
            journaledRows: plan.journaled.size,
            pendingRows: plan.pendingOffsets.size,
          },
        },
        { driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType: 'transcript.attach' } }
      )
      reportHealth(undefined)
      return
    }
    if (!existsSync(transcriptPath)) {
      reportHealth('claude_desktop_transcript_unavailable')
      return
    }
    reportHealth(undefined)
    observer.drain()
  }

  /**
   * A hook hint: commit it as evidence that it arrived, then read. It changes
   * no turn state; the transcript row it points at does that.
   */
  function onHint(hint: ClaudeDesktopHint): undefined {
    const active = ctx
    if (active === undefined) return undefined
    const hook = unwrapHookPayload(asRecord(hint.hookData))
    if (getString(hook, 'session_id') !== sessionId) return undefined
    const name = getString(hook, 'hook_event_name') ?? '(none)'
    active.capture?.ingest(
      {
        provider: 'anthropic',
        driverKind: CLAUDE_DESKTOP_DRIVER_KIND,
        sourceKind: 'hook',
        sourceKey: `hook:${active.invocationId}`,
        nativeType: name,
        rawBytes: Buffer.from(JSON.stringify(hint.hookData ?? null), 'utf8'),
      },
      () => ({ disposition: 'state-only', detail: `claude-desktop hint: ${name}` })
    )
    const hintedPath = getString(hook, 'transcript_path')
    schedule(() => read(hintedPath))
    return undefined
  }

  async function release(): Promise<void> {
    stopped = true
    if (poller !== undefined) clearInterval(poller)
    poller = undefined
    wakeup?.close()
    const listener = hookListener
    hookListener = undefined
    await listener?.close().catch(() => undefined)
    await chain.catch(() => undefined)
    // One last read so rows written before stop are not left unread.
    try {
      if (transcriptPath !== undefined) observer?.drain()
    } catch {}
  }

  return {
    kind: CLAUDE_DESKTOP_DRIVER_KIND,
    version: CLAUDE_DESKTOP_DRIVER_VERSION,
    bracketMintingMode: 'observed',
    evidenceAuthority: CLAUDE_DESKTOP_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: null,
    steerLandingEvidence: null,
    interruptLandingEvidence: null,
    capabilities: () => capabilities,
    runtimeHealth() {
      return healthReason === undefined
        ? ({ state: 'healthy' } as const)
        : ({ state: 'degraded', reason: healthReason } as const)
    },
    async start(spec, brokerCtx) {
      if (!('sessionId' in spec.driver) || spec.driver['sessionId'] !== sessionId) {
        throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Claude Desktop session mismatch')
      }
      await release()
      ctx = withDesktopDriverKind(brokerCtx)
      cwd = spec.process.cwd
      const stateDir = brokerCtx.durableStateDir
      observer = createClaudeDesktopObserver({
        ctx,
        now,
        onRowPublished: (nextByte) => saveCursor(stateDir, nextByte),
      })
      transcriptPath = undefined
      healthReason = 'claude_desktop_transcript_unavailable'
      wakeup?.reset()
      stopped = false
      const socketPath =
        options.hookSocketPath ?? claudeDesktopHookSocketPath(claudeHome, sessionId)
      if (socketPath !== false) {
        try {
          hookListener = await listenForHookEnvelopes<ClaudeDesktopHint>(socketPath, onHint)
        } catch (error) {
          // Hints only shorten latency; the poller observes without them.
          ctx.emit(
            'driver.notice',
            {
              message: `Claude desktop hint socket unavailable; polling only: ${errorMessage(error)}`,
              code: 'CLAUDE_DESKTOP_HINT_SOCKET_UNAVAILABLE',
              data: {},
            },
            { driver: { kind: CLAUDE_DESKTOP_DRIVER_KIND, rawType: 'hook.listen' } }
          )
        }
      }
      read()
      poller = setInterval(() => schedule(read), pollIntervalMs)
      poller.unref?.()
      return { ok: true }
    },
    async applyInputNow() {
      throw new BrokerError(
        BrokerErrorCode.UnsupportedCapability,
        'Claude Desktop input is unavailable'
      )
    },
    async interrupt() {
      return {
        accepted: false,
        effect: 'unsupported',
        reason: 'desktop lifecycle is externally owned',
      }
    },
    async stop() {
      await release()
      return { accepted: true, state: 'exited' }
    },
    async dispose() {
      await release()
      ctx = undefined
      observer = undefined
      transcriptPath = undefined
    },
  }
}
