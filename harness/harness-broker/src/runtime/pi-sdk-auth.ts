import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../drivers/driver'

/**
 * The broker-resolved auth binding for a pi-SDK-backed invocation: selectors
 * plus a credential-store path. It deliberately carries NO credential material,
 * which is what lets it be projected across a process boundary (the
 * `agent-harness-control/v1` `session.config` frame) unchanged.
 */
export interface PiSdkAuthResolution {
  authMode: 'api-key' | 'oauth'
  authPath: string
  providerId: string
  credentialType: 'api-key' | 'oauth'
  storeBound: boolean
}

/**
 * Reads a stored credential out of a pi auth store. Injected rather than
 * imported so `spaces-harness-broker` stays free of a `@earendil-works/pi-coding-agent`
 * dependency (which would invert the `spaces-harness-broker-pi-sdk ->
 * spaces-harness-broker` edge into a cycle). The pi-SDK driver and the
 * `agent-harness` broker binary both supply the real reader.
 */
export type PiSdkStoredCredentialReader = (
  providerId: string,
  authPath: string
) => { type?: string | undefined } | undefined

export class PiSdkAuthError extends Error {
  constructor(
    readonly code: 'missing_auth_store' | 'auth_mode_mismatch' | 'missing_credential_reader',
    message: string
  ) {
    super(message)
    this.name = 'PiSdkAuthError'
  }
}

/** Per-invocation agent directory used as the api-key auth-store location. */
export function piSdkAgentDir(spec: HarnessInvocationSpec): string {
  return join(tmpdir(), 'harness-broker-pi-sdk', String(spec.invocationId ?? 'session'))
}

/**
 * Resolve the auth binding for a pi-SDK-backed invocation from the hash-covered
 * spec plus the dispatch env. The single source for BOTH the in-process pi-sdk
 * driver and the `agent-harness-tmux` driver's `session.config` projection, so
 * the interactive surface binds the same value the headless one does rather
 * than one that merely happens to match.
 */
export async function resolvePiSdkAuth(
  spec: HarnessInvocationSpec,
  ctx: Pick<DriverContext, 'dispatchEnv'>,
  options: { readStoredCredential?: PiSdkStoredCredentialReader | undefined } = {}
): Promise<PiSdkAuthResolution> {
  const sdk = spec.sdk
  if (sdk === undefined) throw new Error('pi-sdk invocation requires spec.sdk')

  const providerId = sdk.provider
  if (sdk.authMode === 'api-key') {
    return {
      authMode: 'api-key',
      authPath: join(piSdkAgentDir(spec), 'auth.json'),
      providerId,
      credentialType: 'api-key',
      storeBound: false,
    }
  }

  const authPath = ctx.dispatchEnv?.['HARNESS_PI_AUTH_STORE']
  if (authPath === undefined || authPath.trim().length === 0) {
    throw new PiSdkAuthError(
      'missing_auth_store',
      'OAuth mode requires dispatchEnv.HARNESS_PI_AUTH_STORE'
    )
  }

  try {
    const encoded = await readFile(authPath, 'utf8')
    JSON.parse(encoded)
  } catch {
    throw new PiSdkAuthError(
      'missing_auth_store',
      `OAuth auth store is missing or unreadable: ${authPath}`
    )
  }

  const readStoredCredential = options.readStoredCredential
  if (readStoredCredential === undefined) {
    throw new PiSdkAuthError(
      'missing_credential_reader',
      'OAuth mode requires a stored-credential reader; none was supplied to resolvePiSdkAuth'
    )
  }

  const credential = readStoredCredential(providerId, authPath)
  if (credential?.type !== 'oauth') {
    throw new PiSdkAuthError(
      'auth_mode_mismatch',
      `OAuth auth store credential for provider ${providerId} is not OAuth-typed`
    )
  }

  return {
    authMode: 'oauth',
    authPath,
    providerId,
    credentialType: 'oauth',
    storeBound: true,
  }
}
