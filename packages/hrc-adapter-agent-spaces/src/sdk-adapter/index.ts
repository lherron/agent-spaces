import { createHash } from 'node:crypto'

import {
  type AgentEvent,
  type RunTurnNonInteractiveRequest,
  type RunTurnNonInteractiveResponse,
  createAgentSpacesClient,
} from 'agent-spaces'
import {
  type HrcContinuationRef,
  HrcErrorCode,
  type HrcEventEnvelope,
  type HrcProvider,
  type HrcRuntimeIntent,
  HrcUnprocessableEntityError,
} from 'hrc-core'

import { UnsupportedHarnessError } from '../cli-adapter/index.js'

export type SdkTurnRunner = (
  request: RunTurnNonInteractiveRequest
) => Promise<RunTurnNonInteractiveResponse>

export type SdkTurnOptions = {
  intent: HrcRuntimeIntent
  hostSessionId: string
  runId: string
  runtimeId: string
  prompt: string
  scopeRef: string
  laneRef: string
  generation: number
  existingProvider?: HrcProvider | undefined
  continuation?: HrcContinuationRef | undefined
  runner?: SdkTurnRunner | undefined
  onHrcEvent?: ((event: Omit<HrcEventEnvelope, 'seq'>) => void | Promise<void>) | undefined
  onBuffer?: ((text: string) => void | Promise<void>) | undefined
}

export type SdkTurnResult = {
  continuation?: HrcContinuationRef | undefined
  provider: HrcProvider
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  harnessSessionJson?: Record<string, unknown> | undefined
  result: RunTurnNonInteractiveResponse['result']
}

function toFrontend(provider: HrcProvider): 'agent-sdk' | 'pi-sdk' {
  return provider === 'openai' ? 'pi-sdk' : 'agent-sdk'
}

function toEventKind(event: AgentEvent): string {
  if (event.type === 'state') {
    return `sdk.${event.state}`
  }
  return `sdk.${event.type}`
}

function toEventJson(event: AgentEvent): Record<string, unknown> {
  const { ts, seq, hostSessionId, cpSessionId, runId, continuation, ...rest } = event
  return {
    ...rest,
    ...(cpSessionId ? { cpSessionId } : {}),
    ...(continuation ? { continuation } : {}),
  }
}

function inferHarnessSessionJson(
  provider: HrcProvider,
  frontend: 'agent-sdk' | 'pi-sdk',
  continuation?: HrcContinuationRef | undefined
): Record<string, unknown> {
  return {
    provider,
    frontend,
    ...(frontend === 'agent-sdk' && continuation?.key ? { sdkSessionId: continuation.key } : {}),
  }
}

async function defaultRunner(
  request: RunTurnNonInteractiveRequest,
  intent: HrcRuntimeIntent
): Promise<RunTurnNonInteractiveResponse> {
  if (intent.placement.dryRun === true) {
    const provider = request.frontend === 'pi-sdk' ? 'openai' : 'anthropic'
    const continuation =
      request.frontend === 'pi-sdk'
        ? undefined
        : ({
            provider,
            key: `sdk-${createHash('sha1')
              .update(request.hostSessionId ?? request.runId)
              .digest('hex')
              .slice(0, 12)}`,
          } satisfies HrcContinuationRef)

    const base = {
      hostSessionId: request.hostSessionId ?? 'unknown-host-session',
      runId: request.runId,
      ts: new Date().toISOString(),
      seq: 1,
      ...(continuation ? { continuation } : {}),
    }

    await request.callbacks.onEvent({
      ...base,
      type: 'state',
      state: 'running',
    } as AgentEvent)
    await request.callbacks.onEvent({
      ...base,
      seq: 2,
      type: 'message',
      role: 'assistant',
      content: `Dry run SDK response for: ${request.prompt}`,
    } as AgentEvent)
    await request.callbacks.onEvent({
      ...base,
      seq: 3,
      type: 'complete',
      result: { success: true, finalOutput: `Dry run SDK response for: ${request.prompt}` },
    } as AgentEvent)

    return {
      ...(continuation ? { continuation } : {}),
      provider,
      frontend: request.frontend,
      model: request.model,
      result: { success: true, finalOutput: `Dry run SDK response for: ${request.prompt}` },
    }
  }

  return createAgentSpacesClient().runTurnNonInteractive(request)
}

export async function runSdkTurn(options: SdkTurnOptions): Promise<SdkTurnResult> {
  if (options.intent.harness.interactive !== false) {
    throw new UnsupportedHarnessError('interactive')
  }

  if (
    options.existingProvider !== undefined &&
    options.existingProvider !== options.intent.harness.provider
  ) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.PROVIDER_MISMATCH,
      `provider mismatch: existing runtime provider is "${options.existingProvider}" but request requires "${options.intent.harness.provider}"`,
      {
        existingProvider: options.existingProvider,
        requestedProvider: options.intent.harness.provider,
      }
    )
  }

  const frontend = toFrontend(options.intent.harness.provider)
  const runner =
    options.runner ??
    ((request: RunTurnNonInteractiveRequest) => defaultRunner(request, options.intent))

  const onHrcEvent = options.onHrcEvent ?? (() => {})
  const onBuffer = options.onBuffer ?? (() => {})

  const response = await runner({
    aspHome: '',
    spec: { spaces: [] },
    cwd: '/',
    placement: options.intent.placement,
    frontend,
    model: options.intent.harness.model,
    prompt: options.prompt,
    runId: options.runId,
    hostSessionId: options.hostSessionId,
    ...(options.continuation ? { continuation: options.continuation } : {}),
    callbacks: {
      onEvent: async (event) => {
        await onHrcEvent({
          ts: event.ts,
          hostSessionId: options.hostSessionId,
          scopeRef: options.scopeRef,
          laneRef: options.laneRef,
          generation: options.generation,
          runId: options.runId,
          runtimeId: options.runtimeId,
          source: 'agent-spaces',
          eventKind: toEventKind(event),
          eventJson: toEventJson(event),
        })

        if (event.type === 'message_delta' && event.role === 'assistant') {
          await onBuffer(event.delta)
        }

        if (event.type === 'message' && event.role === 'assistant') {
          await onBuffer(event.content)
        }
      },
    },
  })

  const continuation = response.continuation as HrcContinuationRef | undefined
  const harnessSessionJson = inferHarnessSessionJson(
    response.provider as HrcProvider,
    response.frontend,
    continuation
  )

  return {
    ...(continuation ? { continuation } : {}),
    provider: response.provider as HrcProvider,
    frontend: response.frontend,
    model: response.model,
    harnessSessionJson,
    result: response.result,
  }
}
