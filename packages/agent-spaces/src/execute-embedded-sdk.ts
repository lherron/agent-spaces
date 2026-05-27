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
  ToolCallStartedPayload,
  ToolCallId,
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
    composed['PATH'] = [...pathPrepend, basePath]
      .filter((part) => part.length > 0)
      .join(delimiter)
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
  const resolveTurnId = (raw: string | undefined): TurnId | undefined =>
    (raw ?? (input.turnId as string | undefined)) as TurnId | undefined

  const computeProducedContent = (): boolean =>
    Boolean(lastAssistantText) || assistantBuffer.length > 0 || toolActivity

  const handleEvent = (event: UnifiedSessionEvent): void => {
    switch (event.type) {
      case 'agent_start': {
        const sdkSid = (event as { sdkSessionId?: string }).sdkSessionId
        if (sdkSid) observedSessionKey = sdkSid
        return
      }
      case 'sdk_session_id': {
        if (event.sdkSessionId) observedSessionKey = event.sdkSessionId
        return
      }
      case 'turn_start': {
        const turnId = resolveTurnId(event.turnId)
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
        emit('assistant.message.started', payload)
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
        emit('assistant.message.delta', payload)
        return
      }
      case 'message_end': {
        if (event.message?.role !== 'assistant') return
        const content = mapContentToText(event.message.content)
        const finalText = content ?? assistantBuffer
        if (finalText.length > 0) lastAssistantText = finalText
        const payload: AssistantMessageCompletedPayload = {
          messageId: (event.messageId ?? 'message') as MessageId,
          content: [{ type: 'text', text: finalText }],
          final: true,
        }
        emit('assistant.message.completed', payload)
        return
      }
      case 'tool_execution_start': {
        toolActivity = true
        const payload: ToolCallStartedPayload = {
          toolCallId: event.toolUseId as ToolCallId,
          name: event.toolName,
          input: event.input,
        }
        emit('tool.call.started', payload)
        return
      }
      case 'tool_execution_update': {
        const payload: ToolCallDeltaPayload = {
          toolCallId: event.toolUseId as ToolCallId,
          ...(event.partialOutput !== undefined ? { text: event.partialOutput } : {}),
        }
        emit('tool.call.delta', payload)
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
        emit('tool.call.completed', payload)
        return
      }
      case 'turn_end': {
        const turnId = resolveTurnId(event.turnId)
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
    const continuationKey =
      profile.continuation?.hrc?.continuationId ?? profile.continuation?.hrc?.key

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
      ...(continuationKey ? { sessionPath: continuationKey } : {}),
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

    // ARCPS §13: only a successful turn advances continuation.
    let continuation: ContinuationUpdate | undefined
    if (observedSessionKey) {
      continuation = {
        provider: profile.session.provider,
        key: observedSessionKey,
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
      ...(observedSessionKey ? { sessionKey: observedSessionKey } : {}),
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
