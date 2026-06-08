import type { CompileDiagnostic } from 'spaces-runtime-contracts'

// Single source of truth for ASPC diagnostic codes so the string literals are
// not duplicated across the service and profile-selection paths.
export const DIAGNOSTIC_CODES = {
  compilerException: 'compiler_exception',
  brokerProfileMissing: 'broker_profile_missing',
  brokerProfileAmbiguous: 'broker_profile_ambiguous',
} as const

export function compilerDiagnostic(
  code: string,
  message: string,
  details?: unknown
): CompileDiagnostic {
  return {
    level: 'error',
    code,
    message,
    plane: 'asp-compiler',
    ...(details !== undefined ? { details } : {}),
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function errorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, stack: error.stack }
  }
  return error
}
