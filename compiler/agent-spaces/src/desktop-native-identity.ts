import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const MAX_HEADER_BYTES = 256 * 1024

export type DesktopIdentityRequest = {
  schemaVersion: 'aspc-resolve-desktop-identity-request/v1'
  nativeThreadId: string
  reported: { codexHome?: string; sqliteHome?: string; rolloutPath?: string }
  fallbackHomeDir: string
}
export type AdmitDesktopRegistrationRequest = {
  identity: {
    nativeThreadId: string
    homeIdentity: string
    sqliteHome: string
    registrationKey: string
    homeBasis: string
  }
  rolloutPath?: string
  reportedWorkspaceCwd?: string
}

function rolloutHome(path: string): string | undefined {
  const marker = `${sep}sessions${sep}`
  const index = path.lastIndexOf(marker)
  return index < 0 ? undefined : path.slice(0, index)
}

async function canonical(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch {
    return absolute
  }
}

export async function resolveDesktopIdentity(request: DesktopIdentityRequest) {
  const reportedRolloutHome = request.reported.rolloutPath
    ? rolloutHome(request.reported.rolloutPath)
    : undefined
  const selected = request.reported.codexHome
    ? { path: request.reported.codexHome, basis: 'reported-home' as const }
    : reportedRolloutHome
      ? { path: reportedRolloutHome, basis: 'rollout-path' as const }
      : { path: join(request.fallbackHomeDir, '.codex'), basis: 'fallback-home' as const }
  const homeIdentity =
    selected.basis === 'fallback-home'
      ? join(await canonical(request.fallbackHomeDir), '.codex')
      : await canonical(selected.path)
  const sqliteHome = request.reported.sqliteHome
    ? await canonical(request.reported.sqliteHome)
    : homeIdentity
  const registrationKey = createHash('sha256')
    .update(homeIdentity, 'utf8')
    .update('\0')
    .update(request.nativeThreadId.toLowerCase(), 'utf8')
    .digest('hex')
  return {
    schemaVersion: 'aspc-resolve-desktop-identity-response/v1' as const,
    ok: true as const,
    identity: {
      nativeThreadId: request.nativeThreadId,
      homeIdentity,
      sqliteHome,
      registrationKey,
      homeBasis: selected.basis,
    },
  }
}

async function firstLine(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(10)
    if (newline < 0 || newline > MAX_HEADER_BYTES) throw new Error('oversized header')
    return buffer.subarray(0, newline).toString('utf8')
  } finally {
    await handle.close()
  }
}

function pending(reason: string, detail: string) {
  return {
    schemaVersion: 'aspc-admit-desktop-registration-response/v1' as const,
    ok: true as const,
    verdict: 'pending' as const,
    pending: { reason, detail },
  }
}

export async function admitDesktopRegistration(request: AdmitDesktopRegistrationRequest) {
  if (!request.rolloutPath) {
    return pending('native_metadata_unavailable', 'No Desktop rollout path was reported')
  }
  const candidate = resolve(request.rolloutPath)
  if (candidate.includes(`${sep}archived_sessions${sep}`)) {
    return pending('archived_history', 'Archived Desktop history cannot be registered')
  }
  let line: string
  try {
    line = await firstLine(candidate)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
      return pending(
        'native_metadata_unavailable',
        error instanceof Error ? error.message : String(error)
      )
    }
    return pending(
      'native_metadata_unparsable',
      error instanceof Error ? error.message : String(error)
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return pending(
      'native_metadata_unparsable',
      error instanceof Error ? error.message : String(error)
    )
  }
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  const payload =
    record?.['type'] === 'session_meta' &&
    typeof record['payload'] === 'object' &&
    record['payload'] !== null
      ? (record['payload'] as Record<string, unknown>)
      : undefined
  const metadataThreadId = payload?.['session_id'] ?? payload?.['id']
  if (!payload || typeof metadataThreadId !== 'string') {
    return pending('native_metadata_unparsable', 'First line is not a Desktop session_meta record')
  }
  if (metadataThreadId.toLowerCase() !== request.identity.nativeThreadId.toLowerCase()) {
    return pending('native_thread_mismatch', 'Desktop rollout thread does not match registration')
  }
  if (
    typeof payload['source'] === 'object' ||
    String(payload['thread_source'] ?? '').includes('guardian')
  ) {
    return pending('spawned_subagent', 'Spawned Desktop subagent threads are not registrable')
  }
  if (payload['source'] !== 'vscode') {
    return pending('non_desktop_source', 'Desktop session source must be vscode')
  }
  if (payload['thread_source'] !== 'user') {
    return pending('non_user_thread', 'Desktop session thread_source must be user')
  }
  if (
    typeof payload['originator'] !== 'string' ||
    !payload['originator'].toLowerCase().includes('desktop')
  ) {
    return pending('non_desktop_originator', 'Desktop session originator must identify Desktop')
  }
  const workspaceCwd =
    typeof payload['cwd'] === 'string' && payload['cwd'].length > 0
      ? payload['cwd']
      : request.reportedWorkspaceCwd
  if (!workspaceCwd) return pending('workspace_unknown', 'Desktop workspace is unavailable')
  return {
    schemaVersion: 'aspc-admit-desktop-registration-response/v1' as const,
    ok: true as const,
    verdict: 'admitted' as const,
    admitted: {
      nativeThreadId: request.identity.nativeThreadId,
      rolloutPath: candidate,
      workspaceCwd,
      metadata: {
        ...(typeof payload['cli_version'] === 'string'
          ? { cliVersion: payload['cli_version'] }
          : {}),
        source: 'vscode' as const,
        threadSource: 'user' as const,
        originator: payload['originator'],
      },
    },
  }
}
