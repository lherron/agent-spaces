import { delimiter, isAbsolute } from 'node:path'
import {
  BrokerErrorCode,
  ENV_KEY_PATTERN,
  isAmbientEnvKey,
  isCredentialEnvKey,
  isReservedEnvKey,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'

/**
 * The broker spawn environment is a VALIDATED DISJOINT UNION of four channels:
 *
 *   ambientAllowlist ⊎ credentials ⊎ lockedEnv ⊎ dispatchEnv
 *
 * Channels are disjoint by construction — a key present in more than one
 * channel is an ERROR, not a precedence decision. There is no last-write-wins.
 *
 * 1. ambientAllowlist — inherited from the broker's own `process.env`, limited
 *    to a fixed allowlist (HOME PATH SHELL TMPDIR TEMP TMP USER USERNAME TERM
 *    LANG LC_ TZ). NODE_, SSH_AUTH_SOCK, proxy, and XDG_ vars are reserved,
 *    not plain ambient.
 * 2. credentials — a driver-provided map. EMPTY for the codex driver: codex
 *    auth is file-based (auth.json on disk via CODEX_HOME, a lockedEnv path);
 *    no credential ever enters the spawn env. The parameter exists for spec
 *    fidelity / future drivers.
 * 3. lockedEnv — ASP-declared, non-secret config from `spec.process.lockedEnv`.
 * 4. dispatchEnv — per-invocation correlation/handles from the
 *    `InvocationDispatchRequest` envelope (never hashed, never in the spec).
 *
 * Key-class rules (reusing the shared protocol validators): lockedEnv and
 * dispatchEnv keys MUST NOT be ambient, credential, or reserved keys, and
 * dispatchEnv MUST NOT shadow a lockedEnv key (caught here as a collision).
 */
export interface ProcessEnvChannels {
  credentials?: Record<string, string> | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /**
   * Ordered directories prepended to the FINAL composed PATH (from
   * `spec.process.pathPrepend`). Applied AFTER the four-channel disjoint-union
   * compose. This is the one controlled mutation of the reserved PATH key — a
   * pathPrepend entry already present in ambient PATH is NOT a collision.
   */
  pathPrepend?: string[] | undefined
}

type ChannelName = 'credentials' | 'lockedEnv' | 'dispatchEnv'

export function buildProcessEnv(channels: ProcessEnvChannels): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  // Channel 1: ambient allowlist, sourced from the broker's own environment.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAmbientEnvKey(key)) {
      env[key] = value
    }
  }

  // Channels 2–4: composed disjointly. Collisions across channels are errors.
  assignChannel(env, 'credentials', channels.credentials)
  assignChannel(env, 'lockedEnv', channels.lockedEnv)
  assignChannel(env, 'dispatchEnv', channels.dispatchEnv)

  // PATH mutation: applied after the disjoint-union compose. PATH itself is
  // ambient/reserved and never enters via lockedEnv/dispatchEnv.
  applyPathPrepend(env, channels.pathPrepend)

  return env
}

/**
 * Prepend the validated `pathPrepend` directories to the composed PATH, in
 * array order, using the platform delimiter. If the composed PATH is
 * absent/empty, the final PATH is the joined prepend list.
 */
function applyPathPrepend(env: NodeJS.ProcessEnv, pathPrepend: string[] | undefined): void {
  if (pathPrepend === undefined || pathPrepend.length === 0) {
    return
  }
  validatePathPrepend(pathPrepend)
  const prefix = pathPrepend.join(delimiter)
  const ambient = env['PATH']
  env['PATH'] = ambient && ambient.length > 0 ? `${prefix}${delimiter}${ambient}` : prefix
}

/**
 * Broker spawn validation for pathPrepend entries. Rejects empty strings,
 * non-absolute paths, NUL bytes, delimiter-containing entries, and duplicates.
 * Does NOT consult ambient PATH — validity must not depend on its contents.
 * Existence of the directory is a runtime concern, not a validity check.
 */
function validatePathPrepend(pathPrepend: string[]): void {
  const seen = new Set<string>()
  for (const entry of pathPrepend) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        'pathPrepend entry must be a non-empty string',
        { entry }
      )
    }
    if (entry.includes('\0')) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        'pathPrepend entry must not contain a NUL byte',
        { entry }
      )
    }
    if (entry.includes(delimiter)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `pathPrepend entry must not contain the path delimiter "${delimiter}": ${entry}`,
        { entry }
      )
    }
    if (!isAbsolute(entry)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `pathPrepend entry must be an absolute path: ${entry}`,
        { entry }
      )
    }
    if (seen.has(entry)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `pathPrepend contains a duplicate entry: ${entry}`,
        { entry }
      )
    }
    seen.add(entry)
  }
}

function assignChannel(
  env: NodeJS.ProcessEnv,
  channel: ChannelName,
  source: Record<string, string> | undefined
): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new BrokerError(BrokerErrorCode.ResourceError, `Invalid environment key: ${key}`, {
        key,
        channel,
      })
    }

    // Class disjointness: lockedEnv/dispatchEnv must not collide with the
    // ambient, credential, or reserved key classes. credentials is the one
    // channel allowed to carry credential keys.
    if (channel !== 'credentials' && isCredentialEnvKey(key)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `${channel} key conflicts with credential env: ${key}`,
        { key, channel }
      )
    }
    if (isAmbientEnvKey(key)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `${channel} key conflicts with ambient env: ${key}`,
        { key, channel }
      )
    }
    if (isReservedEnvKey(key)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `${channel} key is reserved: ${key}`,
        { key, channel }
      )
    }

    // Instance disjointness: a concrete key may appear in at most one channel.
    // This also enforces "dispatchEnv must not shadow lockedEnv" at spawn time.
    if (Object.hasOwn(env, key)) {
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        `Environment key collision across channels: ${key}`,
        { key, channel }
      )
    }

    env[key] = value
  }
}
