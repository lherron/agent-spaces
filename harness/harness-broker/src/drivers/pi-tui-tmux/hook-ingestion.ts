export type PiHookEnvelopeEnv = {
  invocationId: string
  generation: number
  callbackSocket: string
  runtimeId?: string | undefined
  turnId?: string | undefined
}

export type PiTuiTmuxHookEnvelope = {
  invocationId: string
  generation: number
  callbackSocket: string
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData: unknown
}

function buildPiHookEnvelope(hookData: unknown, env: PiHookEnvelopeEnv): PiTuiTmuxHookEnvelope {
  return {
    invocationId: env.invocationId,
    generation: env.generation,
    callbackSocket: env.callbackSocket,
    ...(env.runtimeId !== undefined ? { runtimeId: env.runtimeId } : {}),
    ...(env.turnId !== undefined ? { turnId: env.turnId } : {}),
    hookData,
  }
}

export function buildPiHookEnvelopeFromEnv(
  hookData: unknown,
  env: Record<string, string | undefined>
): PiTuiTmuxHookEnvelope {
  const invocationId = env['HARNESS_BROKER_INVOCATION_ID']
  const generationText = env['HARNESS_BROKER_HOOK_GENERATION']
  const callbackSocket = env['HARNESS_BROKER_CALLBACK_SOCKET']
  if (invocationId === undefined || generationText === undefined || callbackSocket === undefined) {
    const missing = [
      invocationId === undefined ? 'HARNESS_BROKER_INVOCATION_ID' : undefined,
      generationText === undefined ? 'HARNESS_BROKER_HOOK_GENERATION' : undefined,
      callbackSocket === undefined ? 'HARNESS_BROKER_CALLBACK_SOCKET' : undefined,
    ].filter((name): name is string => name !== undefined)
    throw new Error(`missing required hook environment: ${missing.join(', ')}`)
  }

  const generation = Number.parseInt(generationText, 10)
  if (Number.isNaN(generation)) {
    throw new Error(`invalid HARNESS_BROKER_HOOK_GENERATION: ${generationText}`)
  }

  return buildPiHookEnvelope(hookData, {
    invocationId,
    generation,
    callbackSocket,
    runtimeId: env['HARNESS_BROKER_RUNTIME_ID'],
    turnId: env['HARNESS_BROKER_TURN_ID'],
  })
}
