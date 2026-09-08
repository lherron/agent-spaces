import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type CodexDesktopAttemptState =
  | 'prepared'
  | 'writing'
  | 'queued'
  | 'executed'
  | 'indeterminate'
  | 'rejected'
  | 'cancelled'

export interface CodexDesktopNativeAttempt {
  installationKey: string
  invocationId: string
  inputId: string
  clientUserMessageId: string
  threadId: string
  principalRef?: string | undefined
  scopeRef?: string | undefined
  envelopeId?: string | undefined
  observationWatermark: number
  state: CodexDesktopAttemptState
  queuedSubmissionId?: string | undefined
  turnId?: string | undefined
  detail?: string | undefined
  createdAt: string
  updatedAt: string
}

export interface CodexDesktopNativeAttemptStore {
  prepare(
    row: Omit<CodexDesktopNativeAttempt, 'state' | 'createdAt' | 'updatedAt'>
  ): CodexDesktopNativeAttempt
  update(
    installationKey: string,
    inputId: string,
    patch: Partial<
      Pick<CodexDesktopNativeAttempt, 'state' | 'queuedSubmissionId' | 'turnId' | 'detail'>
    >
  ): CodexDesktopNativeAttempt
  get(installationKey: string, inputId: string): CodexDesktopNativeAttempt | undefined
  list(installationKey: string): CodexDesktopNativeAttempt[]
  unresolved(installationKey: string): CodexDesktopNativeAttempt | undefined
  close(): void
}

const TERMINAL_STATES = new Set<CodexDesktopAttemptState>(['executed', 'rejected', 'cancelled'])

export function isUnresolvedCodexDesktopAttempt(row: CodexDesktopNativeAttempt): boolean {
  return !TERMINAL_STATES.has(row.state)
}

export function openCodexDesktopNativeAttemptStore(
  path?: string,
  now: () => Date = () => new Date()
): CodexDesktopNativeAttemptStore {
  if (path !== undefined) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path ?? ':memory:', { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(
    `CREATE TABLE IF NOT EXISTS codex_desktop_native_attempt (
       installation_key       TEXT NOT NULL,
       invocation_id          TEXT NOT NULL,
       input_id               TEXT NOT NULL,
       client_user_message_id TEXT NOT NULL,
       thread_id              TEXT NOT NULL,
       principal_ref          TEXT,
       scope_ref              TEXT,
       envelope_id            TEXT,
       observation_watermark  INTEGER NOT NULL,
       state                  TEXT NOT NULL,
       queued_submission_id   TEXT,
       turn_id                TEXT,
       detail                 TEXT,
       created_at             TEXT NOT NULL,
       updated_at             TEXT NOT NULL,
       PRIMARY KEY (installation_key, input_id)
     ) STRICT`
  )
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS codex_desktop_one_unresolved_per_thread
       ON codex_desktop_native_attempt(installation_key)
       WHERE state IN ('prepared', 'writing', 'queued', 'indeterminate')`
  )

  const insert = db.query(
    `INSERT INTO codex_desktop_native_attempt
       (installation_key, invocation_id, input_id, client_user_message_id, thread_id,
        principal_ref, scope_ref, envelope_id, observation_watermark, state,
        queued_submission_id, turn_id, detail, created_at, updated_at)
     VALUES ($installationKey, $invocationId, $inputId, $clientUserMessageId, $threadId,
             $principalRef, $scopeRef, $envelopeId, $observationWatermark, 'prepared',
             $queuedSubmissionId, $turnId, $detail, $createdAt, $updatedAt)`
  )
  const updateRow = db.query(
    `UPDATE codex_desktop_native_attempt SET
       state = COALESCE($state, state),
       queued_submission_id = COALESCE($queuedSubmissionId, queued_submission_id),
       turn_id = COALESCE($turnId, turn_id),
       detail = COALESCE($detail, detail),
       updated_at = $updatedAt
     WHERE installation_key = $installationKey AND input_id = $inputId`
  )
  const selectOne = db.query<StoredAttempt, { $installationKey: string; $inputId: string }>(
    `SELECT * FROM codex_desktop_native_attempt
      WHERE installation_key = $installationKey AND input_id = $inputId`
  )
  const selectAll = db.query<StoredAttempt, { $installationKey: string }>(
    `SELECT * FROM codex_desktop_native_attempt
      WHERE installation_key = $installationKey ORDER BY created_at, input_id`
  )

  function get(installationKey: string, inputId: string): CodexDesktopNativeAttempt | undefined {
    const row = selectOne.get({ $installationKey: installationKey, $inputId: inputId })
    return row === null || row === undefined ? undefined : fromStored(row)
  }

  return {
    prepare(row) {
      const existing = get(row.installationKey, row.inputId)
      if (existing !== undefined) return existing
      const timestamp = now().toISOString()
      insert.run({
        $installationKey: row.installationKey,
        $invocationId: row.invocationId,
        $inputId: row.inputId,
        $clientUserMessageId: row.clientUserMessageId,
        $threadId: row.threadId,
        $principalRef: row.principalRef ?? null,
        $scopeRef: row.scopeRef ?? null,
        $envelopeId: row.envelopeId ?? null,
        $observationWatermark: row.observationWatermark,
        $queuedSubmissionId: row.queuedSubmissionId ?? null,
        $turnId: row.turnId ?? null,
        $detail: row.detail ?? null,
        $createdAt: timestamp,
        $updatedAt: timestamp,
      })
      return get(row.installationKey, row.inputId) as CodexDesktopNativeAttempt
    },

    update(installationKey, inputId, patch) {
      updateRow.run({
        $installationKey: installationKey,
        $inputId: inputId,
        $state: patch.state ?? null,
        $queuedSubmissionId: patch.queuedSubmissionId ?? null,
        $turnId: patch.turnId ?? null,
        $detail: patch.detail ?? null,
        $updatedAt: now().toISOString(),
      })
      const row = get(installationKey, inputId)
      if (row === undefined) throw new Error(`Unknown Codex desktop native attempt: ${inputId}`)
      return row
    },

    get,

    list(installationKey) {
      return selectAll.all({ $installationKey: installationKey }).map(fromStored)
    },

    unresolved(installationKey) {
      return this.list(installationKey).find(isUnresolvedCodexDesktopAttempt)
    },

    close() {
      db.close()
    },
  }
}

interface StoredAttempt {
  installation_key: string
  invocation_id: string
  input_id: string
  client_user_message_id: string
  thread_id: string
  principal_ref: string | null
  scope_ref: string | null
  envelope_id: string | null
  observation_watermark: number
  state: string
  queued_submission_id: string | null
  turn_id: string | null
  detail: string | null
  created_at: string
  updated_at: string
}

function fromStored(row: StoredAttempt): CodexDesktopNativeAttempt {
  return {
    installationKey: row.installation_key,
    invocationId: row.invocation_id,
    inputId: row.input_id,
    clientUserMessageId: row.client_user_message_id,
    threadId: row.thread_id,
    ...(row.principal_ref !== null ? { principalRef: row.principal_ref } : {}),
    ...(row.scope_ref !== null ? { scopeRef: row.scope_ref } : {}),
    ...(row.envelope_id !== null ? { envelopeId: row.envelope_id } : {}),
    observationWatermark: row.observation_watermark,
    state: row.state as CodexDesktopAttemptState,
    ...(row.queued_submission_id !== null ? { queuedSubmissionId: row.queued_submission_id } : {}),
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
