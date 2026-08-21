/**
 * Compile-time clock resolution (P0 hash epoch, scope B).
 *
 * Every config-plane output timestamp that used to read the ambient host clock
 * now resolves through here, threading the caller's {@link CompileContext}. This
 * is the ONE blessed fallback point for the config plane: when no compile
 * context is supplied (the production default documented on `CompileContext`),
 * real time is stamped exactly as before; when one is supplied, the pinned
 * instant is stamped and the output is reproducible.
 *
 * Deliberately written in the `injected ?? ambient` / `injected !== undefined ?`
 * shapes so the acceptance census recognizes it as an injected-clock fallback
 * rather than an unpinnable ambient read.
 */
import type { CompileContext } from 'spaces-runtime-contracts'

/** ISO-8601 instant to stamp into compiler output. */
export function resolveNowIso(compileContext?: CompileContext | undefined): string {
  return compileContext?.nowIso ?? new Date().toISOString()
}

/** Epoch milliseconds for the same instant {@link resolveNowIso} would stamp. */
export function resolveNowMs(compileContext?: CompileContext | undefined): number {
  const nowIso = compileContext?.nowIso
  return nowIso !== undefined ? Date.parse(nowIso) : Date.now()
}

/** `Date` for the same instant {@link resolveNowIso} would stamp. */
export function resolveNowDate(compileContext?: CompileContext | undefined): Date {
  const nowIso = compileContext?.nowIso
  return nowIso !== undefined ? new Date(nowIso) : new Date()
}
