/**
 * Redaction stubs for Phase 3.
 *
 * Phase 1 does not implement env/secret scrubbing. These placeholders
 * provide the import surface so the module structure is in place.
 */

/** Strip env values from payloads. No-op stub for Phase 3. */
export function redactEnv(_payload: unknown): unknown {
  return _payload
}

/** Strip authorization headers/tokens from diagnostic payloads. No-op stub for Phase 3. */
export function redactSecrets(_text: string): string {
  return _text
}
