import { delimiter } from 'node:path'

import type {
  AssistantMessageCompletedPayload,
  AssistantMessageDeltaPayload,
  AssistantMessageStartedPayload,
  ContinuationUpdate,
  InputDispositionPayload,
  InputId,
  InvocationEventEnvelope,
  InvocationEventPayload,
  InvocationEventType,
  InvocationFailedPayload,
  InvocationId,
  InvocationStartedPayload,
  MessageId,
  ToolCallCompletedPayload,
  ToolCallDeltaPayload,
  ToolCallId,
  ToolCallStartedPayload,
  TurnCompletedPayload,
  TurnId,
  TurnStartedPayload,
} from 'spaces-harness-broker-protocol'
import type {
  LoadPiSdkBundleOptions,
  PiSdkBundleLoadResult,
  PiSessionConfig,
} from 'spaces-harness-pi-sdk/pi-session'
import { PiSession, loadPiSdkBundle as realLoadPiSdkBundle } from 'spaces-harness-pi-sdk/pi-session'
import type { UnifiedSession, UnifiedSessionEvent } from 'spaces-runtime'
import type { EmbeddedSdkExecutionProfile } from 'spaces-runtime-contracts'

import { applyEnvOverlay } from './runtime-env.js'
import { buildAutoPermissionHandler, mapContentToText } from './session-events.js'

/**
 * In-process embedded-sdk executor for the pi-sdk runtime (T-01669, Wave 2).
 *
 * Consumes a compiled {@link EmbeddedSdkExecutionProfile} and drives a pi-sdk
 * {@link PiSession} in-process — NO spawned process, callback socket, broker, or
 * pty (ARCPS §9.6 / FINAL_CONTRACTS §7.8). It owns:
 *   - normalization to the {@link InvocationEventEnvelope} taxonomy (no SDK
 *     taxonomy leak — HRC never parses native SDK events);
 *   - lifecycle (invocation.started/ready/exited/failed);
 *   - four-channel env composition (ambient ⊎ credentials ⊎ session.lockedEnv ⊎
 *     dispatchEnv) per ARCPS §7.5.1, never mutating the compiled lockedEnv, with
 *     session.pathPrepend applied as the typed PATH channel;
 *   - continuation/sessionKey persistence (ARCPS §13): a sessionKey is only
 *     promoted + a continuation.updated emitted on a SUCCESSFUL turn; a failed
 *     turn never advances continuation.
 */

/** Minimal bundle shape the executor needs to construct a PiSession. */
export type EmbeddedSdkBundle = Pick<
  PiSdkBundleLoadResult,
  'extensions' | 'skills' | 'contextFiles'
>

export interface ExecuteEmbeddedSdkTurnDependencies {
  /** Clock for envelope timestamps. Defaults to `() => new Date().toISOString()`. */
  now?: () => string
  /** Load the materialized pi-sdk bundle. Defaults to the real loader. */
  loadPiSdkBundle?: (
    bundleRoot: string,
    options: LoadPiSdkBundleOptions
  ) => Promise<EmbeddedSdkBundle>
  /** Construct the pi-sdk session. Defaults to the real {@link PiSession}. */
  createPiSession?: (config: Record<string, unknown>) => UnifiedSession
}

export interface ExecuteEmbeddedSdkTurnInput {
  profile: EmbeddedSdkExecutionProfile
  prompt: string
  invocationId: InvocationId
  inputId?: InputId | undefined
  turnId?: TurnId | undefined
  runId?: string | undefined
  /** Explicit Pi session/continuation path supplied by the SessionManager. */
  sessionPath?: string | undefined
  /** Root of the materialized pi-sdk bundle (the agentDir). */
  bundleRoot: string
  /** HRC-mutable dispatch env channel (ARCPS §7.5.1). */
  dispatchEnv?: Record<string, string> | undefined
  /** Streaming sink for normalized envelopes, in addition to the collected list. */
  onEvent?: ((event: InvocationEventEnvelope) => void) | undefined
  dependencies?: ExecuteEmbeddedSdkTurnDependencies | undefined
}

export interface ExecuteEmbeddedSdkTurnError {
  code: string
  message: string
  data?: unknown
}

export interface ExecuteEmbeddedSdkTurnResult {
  success: boolean
  events: InvocationEventEnvelope[]
  producedContent: boolean
  finalOutput?: string | undefined
  continuation?: ContinuationUpdate | undefined
  sessionKey?: string | undefined
  error?: ExecuteEmbeddedSdkTurnError | undefined
}

function defaultCreatePiSession(config: Record<string, unknown>): UnifiedSession {
  return new PiSession(config as unknown as PiSessionConfig)
}

