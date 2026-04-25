import { basename } from 'node:path'

import type {
  AttachmentRef,
  PermissionHandler,
  UnifiedSession,
  UnifiedSessionEvent,
} from 'spaces-execution'

import type { AgentEvent, HarnessContinuationRef } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventPayload = Omit<
  AgentEvent,
  'ts' | 'seq' | 'hostSessionId' | 'cpSessionId' | 'runId' | 'continuation'
>
export type EventEmitter = ReturnType<typeof createEventEmitter>

// ---------------------------------------------------------------------------
// Helpers: event emitter (updated for hostSessionId / runId / continuation)
// ---------------------------------------------------------------------------

export function createEventEmitter(
  onEvent: (event: AgentEvent) => void | Promise<void>,
  base: {
    hostSessionId: string
    runId: string
  },
  continuation?: HarnessContinuationRef
): {
  emit: (event: EventPayload) => Promise<void>
  setContinuation: (ref: HarnessContinuationRef) => void
  getContinuation: () => HarnessContinuationRef | undefined
  idle: () => Promise<void>
} {
  let seq = 0
  let currentContinuation = continuation
  let lastEmission = Promise.resolve()

  const emit = async (event: EventPayload): Promise<void> => {
    seq += 1
    const fullEvent: AgentEvent = {
      ...(event as AgentEvent),
      ts: new Date().toISOString(),
      seq,
      hostSessionId: base.hostSessionId,
      runId: base.runId,
      ...(currentContinuation ? { continuation: currentContinuation } : {}),
    }

    lastEmission = lastEmission.then(() => Promise.resolve(onEvent(fullEvent)))
    void lastEmission.catch(() => {})
    return lastEmission
  }

  return {
    emit,
    setContinuation: (ref: HarnessContinuationRef) => {
      currentContinuation = ref
    },
    getContinuation: () => currentContinuation,
    idle: () => lastEmission,
  }
}

// ---------------------------------------------------------------------------
// Helpers: unified event mapping
// ---------------------------------------------------------------------------

export function mapContentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const textParts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const blockObj = block as { type?: string; text?: string }
    if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
      textParts.push(blockObj.text)
    }
  }
  if (textParts.length === 0) return undefined
  return textParts.join('')
}

export function mapUnifiedEvents(
  event: UnifiedSessionEvent,
  emit: (event: EventPayload) => void,
  onContinuationKeyObserved: (key: string) => void,
  state: { assistantBuffer: string; lastAssistantText?: string | undefined },
  options: { allowSessionIdUpdate: boolean }
): { turnEnded: boolean } {
  switch (event.type) {
    case 'agent_start': {
      const sdkSid = (event as { sdkSessionId?: unknown }).sdkSessionId
      const sessionId = typeof sdkSid === 'string' ? sdkSid : event.sessionId
      if (sessionId && options.allowSessionIdUpdate) {
        onContinuationKeyObserved(sessionId)
      }
      return { turnEnded: false }
    }
    case 'sdk_session_id': {
      const sdkSid = (event as { sdkSessionId?: string }).sdkSessionId
      if (sdkSid && options.allowSessionIdUpdate) {
        onContinuationKeyObserved(sdkSid)
      }
      return { turnEnded: false }
    }
    case 'message_start':
      if (event.message.role === 'assistant') {
        state.assistantBuffer = ''
      }
      return { turnEnded: false }
    case 'message_update': {
      if (event.textDelta && event.textDelta.length > 0) {
        state.assistantBuffer += event.textDelta
        emit({
          type: 'message_delta',
          role: 'assistant',
          delta: event.textDelta,
          payload: event.payload,
        } as EventPayload)
      } else if (event.contentBlocks) {
        const text = mapContentToText(event.contentBlocks)
        if (text) {
          state.assistantBuffer += text
          emit({
            type: 'message_delta',
            role: 'assistant',
            delta: text,
            payload: event.payload,
          } as EventPayload)
        }
      }
      return { turnEnded: false }
    }
    case 'message_end': {
      if (event.message?.role !== 'assistant') return { turnEnded: false }
      const content = mapContentToText(event.message.content)
      const finalText = content ?? state.assistantBuffer
      if (finalText) {
        state.lastAssistantText = finalText
        emit({
          type: 'message',
          role: 'assistant',
          content: finalText,
          payload: event.payload,
        } as EventPayload)
      }
      return { turnEnded: false }
    }
    case 'tool_execution_start':
      emit({
        type: 'tool_call',
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        payload: event.payload,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      } as EventPayload)
      return { turnEnded: false }
    case 'tool_execution_end':
      emit({
        type: 'tool_result',
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        output: event.result,
        isError: event.isError === true,
        payload: event.payload,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      } as EventPayload)
      return { turnEnded: false }
    case 'turn_end':
      return { turnEnded: true }
    case 'agent_end':
      return { turnEnded: true }
    default:
      return { turnEnded: false }
  }
}

export function buildAutoPermissionHandler(): PermissionHandler {
  return {
    isAutoAllowed: () => true,
    requestPermission: async () => ({ allowed: true }),
  }
}

export async function runSession(
  session: UnifiedSession,
  prompt: string,
  attachments: Array<string | AttachmentRef> | undefined,
  runId: string
): Promise<void> {
  const attachmentRefs = normalizeAttachmentRefs(attachments)

  await session.start()
  await session.sendPrompt(prompt, {
    ...(attachmentRefs ? { attachments: attachmentRefs } : {}),
    runId,
  })
}

function normalizeAttachmentRefs(
  attachments: Array<string | AttachmentRef> | undefined
): AttachmentRef[] | undefined {
  return attachments?.map((attachment) =>
    typeof attachment === 'string'
      ? {
          kind: 'file' as const,
          path: attachment,
          filename: basename(attachment),
        }
      : attachment
  )
}
