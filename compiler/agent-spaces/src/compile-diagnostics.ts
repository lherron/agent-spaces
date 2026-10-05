import type { HygieneGateFinding } from 'spaces-config'
import { MaterializationHygieneError } from 'spaces-config'
import type {
  CompileDiagnostic,
  ProfileId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

export function compileError(code: string, message: string, details?: unknown): CompileDiagnostic {
  return {
    level: 'error',
    code,
    message,
    plane: 'asp-compiler',
    ...(details !== undefined ? { details } : {}),
  }
}

/**
 * Stable diagnostic code for a compose-time hygiene cache-admission finding —
 * carried on the normal ASPC diagnostics channel by BOTH the blocking (error) and
 * force-compose (warning) paths so callers key on one code (T-05574 Cond 1/4).
 */
const MATERIALIZATION_HYGIENE_ERROR_CODE = 'materialization_hygiene_error'

/** Structured `details` payload for one hygiene finding (stable field set). */
function hygieneFindingDetails(f: HygieneGateFinding): Record<string, unknown> {
  return {
    spaceKey: f.spaceKey,
    pluginPath: f.pluginPath,
    code: f.code,
    severity: f.severity,
    ...(f.path !== undefined ? { path: f.path } : {}),
  }
}

/** Deterministic finding order for diagnostics: by hygiene code, then path. */
export function sortHygieneFindings(findings: HygieneGateFinding[]): HygieneGateFinding[] {
  return [...findings].sort(
    (a, b) => a.code.localeCompare(b.code) || (a.path ?? '').localeCompare(b.path ?? '')
  )
}

/** One WARNING diagnostic for a force-admitted hygiene finding (Cond 4). */
export function hygieneWarningDiagnostic(
  f: HygieneGateFinding,
  profileId: ProfileId | undefined
): CompileDiagnostic {
  return {
    level: 'warning',
    code: MATERIALIZATION_HYGIENE_ERROR_CODE,
    message: f.message,
    plane: 'asp-compiler',
    ...(profileId !== undefined ? { profileId } : {}),
    details: hygieneFindingDetails(f),
  }
}

/**
 * Convert a blocking hygiene gate error into typed ERROR diagnostics (Cond 1). One
 * diagnostic per finding, deterministic order, on the normal ASPC diagnostics
 * channel — NOT degraded to `compiler_exception`.
 */
function hygieneErrorToDiagnostics(err: MaterializationHygieneError): CompileDiagnostic[] {
  return sortHygieneFindings(err.findings).map((f) => ({
    level: 'error' as const,
    code: MATERIALIZATION_HYGIENE_ERROR_CODE,
    message: f.message,
    plane: 'asp-compiler' as const,
    details: hygieneFindingDetails(f),
  }))
}

/**
 * Convert a compose-time hygiene gate block into an `ok: false` compile response
 * BEFORE it reaches the aspc facade's generic `compiler_exception` catch (Cond 1);
 * returns `undefined` for every other error so it propagates unchanged. Exported
 * for direct unit testing — the routing that throws it is exercised e2e.
 */
export function hygieneBlockResponse(error: unknown): RuntimeCompileResponse | undefined {
  if (error instanceof MaterializationHygieneError) {
    return {
      schemaVersion: 'agent-runtime-compile-response/v2',
      ok: false,
      diagnostics: hygieneErrorToDiagnostics(error),
    }
  }
  return undefined
}

export function requestedDisallowedTools(req: RuntimeCompileRequest): string[] | undefined {
  const tools = req.hrcPolicy.disallowedTools
  return tools !== undefined && tools.length > 0 ? [...tools] : undefined
}

export function disallowedToolsUnsupportedDiagnostic(
  req: RuntimeCompileRequest,
  selectedDriver: string,
  profileId?: ProfileId | undefined
): CompileDiagnostic | undefined {
  const disallowedTools = requestedDisallowedTools(req)
  if (disallowedTools === undefined) return undefined
  return {
    level: 'warning',
    code: 'disallowed_tools_unsupported_driver',
    message: `hrcPolicy.disallowedTools was not applied for ${selectedDriver}; only claude-code-tmux currently supports compiler-enforced tool denial.`,
    plane: 'asp-compiler',
    ...(profileId !== undefined ? { profileId } : {}),
    details: { selectedDriver, disallowedTools, applied: false },
  }
}
