import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { HarnessProcessSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'
import type { DispatchEnv } from './env'
import { buildProcessEnv } from './env'

const liveChildren = new Set<ChildProcessWithoutNullStreams>()
let exitHookInstalled = false

export interface SpawnEnvChannels {
  /** Driver-provided credential env. Empty for the codex driver (auth on disk). */
  credentials?: Record<string, string> | undefined
  /** Per-invocation env from the InvocationDispatchRequest envelope. */
  dispatchEnv?: DispatchEnv | undefined
}

export async function spawnHarnessProcess(
  spec: HarnessProcessSpec,
  channels: SpawnEnvChannels = {}
): Promise<ChildProcessWithoutNullStreams> {
  if (spec.harnessTransport.kind !== 'jsonrpc-stdio') {
    throw new BrokerError(
      BrokerErrorCode.UnsupportedCapability,
      `Unsupported harness transport: ${spec.harnessTransport.kind}`
    )
  }

  const cwdStat = await stat(spec.cwd).catch((error: unknown) => {
    throw new BrokerError(BrokerErrorCode.ResourceError, `Invalid cwd: ${spec.cwd}`, {
      cwd: spec.cwd,
      cause: error instanceof Error ? error.message : String(error),
    })
  })
  if (!cwdStat.isDirectory()) {
    throw new BrokerError(BrokerErrorCode.ResourceError, `cwd is not a directory: ${spec.cwd}`, {
      cwd: spec.cwd,
    })
  }

  const command = spec.command ?? process.execPath

  const proc = spawn(command, spec.args, {
    cwd: spec.cwd,
    env: buildProcessEnv({
      lockedEnv: spec.lockedEnv,
      credentials: channels.credentials,
      dispatchEnv: channels.dispatchEnv,
      pathPrepend: spec.pathPrepend,
    }),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  trackChild(proc)
  return proc
}

function trackChild(proc: ChildProcessWithoutNullStreams): void {
  liveChildren.add(proc)
  proc.once('exit', () => {
    liveChildren.delete(proc)
  })

  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of liveChildren) {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
      }
    }
  })
}
