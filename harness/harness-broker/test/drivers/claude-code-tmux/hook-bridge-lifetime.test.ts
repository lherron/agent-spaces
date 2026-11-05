import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T-12660: a detached `claude-hook --event StatusLine` client spun at 100% CPU
 * for 3 h after its broker went away. The hook client is cosmetic and must
 * never outlive its work: a missing socket or stdin EOF ends it promptly and
 * quietly, and the statusline's detached bridge runs under a kernel CPU cap so
 * no userland spin, whatever its trigger, can burn a core for long.
 *
 * Every wait here is a generous kill-guard, not a timing assertion.
 */

const PACKAGE_ROOT = join(import.meta.dir, '../../..')
const REPO_ROOT = join(PACKAGE_ROOT, '../..')
const BRIDGE_BIN = join(PACKAGE_ROOT, 'bin/harness-broker.js')
const STATUSLINE_SH = join(REPO_ROOT, 'drivers/harness-claude/assets/statusline.sh')
const KILL_GUARD_MS = 30_000
const STATUSLINE_INPUT = JSON.stringify({
  model: { display_name: 'Opus' },
  context_window: { context_window_size: 200_000 },
})

const roots: string[] = []
const spinners: number[] = []

afterEach(() => {
  for (const pid of spinners.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'hook-bridge-lifetime-'))
  roots.push(root)
  return root
}

function runBridge(
  socketPath: string,
  input: string
): { status: number | null; signal: NodeJS.Signals | null; stdout: string } {
  const result = spawnSync(
    'bun',
    [BRIDGE_BIN, 'claude-hook', '--socket', socketPath, '--event', 'StatusLine'],
    {
      input,
      env: {
        PATH: process.env['PATH'],
        HARNESS_BROKER_INVOCATION_ID: 'inv-lifetime',
        HARNESS_BROKER_HOOK_GENERATION: '1',
        HARNESS_BROKER_CALLBACK_SOCKET: socketPath,
      } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: KILL_GUARD_MS,
      killSignal: 'SIGKILL',
    }
  )
  return { status: result.status, signal: result.signal, stdout: result.stdout }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + KILL_GUARD_MS
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(100)
  }
  return false
}

describe('claude-hook client lifetime (T-12660)', () => {
  test('exits quietly on stdin EOF when the socket is missing', () => {
    const missing = join(scratch(), 'gone', 'claude-hooks.sock')
    for (const input of [STATUSLINE_INPUT, '']) {
      const result = runBridge(missing, input)
      expect(result.signal).toBeNull()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
    }
  })

  test('exits when the stdin writer is a parent that has already exited', () => {
    const missing = join(scratch(), 'claude-hooks.sock')
    const result = spawnSync(
      'bash',
      [
        '-c',
        'printf "%s" "$1" | bun "$2" claude-hook --socket "$3" --event StatusLine',
        'bash',
        STATUSLINE_INPUT,
        BRIDGE_BIN,
        missing,
      ],
      {
        env: { PATH: process.env['PATH'] } as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: KILL_GUARD_MS,
        killSignal: 'SIGKILL',
      }
    )
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
  })

  test(
    'statusline.sh caps the detached bridge so a spinning client dies',
    async () => {
      const root = scratch()
      const pidFile = join(root, 'bridge.pid')
      // The specimen's shape: a process.nextTick <-> microtask loop that never
      // returns to the event loop, so no in-process timer can end it.
      const spin =
        'require("fs").writeFileSync(process.env.PID_FILE, String(process.pid));' +
        'function f(){process.nextTick(()=>Promise.resolve().then(f))};f()'
      const rendered = spawnSync('bash', [STATUSLINE_SH], {
        input: STATUSLINE_INPUT,
        env: {
          PATH: process.env['PATH'],
          PID_FILE: pidFile,
          HARNESS_BROKER_STATUSLINE_BRIDGE: `bun -e '${spin}'`,
        } as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: KILL_GUARD_MS,
      })
      expect(rendered.status).toBe(0)

      const pidDeadline = Date.now() + KILL_GUARD_MS
      while (!existsSync(pidFile) && Date.now() < pidDeadline) await Bun.sleep(50)
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
      spinners.push(pid)
      expect(await waitGone(pid)).toBe(true)
    },
    2 * KILL_GUARD_MS + 5_000
  )
})
