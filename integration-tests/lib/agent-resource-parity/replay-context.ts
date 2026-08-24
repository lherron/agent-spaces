import type { ContextResolverContext } from 'spaces-runtime'

/** Fixed replay context shared verbatim by both producer observations. */
export function createParityReplayContext(
  input: Omit<ContextResolverContext, 'now'>
): ContextResolverContext {
  return {
    ...input,
    now: new Date('2026-08-24T00:00:00.000Z'),
    execResults: input.execResults ?? [],
    serviceProbeResponses: input.serviceProbeResponses ?? [],
  }
}
