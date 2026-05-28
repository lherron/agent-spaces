/**
 * Pre-HRC tmux pane allocator (T-01727 Phase E).
 *
 * The pre-HRC harness plays the HRC stand-in role for tmux lifecycle: after
 * `tmux start-server` and BEFORE broker dispatch, it allocates a real
 * session/window/pane on the harness-owned tmux server and hands the pane to
 * the broker driver via `runtime.terminalSurface` (kind `'tmux-pane'`,
 * ownership `'hrc'`). Drivers (Phase C/D) read ONLY the lease — they never
 * own the tmux server or allocate panes themselves.
 *
 * Boundary note: this file lives under `packages/agent-spaces/src/testing/**`
 * which the contract-harness boundary checker scans. It uses only Node stdlib
 * (`child_process.spawn`) and the protocol type for `InvocationRuntimeContext`
 * — NO harness-broker driver imports.
 */
import { spawn } from 'node:child_process'

import type { InvocationRuntimeContext } from 'spaces-harness-broker-protocol'

// ---------------------------------------------------------------------------
// Lease shape (derived from protocol so it stays exact)
// ---------------------------------------------------------------------------

type TerminalSurfaceLease = NonNullable<InvocationRuntimeContext['terminalSurface']>

export type PreHrcAllocatedPane = {
  /** Lease ready to drop into `runtime.terminalSurface`. */
  lease: TerminalSurfaceLease
  /** Raw tmux identifiers for downstream attach-helpers. */
  sessionId: string
  windowId: string
  paneId: string
  sessionName: string
  windowName: string
}

const PANE_IDENTITY_FORMAT = '#{session_id}\t#{window_id}\t#{pane_id}\t#{window_name}'

// ---------------------------------------------------------------------------
// Allocator
// ---------------------------------------------------------------------------

export type AllocatePreHrcTmuxPaneOptions = {
  tmuxBin: string
  socketPath: string
  /** Deterministic tmux session name (e.g. `phase5-${invocationId}`). */
  sessionName: string
  /** Environment for the allocator's `tmux new-session` invocation. */
  env?: Record<string, string | undefined> | undefined
  /**
   * allowedOps overrides. Defaults to the read+input+interrupt+capture lease
   * the harness-broker drivers expect: `{ inspect: true, sendInput: true,
   * sendInterrupt: true, capture: true, resize: false }`. The required-true
   * fields cannot be overridden.
   */
  allowedOps?:
    | {
        capture?: boolean | undefined
        resize?: boolean | undefined
      }
    | undefined
}

/**
 * Allocate a real tmux session/window/pane on the supplied socket and return
 * the lease shape the broker drivers consume.
 *
 * Runs:
 *   tmux -S <socketPath> new-session -d -s <sessionName> -P -F '<format>'
 *
 * The harness must have already run `tmux start-server` on the same socket
 * before calling this; it is also responsible for the eventual `kill-session`
 * / `kill-server` teardown.
 */
export async function allocatePreHrcTmuxPane(
  options: AllocatePreHrcTmuxPaneOptions
): Promise<PreHrcAllocatedPane> {
  const env = scrubEnv(options.env ?? process.env)
  const argv = [
    '-S',
    options.socketPath,
    'new-session',
    '-d',
    '-s',
    options.sessionName,
    '-P',
    '-F',
    PANE_IDENTITY_FORMAT,
  ]
  const { stdout } = await runTmux(options.tmuxBin, argv, env)
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (line === undefined) {
    throw new Error(
      `pre-HRC tmux allocator: 'new-session -P -F ${PANE_IDENTITY_FORMAT}' produced no output on socket ${options.socketPath}`
    )
  }
  const parts = line.split('\t')
  if (parts.length < 4) {
    throw new Error(
      `pre-HRC tmux allocator: 'new-session -P' returned malformed identity line ${JSON.stringify(line)}`
    )
  }
  const sessionId = parts[0] ?? ''
  const windowId = parts[1] ?? ''
  const paneId = parts[2] ?? ''
  const windowName = parts[3] ?? ''
  if (sessionId === '' || windowId === '' || paneId === '') {
    throw new Error(
      `pre-HRC tmux allocator: 'new-session -P' returned empty ids in line ${JSON.stringify(line)}`
    )
  }
  const capture = options.allowedOps?.capture ?? true
  const resize = options.allowedOps?.resize ?? false
  const lease: TerminalSurfaceLease = {
    kind: 'tmux-pane',
    ownership: 'hrc',
    socketPath: options.socketPath,
    sessionId,
    windowId,
    paneId,
    sessionName: options.sessionName,
    windowName,
    allowedOps: {
      inspect: true,
      sendInput: true,
      sendInterrupt: true,
      capture,
      resize,
    },
  }
  return {
    lease,
    sessionId,
    windowId,
    paneId,
    sessionName: options.sessionName,
    windowName,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v
  return clean
}

function runTmux(
  tmuxBin: string,
  argv: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(tmuxBin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `pre-HRC tmux allocator: '${tmuxBin} ${argv.join(' ')}' exited with ${code}: ${
              stderr.trim() || stdout.trim()
            }`
          )
        )
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}
