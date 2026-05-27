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
