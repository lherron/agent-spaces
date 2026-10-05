import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { MuseServeDriverSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { ChildProcessInvocationSpec } from '../driver'
import { newMuseCommandId } from './command-id'
import type { MuseRpcPeer } from './rpc-client'
import { exportMuseSchema, gateMuseSchema } from './schema-compat'
import type { MuseSchemaGateOutcome } from './schema-compat'
import { readMuseWorkspaceMcpServers } from './workspace'

export interface MuseSessionStartupOptions {
  rpc: MuseRpcPeer
  proc: ChildProcessWithoutNullStreams
  spec: ChildProcessInvocationSpec
  driverSpec: MuseServeDriverSpec
  clientVersion: string
  /** How the serve child was launched, so the schema gate can export its schema. */
  serve: { command: string; env: NodeJS.ProcessEnv }
  /** False once the driver gave up on this start (dispose); the timer then stands down. */
  isStarting: () => boolean
  /** Hand the driver the rejecter its RPC error handler uses to fail startup. */
  onStartupRejecter: (reject: (error: Error) => void) => void
  onSchemaDrift: (warning: string) => void
}

/**
 * MSP startup handshake: initialize → structural schema gate → initialized →
 * session/resume (when a key is known) or session/start. Every step races the
 * RPC error channel and a startup timer that re-arms per step. Returns the
 * session id.
 */
export async function startMuseSession(options: MuseSessionStartupOptions): Promise<string> {
  const { rpc, proc, spec, driverSpec } = options
  const startupTimeoutMs = spec.process.limits?.startupTimeoutMs
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let startupTimedOut = false
  let rejectStartup: (error: Error) => void = () => undefined
  const startupFailure = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject
  })
  startupFailure.catch(() => undefined)
  options.onStartupRejecter(rejectStartup)
  const armStartupTimer = (): void => {
    if (startupTimer !== undefined) clearTimeout(startupTimer)
    if (startupTimeoutMs === undefined || startupTimeoutMs <= 0) return
    startupTimer = setTimeout(() => {
      if (!options.isStarting()) return
      startupTimedOut = true
      rpc.close(new Error('Startup timed out'))
      if (proc.exitCode === null) proc.kill('SIGTERM')
      rejectStartup(new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out'))
    }, startupTimeoutMs)
  }
  const withStartupRace = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, startupFailure]) as Promise<T>

  try {
    armStartupTimer()
    const initializeResult = await withStartupRace(
      rpc.sendRequest('initialize', {
        // MSP ClientInfo.name is [a-z0-9_]+ (SS1.4.1) — hyphens are rejected.
        clientInfo: { name: 'harness_broker', version: options.clientVersion },
      })
    )
    await withStartupRace(
      gateInstalledSchema(
        initializeResult,
        { command: options.serve.command, serveArgs: spec.process.args, env: options.serve.env },
        options.onSchemaDrift
      )
    )
    armStartupTimer()
    await withStartupRace(rpc.sendNotification('initialized', {}))

    const mcpServers = await readMuseWorkspaceMcpServers(driverSpec.workspace)
    const resumeKey =
      driverSpec.resumeSessionId ??
      (spec.continuation?.kind === 'session' ? spec.continuation.key : undefined)
    let startedSessionId: string | undefined
    if (resumeKey) {
      try {
        armStartupTimer()
        const resumed = (await withStartupRace(
          rpc.sendRequest('session/resume', {
            commandId: newMuseCommandId(),
            sessionId: resumeKey,
          })
        )) as { session?: { sessionId?: string } }
        startedSessionId = resumed.session?.sessionId
      } catch (error) {
        if ((driverSpec.resumeFallback ?? 'fail') === 'fail') throw error
        startedSessionId = undefined
      }
    }
    if (!startedSessionId) {
      armStartupTimer()
      const started = (await withStartupRace(
        rpc.sendRequest('session/start', {
          commandId: newMuseCommandId(),
          workspaceRoot: spec.process.cwd,
          ...(driverSpec.approvalMode ? { approvalMode: driverSpec.approvalMode } : {}),
          ...(driverSpec.model ? { modelId: driverSpec.model } : {}),
          ...(mcpServers ? { config: { mcpServers } } : {}),
        })
      )) as { session?: { sessionId?: string } }
      startedSessionId = started.session?.sessionId
      if (!startedSessionId) {
        throw new BrokerError(
          BrokerErrorCode.HarnessError,
          'muse session/start returned no session id'
        )
      }
    }
    return startedSessionId
  } catch (startupError) {
    if (startupTimedOut) throw new BrokerError(BrokerErrorCode.Timeout, 'Startup timed out')
    throw startupError
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer)
  }
}

/**
 * Structural schema gate (T-09879): refuse startup only when the installed
 * muse's schema breaks the driver-used surface (schema-surface.ts); any
 * other drift from the last-verified export warns once per start.
 */
async function gateInstalledSchema(
  initializeResult: unknown,
  exportCommand: { command: string; serveArgs: readonly string[]; env: NodeJS.ProcessEnv },
  onSchemaDrift: (warning: string) => void
): Promise<void> {
  const record = (initializeResult ?? {}) as Record<string, unknown>
  const schema = record['schema'] as Record<string, unknown> | undefined
  const fingerprint =
    typeof schema?.['fingerprint'] === 'string' ? schema['fingerprint'] : undefined
  let outcome: MuseSchemaGateOutcome
  try {
    outcome = await gateMuseSchema(fingerprint, () => exportMuseSchema(exportCommand))
  } catch (error) {
    throw new BrokerError(
      BrokerErrorCode.HarnessError,
      error instanceof Error ? error.message : String(error)
    )
  }
  if (outcome.kind === 'compatible-drift') onSchemaDrift(outcome.warning)
}
