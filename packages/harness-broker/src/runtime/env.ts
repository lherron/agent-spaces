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

  return env
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
