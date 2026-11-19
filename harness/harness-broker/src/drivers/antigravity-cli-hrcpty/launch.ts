import { buildProcessEnv } from '../../runtime/env'
import type { HrcptySpawnRequest } from '../../runtime/hrcpty'
import type { ChildProcessInvocationSpec, DriverContext } from '../driver'

export const ANTIGRAVITY_DRIVER_KIND = 'antigravity-cli-hrcpty'
export const ANTIGRAVITY_HOOK_GENERATION = 1

export function buildAntigravityLaunch(
  spec: ChildProcessInvocationSpec,
  ctx: DriverContext,
  socketPath: string,
  size: { cols: number; rows: number }
): HrcptySpawnRequest {
  const runtimeId = spec.correlation?.['runtimeId']
  const env = buildProcessEnv({
    lockedEnv: spec.process.lockedEnv,
    dispatchEnv: ctx.dispatchEnv,
    pathPrepend: spec.process.pathPrepend,
  })
  return {
    argv: [spec.process.command, ...spec.process.args],
    cwd: spec.process.cwd,
    env: {
      ...env,
      HARNESS_BROKER_INVOCATION_ID: ctx.invocationId,
      HARNESS_BROKER_HOOK_GENERATION: String(ANTIGRAVITY_HOOK_GENERATION),
      HARNESS_BROKER_CALLBACK_SOCKET: socketPath,
      ...(runtimeId === undefined ? {} : { HARNESS_BROKER_RUNTIME_ID: runtimeId }),
    } as Record<string, string>,
    ...size,
  }
}
