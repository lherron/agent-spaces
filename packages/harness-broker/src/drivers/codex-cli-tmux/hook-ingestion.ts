export type CodexHookEnvelopeEnv = {
  invocationId: string
  generation: number
  callbackSocket?: string | undefined
  runtimeId?: string | undefined
  turnId?: string | undefined
}

export type CodexHookEnvelope = {
  invocationId: string
  generation: number
  callbackSocket?: string | undefined
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData: unknown
}

export function buildCodexHookEnvelope(
  hookData: unknown,
  env: CodexHookEnvelopeEnv
): CodexHookEnvelope {
  return {
    invocationId: env.invocationId,
    generation: env.generation,
    ...(env.callbackSocket !== undefined ? { callbackSocket: env.callbackSocket } : {}),
    ...(env.runtimeId !== undefined ? { runtimeId: env.runtimeId } : {}),
    ...(env.turnId !== undefined ? { turnId: env.turnId } : {}),
    hookData,
  }
}

export function buildCodexHookEnvelopeFromEnv(
  hookData: unknown,
  env: Record<string, string | undefined>
): CodexHookEnvelope {
  const invocationId = env['HARNESS_BROKER_INVOCATION_ID']
  const generationText = env['HARNESS_BROKER_HOOK_GENERATION']
  if (invocationId === undefined || generationText === undefined) {
    const missing = [
      invocationId === undefined ? 'HARNESS_BROKER_INVOCATION_ID' : undefined,
      generationText === undefined ? 'HARNESS_BROKER_HOOK_GENERATION' : undefined,
    ].filter((name): name is string => name !== undefined)
    throw new Error(`missing required hook environment: ${missing.join(', ')}`)
  }

  const generation = Number.parseInt(generationText, 10)
  if (Number.isNaN(generation)) {
    throw new Error(`invalid HARNESS_BROKER_HOOK_GENERATION: ${generationText}`)
  }

  return buildCodexHookEnvelope(hookData, {
    invocationId,
    generation,
    callbackSocket: env['HARNESS_BROKER_CALLBACK_SOCKET'],
    runtimeId: env['HARNESS_BROKER_RUNTIME_ID'],
    turnId: env['HARNESS_BROKER_TURN_ID'],
  })
}
