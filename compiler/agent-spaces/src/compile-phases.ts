import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request compile phase timings (T-08787). A host such as aspd opens a
 * recording scope around one request; compiler code marks its phases with
 * `timeCompilePhase`. Outside a scope marking is a pass-through, so in-process
 * compiles (HRC, CLI) pay nothing.
 */
export type CompilePhaseTimings = Record<string, number>

const phaseStore = new AsyncLocalStorage<CompilePhaseTimings>()

/** Run `operation` with a fresh phase table; phases it marks land in the table. */
export async function recordCompilePhases<T>(
  operation: () => Promise<T>
): Promise<{ result: T; phases: CompilePhaseTimings }> {
  const phases: CompilePhaseTimings = {}
  const result = await phaseStore.run(phases, operation)
  return { result, phases }
}

/** Time one phase. Repeated names accumulate. */
export async function timeCompilePhase<T>(
  name: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const phases = phaseStore.getStore()
  if (phases === undefined) return await operation()
  const startedAt = performance.now()
  try {
    return await operation()
  } finally {
    phases[name] = round((phases[name] ?? 0) + performance.now() - startedAt)
  }
}

/** Synchronous variant for phases with no await inside. */
export function timeCompilePhaseSync<T>(name: string, operation: () => T): T {
  const phases = phaseStore.getStore()
  if (phases === undefined) return operation()
  const startedAt = performance.now()
  try {
    return operation()
  } finally {
    phases[name] = round((phases[name] ?? 0) + performance.now() - startedAt)
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10
}
