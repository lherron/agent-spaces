import { spawn } from 'node:child_process'
import type { InvocationInput } from 'spaces-harness-broker-protocol'
import { errorMessage } from '../../errors'
import { buildCodexInput } from '../codex-app-server/input'
import { CodexRpcClient, type CodexRpcPeer } from '../codex-app-server/rpc-client'
import { asCodexRecord } from '../codex-rollout/native'
import { getString } from '../hook-json'
import { CODEX_DESKTOP_DRIVER_VERSION, type CodexDesktopDriverSpec } from './spec'

/** The desktop app's experimental `thread/queue/*` surface, one connection per use. */
export interface CodexDesktopQueueHelper {
  list(threadId: string, cursor?: string): Promise<unknown>
  add(threadId: string, input: InvocationInput, clientUserMessageId: string): Promise<unknown>
  delete(threadId: string, queuedSubmissionId: string): Promise<unknown>
  close(): void
}

export function queueSubmissionId(value: unknown): string | undefined {
  const record = asCodexRecord(value) ?? {}
  return (
    getString(record, 'queuedSubmissionId') ??
    getString(record, 'id') ??
    getString(asCodexRecord(record['queuedSubmission']) ?? {}, 'id') ??
    getString(asCodexRecord(record['submission']) ?? {}, 'id')
  )
}

function queueEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map((entry) => asCodexRecord(entry) ?? {})
  const record = asCodexRecord(value) ?? {}
  for (const key of ['data', 'items', 'queue', 'submissions']) {
    const entries = record[key]
    if (Array.isArray(entries)) return entries.map((entry) => asCodexRecord(entry) ?? {})
  }
  return []
}

export function queueEntryId(entry: Record<string, unknown>): string | undefined {
  return (
    getString(entry, 'queuedSubmissionId') ??
    getString(entry, 'id') ??
    getString(asCodexRecord(entry['queuedSubmission']) ?? {}, 'id')
  )
}

export function queueEntryClientId(entry: Record<string, unknown>): string | undefined {
  return (
    getString(entry, 'clientUserMessageId') ??
    getString(entry, 'client_id') ??
    getString(asCodexRecord(entry['queuedSubmission']) ?? {}, 'clientUserMessageId')
  )
}

/** Every queued row across all `thread/queue/list` pages; a repeated cursor is an error. */
export async function listAllQueued(
  helper: CodexDesktopQueueHelper,
  threadId: string
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await helper.list(threadId, cursor)
    entries.push(...queueEntries(page))
    const nextCursor = getString(asCodexRecord(page) ?? {}, 'nextCursor')
    if (nextCursor === undefined || nextCursor.length === 0) return entries
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Codex thread/queue/list repeated cursor ${nextCursor}`)
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
}

/** Spawn the desktop bundle's own `codex app-server` against the desktop's homes. */
export async function openBundledQueueHelper(
  spec: CodexDesktopDriverSpec
): Promise<CodexDesktopQueueHelper> {
  const proc = spawn(spec.bundleExecutable, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: spec.codexHome,
      CODEX_SQLITE_HOME: spec.sqliteHome,
    },
  })
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4096)
  })
  const rpc: CodexRpcPeer = new CodexRpcClient(proc)
  try {
    await rpc.sendRequest('initialize', {
      clientInfo: { name: 'harness-broker-codex-desktop', version: CODEX_DESKTOP_DRIVER_VERSION },
      capabilities: { experimentalApi: true },
    })
    await rpc.sendNotification('initialized', {})
  } catch (error) {
    rpc.close()
    if (proc.exitCode === null) proc.kill('SIGTERM')
    throw new Error(
      `Desktop-bundled Codex app-server initialization failed: ${errorMessage(error)}${
        stderr.trim().length > 0 ? `; stderr: ${stderr.trim()}` : ''
      }`
    )
  }
  return {
    list(threadId, cursor) {
      return rpc.sendRequest('thread/queue/list', {
        threadId,
        ...(cursor !== undefined ? { cursor } : {}),
      })
    },
    add(threadId, input, clientUserMessageId) {
      return rpc.sendRequest('thread/queue/add', {
        threadId,
        input: buildCodexInput(input, undefined),
        clientUserMessageId,
      })
    },
    delete(threadId, queuedSubmissionId) {
      return rpc.sendRequest('thread/queue/delete', { threadId, queuedSubmissionId })
    },
    close() {
      rpc.close()
      if (proc.exitCode === null) proc.kill('SIGTERM')
    },
  }
}
