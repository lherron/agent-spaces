/** Shared error normalization helpers for the codex harness package. */

/** Normalize any thrown value to a human-readable message string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Coerce any thrown value into an `Error` instance. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
