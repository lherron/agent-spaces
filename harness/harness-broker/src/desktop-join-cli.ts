import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeDesktopJoinClient } from './desktop-join-claude.js'
import { createCodexDesktopJoinClient } from './desktop-join-codex.js'
import {
  type DesktopJoinClient,
  type DesktopJoinInput,
  type JoinLifecycle,
  errorMessage,
  runDesktopJoin,
} from './desktop-join.js'

const DESKTOP_JOIN_USAGE = [
  'Usage: harness-broker desktop-join [--harness codex-desktop] --thread <id> [--rollout <path> --cwd <dir> --codex-home <dir>]',
  '       CLAUDE_PID=<pid> harness-broker desktop-join --harness claude-desktop --session <id>',
  'Both forms accept --hrc-socket <path> --source <hook> --deadline-ms <ms>.',
].join('\n')

export function parseDesktopJoinArgs(
  args: string[],
  fromStdin: ReturnType<typeof readHookStdinIds> = {}
): { client: DesktopJoinClient; input: DesktopJoinInput } {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    const value = args[index + 1]
    return index === -1 || value?.startsWith('--') ? undefined : value
  }
  const homeDir = process.env['HOME'] ?? tmpdir()
  const hrcSocketPath =
    flag('--hrc-socket') ??
    process.env['HRC_CALLBACK_SOCKET'] ??
    join(homeDir, 'praesidium', 'var', 'run', 'hrc', 'hrc.sock')
  const deadlineFlag = flag('--deadline-ms')
  const deadlineMs = deadlineFlag === undefined ? undefined : Number(deadlineFlag)
  if (
    args.includes('--deadline-ms') &&
    !(Number.isSafeInteger(deadlineMs) && Number(deadlineMs) > 0)
  ) {
    throw new Error('--deadline-ms must be a positive integer')
  }
  const input = {
    deadlineMs,
    hrcSocketPath,
    hookSource: fromStdin.source ?? flag('--source'),
  }
  const harness = flag('--harness') ?? (args.includes('--harness') ? '' : 'codex-desktop')
  if (harness === 'claude-desktop') {
    const sessionId = flag('--session')
    if (!sessionId) throw new Error(DESKTOP_JOIN_USAGE)
    const client = createClaudeDesktopJoinClient({
      claudeHome: join(homeDir, '.claude'),
      sessionId,
      pid: Number(process.env['CLAUDE_PID']),
    })
    return { client, input }
  }
  const threadId = flag('--thread')
  if (harness !== 'codex-desktop' || !threadId) throw new Error(DESKTOP_JOIN_USAGE)
  const client = createCodexDesktopJoinClient({
    threadId,
    codexHome: flag('--codex-home') ?? process.env['CODEX_HOME'] ?? join(homeDir, '.codex'),
    rolloutPath: flag('--rollout') ?? fromStdin.rolloutPath,
    workspaceCwd: flag('--cwd') ?? fromStdin.workspaceCwd,
    sqliteHome: flag('--sqlite-home'),
    reportedBundleExecutable: flag('--bundle-executable'),
  })
  return { client, input }
}

export function readHookStdinIds(raw: string): {
  threadId?: string
  rolloutPath?: string
  workspaceCwd?: string
  source?: string
} {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record['session_id'] === 'string'
        ? { threadId: record['session_id'] as string }
        : {}),
      ...(typeof record['transcript_path'] === 'string'
        ? { rolloutPath: record['transcript_path'] as string }
        : {}),
      ...(typeof record['cwd'] === 'string' ? { workspaceCwd: record['cwd'] as string } : {}),
      ...(typeof record['source'] === 'string' ? { source: record['source'] as string } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Every way a joiner process ends leaves a typed join.log line naming the
 * phase: `crashed` (uncaught throw / unhandled rejection), `signal`, and a
 * final `exit` with the code. Each path releases broker.pid and closes the
 * socket first. Only SIGKILL escapes; the next joiner logs the takeover of its
 * dead claim (T-09977).
 */
function installTerminationLogging(lifecycle: JoinLifecycle): void {
  const write = (event: string, detail: Record<string, unknown>): void => {
    try {
      if (lifecycle.log !== undefined) {
        lifecycle.log(event, { phase: lifecycle.phase, ...detail })
        return
      }
    } catch {}
    // No thread yet (bad argv), or join.log unwritable: stderr goes to the
    // hook's joiner.stderr.log.
    process.stderr.write(`desktop-join ${event} ${JSON.stringify(detail)}\n`)
  }
  let finishing = false
  const finish = (code: number): void => {
    if (finishing) return
    finishing = true
    try {
      lifecycle.release?.()
    } catch {}
    void Promise.resolve()
      .then(() => lifecycle.closeBroker?.())
      .catch(() => {})
      .then(() => process.exit(code))
  }
  const crashed = (kind: string, error: unknown): void => {
    write('crashed', {
      kind,
      message: errorMessage(error),
      ...(error instanceof Error && error.stack !== undefined
        ? { stack: error.stack.split('\n').slice(0, 6).join('\n') }
        : {}),
    })
    finish(1)
  }
  process.on('uncaughtException', (error) => crashed('uncaughtException', error))
  process.on('unhandledRejection', (reason) => crashed('unhandledRejection', reason))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      write('signal', { signal })
      finish(0)
    })
  }
  process.on('exit', (code) => write('exit', { code }))
}

export async function runDesktopJoinCli(args: string[]): Promise<void> {
  const lifecycle: JoinLifecycle = { phase: 'starting' }
  installTerminationLogging(lifecycle)
  let stdin = ''
  if (!process.stdin.isTTY) {
    stdin = await new Promise((resolve) => {
      let data = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        data += String(chunk)
      })
      process.stdin.on('end', () => resolve(data))
      process.stdin.on('error', () => resolve(''))
    })
  }
  const fromStdin = stdin.trim().length > 0 ? readHookStdinIds(stdin) : {}
  const { client, input } = parseDesktopJoinArgs(args, fromStdin)
  const outcome = await runDesktopJoin(client, input, { lifecycle })
  // Not serving: give the door back and close a socket that never joined.
  lifecycle.release?.()
  await lifecycle.closeBroker?.().catch(() => {})
  process.exit(outcome.exit)
}
