import type { HrcptySpawnRequest } from '../../runtime/hrcpty'
import { buildTmuxLaunchArtifactEnv } from '../../runtime/tmux-launch-exec'
import { type ClaudeLaunchHookEnv, buildClaudeLaunchInput } from '../claude-code-tmux/launch'
import type { ChildProcessInvocationSpec, DriverContext } from '../driver'

/**
 * hrc-pty `spawn` params for Claude: the same argv (settings overlay pointing
 * every hook at the hook bridge) and env (`HARNESS_BROKER_*`) the tmux route
 * writes to its launch artifact, with the same complete-environment rule its
 * pane runner applies. There is no `$SHELL` wrapper here: hrc-pty runs
 * `$SHELL -lc 'exec …'` itself (§4.2), and it owns the TERM identity, so no
 * pane variables are added.
 *
 * The tmux runner's framed launch header has no counterpart: nothing runs in
 * the pty before Claude to print it.
 */
export async function buildClaudeHrcptySpawnRequest(
  spec: ChildProcessInvocationSpec,
  ctx: DriverContext,
  hookEnv: ClaudeLaunchHookEnv,
  size: { cols: number; rows: number }
): Promise<HrcptySpawnRequest> {
  const launch = await buildClaudeLaunchInput(spec, ctx, hookEnv)
  return {
    argv: launch.argv,
    env: buildTmuxLaunchArtifactEnv(launch.env, launch.pathPrepend),
    cwd: launch.cwd,
    cols: size.cols,
    rows: size.rows,
  }
}
