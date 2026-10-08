import type {
  CodexAppServerDriverSpec,
  EventProvenance,
  HarnessInvocationSpec,
  InputId,
  TurnId,
  UsageModelIdentity,
} from 'spaces-harness-broker-protocol'
import type { RawJournalCursor } from '../../capture/raw-journal'
import type { spawnHarnessProcess } from '../../runtime/process-runner'
import type { TmuxExec, TmuxPaneController } from '../../runtime/tmux'
import type { DriverContext } from '../driver'
import type { HookListenerHandle } from '../tmux-shared'
import type { CodexTuiLauncher } from './codex-tui-wrapper'
import type { RendererLauncher } from './renderer'
import type { CodexRpcPeer, RpcHandlers } from './rpc-client'

export const CODEX_APP_SERVER_DRIVER_VERSION = '0.1.0'

export interface ThreadResponse {
  threadId?: string | undefined
  thread?: { id?: string | undefined; model?: string | undefined } | undefined
  /** Codex reports the RESOLVED model here, including when `model: null` was sent. */
  model?: string | undefined
}

export interface TurnStartResponse {
  turn?: { id?: string | undefined } | undefined
}

export interface TurnSteerResponse {
  turnId?: string | undefined
}

export interface ThreadTurnsListResponse {
  data?:
    | Array<{
        id?: string | undefined
        status?: string | undefined
      }>
    | undefined
}

export interface PendingSteer {
  inputId: InputId
  threadId: string
  turnId: TurnId
  nativeObserved: boolean
  confirmation: Promise<'native-observed' | 'target-terminal'>
  settle: (result: 'native-observed' | 'target-terminal') => void
}

export type ChildProcess = Awaited<ReturnType<typeof spawnHarnessProcess>>
export type DriverEventExtra = NonNullable<Parameters<DriverContext['emit']>[2]>

export interface TurnFailure {
  message: string
  code: string
  data?: unknown
  retryable?: boolean | undefined
  reason?: string | undefined
}

export interface TurnAttribution {
  ownership: 'own' | 'foreign' | 'unknown'
  inputId?: InputId | undefined
  origin: 'broker' | 'human' | 'autonomous' | 'unknown'
}

export type RendererControlEnvelope =
  | {
      type: 'app-server-renderer.quit'
      invocationId?: string | undefined
      runtimeId?: string | undefined
      callbackSocket?: string | undefined
      reason?: string | undefined
    }
  | {
      type: 'app-server-renderer.exited'
      invocationId?: string | undefined
      runtimeId?: string | undefined
      callbackSocket?: string | undefined
      exitCode?: number | null | undefined
      signal?: NodeJS.Signals | string | null | undefined
    }
  | {
      type: 'app-server-renderer.stderr'
      invocationId?: string | undefined
      runtimeId?: string | undefined
      callbackSocket?: string | undefined
      line?: string | undefined
    }

export interface CodexAppServerDriverOptions {
  /** T-08554: how the viewer renderer is launched; absent keeps `bun <entry>`. */
  rendererLauncher?: RendererLauncher | undefined
  /**
   * T-08556: the executable that runs the codex-tui wrapper and codex hook
   * receiver; absent keeps `<execPath> <wrapper entry>` and PATH `harness-broker`.
   */
  codexTuiLauncher?: CodexTuiLauncher | undefined
  codexTui?: {
    tmuxBin?: string | undefined
    tmuxExec?: TmuxExec | undefined
    socketDir?: string | undefined
    connect?: ((socketPath: string, handlers: RpcHandlers) => Promise<CodexRpcPeer>) | undefined
  }
}

/**
 * The mutable state of one driver instance. Every module of the driver closes
 * over the same object, so a field written by one seam is what the next reads.
 */