/** Compose the four env channels without mutating the compiled lockedEnv. */
function composeEnv(
  profile: EmbeddedSdkExecutionProfile,
  dispatchEnv: Record<string, string> | undefined
): Record<string, string> {
  // ambient ⊎ credentials = current process env (file-based pi creds live
  // outside env). lockedEnv and dispatchEnv overlay it; lockedEnv is copied,
  // never mutated.
  const composed: Record<string, string> = {
    ...profile.session.lockedEnv,
    ...(dispatchEnv ?? {}),
  }

  // session.pathPrepend is the typed PATH channel — prepend to the FINAL
  // composed PATH; PATH is never carried inside lockedEnv.
  const pathPrepend = profile.session.pathPrepend ?? []
  if (pathPrepend.length > 0) {
    const basePath = composed['PATH'] ?? process.env['PATH'] ?? ''
    composed['PATH'] = [...pathPrepend, basePath].filter((part) => part.length > 0).join(delimiter)
  }

  return composed
}

export async function executeEmbeddedSdkTurn(
  input: ExecuteEmbeddedSdkTurnInput
): Promise<ExecuteEmbeddedSdkTurnResult> {
  const { profile, prompt, invocationId } = input
  const deps = input.dependencies ?? {}
  const now = deps.now ?? (() => new Date().toISOString())
  const loadBundle = deps.loadPiSdkBundle ?? realLoadPiSdkBundle
  const createPiSession = deps.createPiSession ?? defaultCreatePiSession
  const inputId = (input.inputId ?? (`${invocationId}-input` as string)) as InputId

  const events: InvocationEventEnvelope[] = []
  let seq = 0
  const emit = (
    type: InvocationEventType,
    payload: InvocationEventPayload,
    extra?: { turnId?: TurnId | undefined; inputId?: InputId | undefined }
  ): void => {
    seq += 1
    const envelope: InvocationEventEnvelope = {
      invocationId,
      seq,
      time: now(),
      type,
      payload,
      driver: { kind: `embedded-sdk:${profile.sdk.runtime}` },
      ...(extra?.turnId !== undefined ? { turnId: extra.turnId } : {}),
      ...(extra?.inputId !== undefined ? { inputId: extra.inputId } : {}),
    }
    events.push(envelope)
    input.onEvent?.(envelope)
  }

  // ARCPS §13: reuse-existing requires a validated continuation key on the
  // compiled profile. Reject before any session is created.
  if (profile.sdk.startupMethod === 'reuse-existing') {
    const key = profile.continuation?.hrc?.continuationId ?? profile.continuation?.hrc?.key
    if (!key) {
      const error: ExecuteEmbeddedSdkTurnError = {
        code: 'missing_continuation_key',
        message:
          'reuse-existing startup requires a validated continuation key, but the compiled profile has none',
      }
      emit('invocation.failed', { message: error.message, code: error.code })
      return { success: false, events, producedContent: false, error }
    }
  }

  // Accumulation state for content / continuation tracking across the turn.
  let assistantBuffer = ''
  let lastAssistantText: string | undefined
  let toolActivity = false
  let observedSessionKey: string | undefined
  // The active turn id stamped on every turn-scoped envelope (turn/assistant/
  // tool events) so downstream turn-id correlation (e.g. assertSharedCommandTurn)
  // can group them. Lifecycle events (invocation.*, input.*, continuation.*) are
  // intentionally NOT turn-scoped.
  let currentTurnId: TurnId | undefined = input.turnId as string | undefined as TurnId | undefined
  // Pi SDK turn_start/turn_end are native MODEL-ROUND boundaries, NOT operator
  // turn boundaries: one prompt drives multiple native turns. Inside an agent
  // lifecycle we COLLAPSE those rounds into ONE broker turn (the input/broker
  // turn id): a single turn.started on the first native turn_start, intermediate
  // assistant messages as final:false, and exactly one turn.completed at
  // agent_end. The held-latest `final` flag is derived upstream in pi-session and
  // propagated here verbatim — never re-stamped.
  let agentLifecycleActive = false
  let brokerTurnStarted = false
  let brokerTurnCompleted = false
  const brokerTurnId = (): TurnId =>
    (input.turnId as TurnId | undefined) ?? (invocationId as string as TurnId)
  // Bare/legacy mode (no agent lifecycle): allocate a stable, UNIQUE turn id per
  // native turn — first adopts input.turnId, subsequent get a suffixed synthetic
  // id so each correlates to exactly one terminal event.
  let turnCounter = 0
  const allocateTurnId = (raw: string | undefined): TurnId | undefined => {
    turnCounter += 1
    if (raw !== undefined && raw.length > 0) return raw as TurnId
    const baseId = (input.turnId as string | undefined) ?? (invocationId as string)
    if (turnCounter === 1) return baseId as TurnId
    return `${baseId}-t${turnCounter}` as TurnId
  }

  const emitBrokerTurnCompleted = (): void => {
    if (!brokerTurnStarted || brokerTurnCompleted) return
    brokerTurnCompleted = true
    const turnId = brokerTurnId()
    const payload: TurnCompletedPayload = {
      turnId,
      status: 'completed',
      producedContent: computeProducedContent(),
      ...(lastAssistantText !== undefined ? { finalOutput: lastAssistantText } : {}),
    }
    emit('turn.completed', payload, { turnId })
  }

  const computeProducedContent = (): boolean =>
    Boolean(lastAssistantText) || assistantBuffer.length > 0 || toolActivity

  const handleEvent = (event: UnifiedSessionEvent): void => {
    switch (event.type) {
      case 'agent_start': {
        const sdkSid = (event as { sdkSessionId?: string }).sdkSessionId
        if (sdkSid) observedSessionKey = sdkSid
        agentLifecycleActive = true
        brokerTurnStarted = false
        brokerTurnCompleted = false
        return
      }
      case 'agent_end': {
        // Operator terminal for the collapsed broker turn: emit exactly one
        // turn.completed for the broker turn id (the held final:true assistant
        // message was already surfaced by pi-session just before this event).
        emitBrokerTurnCompleted()
        agentLifecycleActive = false
        return
      }
      case 'sdk_session_id': {
        if (event.sdkSessionId) observedSessionKey = event.sdkSessionId
        return
      }
      case 'turn_start': {
        if (agentLifecycleActive) {
          // Collapse native model-rounds into one broker turn: stamp all
          // turn-scoped events with the broker turn id and emit turn.started only
          // on the FIRST native round.
          currentTurnId = brokerTurnId()
          if (!brokerTurnStarted) {
            brokerTurnStarted = true
            const payload: TurnStartedPayload = { turnId: currentTurnId }
            emit('turn.started', payload, { turnId: currentTurnId })
          }
          return
        }
        const turnId = allocateTurnId(event.turnId)
        currentTurnId = turnId
        const payload: TurnStartedPayload = { turnId: turnId as TurnId }
        emit('turn.started', payload, { turnId })
        return
      }
      case 'message_start': {
        if (event.message?.role !== 'assistant') return
        assistantBuffer = ''
        const payload: AssistantMessageStartedPayload = {
          messageId: (event.messageId ?? 'message') as MessageId,
        }
        emit('assistant.message.started', payload, { turnId: currentTurnId })
        return
      }
      case 'message_update': {
        let text = event.textDelta
        if ((!text || text.length === 0) && event.contentBlocks) {
          text = mapContentToText(event.contentBlocks)
        }
        if (!text || text.length === 0) return
        assistantBuffer += text
        const payload: AssistantMessageDeltaPayload = {
          messageId: (event.messageId ?? 'message') as MessageId,
          text,
        }
        emit('assistant.message.delta', payload, { turnId: currentTurnId })
        return
      }
      case 'message_end': {
        if (event.message?.role !== 'assistant') return
        const content = mapContentToText(event.message.content)
        const finalText = content ?? assistantBuffer
        if (finalText.length > 0) lastAssistantText = finalText
        // `final` is the held-latest terminal-for-turn flag derived by pi-session
        // (final:false for intermediate assistant messages, final:true for the
        // operator-terminal one). Propagate it verbatim; only default to terminal
        // when a producer emits a raw message_end with no held-latest payload.
        const eventFinal = (event as { payload?: { final?: unknown } }).payload?.final
        const final = typeof eventFinal === 'boolean' ? eventFinal : true
        const payload: AssistantMessageCompletedPayload = {
          messageId: (event.messageId ?? 'message') as MessageId,
          content: [{ type: 'text', text: finalText }],
          final,
        }
        emit('assistant.message.completed', payload, { turnId: currentTurnId })
        return
      }
      case 'tool_execution_start': {
        toolActivity = true
        const payload: ToolCallStartedPayload = {
          toolCallId: event.toolUseId as ToolCallId,
          name: event.toolName,
          input: event.input,
        }
        emit('tool.call.started', payload, { turnId: currentTurnId })
        return
      }
      case 'tool_execution_update': {
        const payload: ToolCallDeltaPayload = {
          toolCallId: event.toolUseId as ToolCallId,
          ...(event.partialOutput !== undefined ? { text: event.partialOutput } : {}),
        }
        emit('tool.call.delta', payload, { turnId: currentTurnId })
        return
      }
      case 'tool_execution_end': {
        toolActivity = true
        const payload: ToolCallCompletedPayload = {
          toolCallId: event.toolUseId as ToolCallId,
          name: event.toolName,
          result: event.result,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        }
        emit('tool.call.completed', payload, { turnId: currentTurnId })
        return
      }
      case 'turn_end': {
        if (agentLifecycleActive) {
          // Internal native model-round boundary: the single broker turn.completed
          // is emitted once at agent_end, not per native round.
          return
        }
        // Bare/legacy mode: the native turn_end is the terminal boundary. Use the
        // active (allocated) turn id so the terminal event correlates to the same
        // turn its turn.started/tool/assistant events carried.
        const turnId =
          currentTurnId ?? (event.turnId as TurnId | undefined) ?? (input.turnId as TurnId)
        const producedContent = computeProducedContent()
        const payload: TurnCompletedPayload = {
          turnId: turnId as TurnId,
          status: 'completed',
          producedContent,
          ...(lastAssistantText !== undefined ? { finalOutput: lastAssistantText } : {}),
        }
        emit('turn.completed', payload, { turnId })
        return
      }
      default:
        return
    }
  }

  const startedPayload: InvocationStartedPayload = {
    command: profile.sdk.runtime,
    args: [],
    cwd: profile.session.cwd,
  }
  emit('invocation.started', startedPayload)

  let session: UnifiedSession | undefined
  let restoreEnv: (() => void) | undefined

  try {
    // pi-sdk continuation IS the SessionManager session-file path: an explicit
    // input.sessionPath (caller derives it via the legacy piSessionPath shape)
    // wins; reuse-existing falls back to the validated compiled continuation key.
    // The executor never derives/guesses it (ARCPS §13; run-placement-turn.ts:295).
    const continuationKey =
      profile.continuation?.hrc?.continuationId ?? profile.continuation?.hrc?.key
    const sessionPath = input.sessionPath ?? continuationKey

    const bundle = await loadBundle(input.bundleRoot, {
      cwd: profile.session.cwd,
      yolo: false,
      noExtensions: false,
      noSkills: false,
      agentDir: input.bundleRoot,
    })

    // The pi model registry is keyed by the namespaced provider, so recover
    // (registryProvider, registryModel) from a namespaced modelId (e.g.
    // `openai-codex/gpt-5.5` -> provider `openai-codex`, model `gpt-5.5`). A bare
    // modelId falls back to the coarse ProviderDomain on the profile.
    const slash = profile.session.modelId.indexOf('/')
    const registryProvider =
      slash > 0 ? profile.session.modelId.slice(0, slash) : profile.session.provider
    const registryModel =
      slash > 0 ? profile.session.modelId.slice(slash + 1) : profile.session.modelId

    const sessionConfig: Record<string, unknown> = {
      ownerId: input.runId ?? (invocationId as string),
      cwd: profile.session.cwd,
      provider: registryProvider,
      model: registryModel,
      sessionId: input.runId ?? (invocationId as string),
      agentDir: input.bundleRoot,
      extensions: bundle.extensions,
      skills: bundle.skills,
      contextFiles: bundle.contextFiles,
      ...(sessionPath ? { sessionPath } : {}),
    }

    session = createPiSession(sessionConfig)
    session.setPermissionHandler(buildAutoPermissionHandler())
    session.onEvent(handleEvent)

    // Tightly-scoped env overlay around the in-process SDK drive (ARCPS §7.5.1).
    restoreEnv = applyEnvOverlay(composeEnv(profile, input.dispatchEnv))

    await session.start()
    emit('invocation.ready', { state: 'ready' })

    const acceptedPayload: InputDispositionPayload = { inputId }
    emit('input.accepted', acceptedPayload, { inputId })

    await session.sendPrompt(prompt, { runId: input.runId ?? (invocationId as string) })

    await session.stop('complete')

    const producedContent = computeProducedContent()
    const finalOutput =
      lastAssistantText ?? (assistantBuffer.length > 0 ? assistantBuffer : undefined)

    // ARCPS §13: only a successful turn advances continuation. An observed
    // sdk_session_id event wins (override/future-proof seam); pi-sdk does NOT
    // depend on it — it falls back to the explicit SessionManager sessionPath.
    const sessionKey = observedSessionKey ?? sessionPath
    let continuation: ContinuationUpdate | undefined
    if (sessionKey) {
      continuation = {
        provider: profile.session.provider,
        key: sessionKey,
        kind: 'session',
      }
      emit('continuation.updated', continuation)
    }

    emit('invocation.exited', { exitCode: 0 })

    return {
      success: true,
      events,
      producedContent,
      ...(finalOutput !== undefined ? { finalOutput } : {}),
      ...(continuation ? { continuation } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    }
  } catch (error) {
    if (session) {
      try {
        await session.stop('error')
      } catch {
        // Ignore cleanup failures.
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    const failedPayload: InvocationFailedPayload = { message, code: 'turn_failed' }
    emit('invocation.failed', failedPayload)

    // Do NOT advance continuation on failure: a crashed session's key points at
    // a non-existent / corrupt conversation (run-placement-turn.ts:387-390).
    return {
      success: false,
      events,
      producedContent: computeProducedContent(),
      error: { code: 'turn_failed', message },
    }
  } finally {
    restoreEnv?.()
  }
}
