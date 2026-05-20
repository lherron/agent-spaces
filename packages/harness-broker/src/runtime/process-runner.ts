import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { HarnessProcessSpec } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'
import { buildProcessEnv } from './env'

export async function spawnHarnessProcess(
  spec: HarnessProcessSpec
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

  return spawn(command, spec.args, {
    cwd: spec.cwd,
    env: buildProcessEnv(spec.env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