export interface CodexDriverState {
  ctx: DriverContext | undefined
  spec: HarnessInvocationSpec | undefined
  driverSpec: CodexAppServerDriverSpec | undefined
  proc: ChildProcess | undefined
  rpc: CodexRpcPeer | undefined
  codexTui: boolean
  paneController: TmuxPaneController | undefined
  hookListener: HookListenerHandle | undefined
  attachTokenPath: string | undefined
  websocketSocketPath: string | undefined
  readonly pendingBrokerInputs: Set<InputId>
  readonly pendingSteers: Map<InputId, PendingSteer>
  readonly retiredSteerTurnsByInput: Map<InputId, Set<TurnId>>
  readonly observedUserItems: Set<string>
  readonly queuedSubmissions: Map<InputId, string>
  readonly attributionByTurn: Map<TurnId, TurnAttribution>
  readonly firstItemSeen: Set<TurnId>
  readonly attributionWaiters: Map<
    InputId,
    { resolve: (turnId: TurnId) => void; reject: (error: Error) => void }
  >
  threadId: string | undefined
  currentInputId: InputId | undefined
  currentTurnId: TurnId | undefined
  /**
   * The provider's `turn/start` response is the delivery acknowledgement. Its
   * id is therefore the ONLY id applyInputNow may return and the native
   * `turn/started` record may open a bracket under.
   */
  acknowledgedTurnId: TurnId | undefined
  turnActive: boolean
  /**
   * Codex pauses explicit queue execution after an interrupted turn. Preserve
   * that state across the manager's terminal->idle drain: the next queue/add
   * can arrive only after the interrupted notification has already returned.
   */
  queuedStartRequired: boolean
  startedEmitted: boolean
  terminalEmitted: boolean
  stopping: boolean
  starting: boolean
  rejectStartup: ((error: Error) => void) | undefined
  startupFailure: Promise<never> | undefined
  turnTimeout: ReturnType<typeof setTimeout> | undefined
  rendererControlListener: HookListenerHandle | undefined
  rendererQuitAccepted: boolean
  /**
   * Provider-transcript provenance state (T-05374, T-07868). The exported
   * sidecar is now a PROJECTION of the committed raw journal rather than a
   * parallel write, so there is no path on which it can hold a row the journal
   * does not. `reportedTranscriptPaths` still fences provenance emission to
   * at-most-once per concrete absolute path per invocation.
   */
  readonly reportedTranscriptPaths: Set<string>
  /**
   * How far the export at `path` has been written (T-10581). The first export
   * in a process rewrites the file; each later turn terminal appends only the
   * journal rows past `cursor`, so per-turn cost tracks the new evidence
   * rather than everything the invocation ever committed. Cleared on a failed
   * export so the next terminal rebuilds it whole.
   */
  transcriptExport: { path: string; cursor: RawJournalCursor; rows: number } | undefined
  /**
   * Verbatim frames observed while NO capture gate is wired — the isolated
   * driver unit harness. That mode has no journal at all, so this is the only
   * copy of the evidence rather than a second one; a gated invocation never
   * appends here (asserted by the driver tests).
   */
  readonly ungatedFrames: string[]
  /**
   * T-08430 — the model serving the thread. Codex's `thread/tokenUsage/updated`
   * names no model, so identity is carried here instead: the `thread/start` (or
   * `thread/resume`) response reports the model Codex actually resolved — even
   * when the spec asked for `null` — and `model/rerouted` reports a provider
   * substitution mid-thread. Only if Codex names neither does the configured
   * `driver.model` stand in, marked as configuration rather than evidence.
   */
  threadModel: UsageModelIdentity | undefined
  /**
   * Provenance of the committed raw record currently being normalized, stamped
   * onto every event that record produces (§7.2), plus the count of what it
   * minted — which is what decides `normalized` vs `state-only` for it (§6.1).
   * Both live at the single emit seam so provenance and disposition cannot
   * drift apart per call site.
   */
  activeProvenance: EventProvenance | undefined
  mintedForRecord: number
  /** Monotonic per-connection notification counter; the §7.1 source cursor. */
  notificationSequence: number
}

export function createCodexDriverState(): CodexDriverState {
  return {
    ctx: undefined,
    spec: undefined,
    driverSpec: undefined,
    proc: undefined,
    rpc: undefined,
    codexTui: false,
    paneController: undefined,
    hookListener: undefined,
    attachTokenPath: undefined,
    websocketSocketPath: undefined,
    pendingBrokerInputs: new Set(),
    pendingSteers: new Map(),
    retiredSteerTurnsByInput: new Map(),
    observedUserItems: new Set(),
    queuedSubmissions: new Map(),
    attributionByTurn: new Map(),
    firstItemSeen: new Set(),
    attributionWaiters: new Map(),
    threadId: undefined,
    currentInputId: undefined,
    currentTurnId: undefined,
    acknowledgedTurnId: undefined,
    turnActive: false,
    queuedStartRequired: false,
    startedEmitted: false,
    terminalEmitted: false,
    stopping: false,
    starting: false,
    rejectStartup: undefined,
    startupFailure: undefined,
    turnTimeout: undefined,
    rendererControlListener: undefined,
    rendererQuitAccepted: false,
    reportedTranscriptPaths: new Set(),
    transcriptExport: undefined,
    ungatedFrames: [],
    threadModel: undefined,
    activeProvenance: undefined,
    mintedForRecord: 0,
    notificationSequence: 0,
  }
}
