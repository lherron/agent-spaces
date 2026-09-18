import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientCapabilities, HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../../../src/drivers/driver'
import { createMuseCliTmuxDriver } from '../../../src/drivers/muse-cli-tmux/driver'

type ExecResult = { stdout: string; stderr: string }
type ExecFn = (
  argv: string[],
  options?: { env?: Record<string, string | undefined> | undefined }
) => Promise<ExecResult>

const LEASE = {
  kind: 'tmux-pane' as const,
  ownership: 'hrc' as const,
  socketPath: '/tmp/preallocated/hrc-owned-tmux.sock',
  sessionId: '$1',
  windowId: '@1',
  paneId: '%7',
  allowedOps: {
    inspect: true as const,
    sendInput: true as const,
    sendInterrupt: true as const,
    capture: false as const,
    resize: false as const,
  },
}

function createCtx(invocationId = 'inv-test-muse-launch'): DriverContext {
  return {
    invocationId,
    clientCapabilities: {} as ClientCapabilities,
    runtime: { terminalSurface: { ...LEASE } },
    emit: () => {},
  }
}

function createSpec(homeMode?: 'isolated' | 'operator'): HarnessInvocationSpec {
  return {
    process: {
      command: '/usr/local/bin/muse',
      args: ['--provider', 'echo'],
      cwd: '/tmp',
      lockedEnv: {},
      pathPrepend: [],
    },
    driver: {
      kind: 'muse-cli-tmux',
      terminalHost: 'tmux',
      ...(homeMode !== undefined ? { homeMode } : {}),
    },
  } as unknown as HarnessInvocationSpec
}

function launchArtifactEnv(invocationId: string): Record<string, string | undefined> {
  const raw = readFileSync(join(tmpdir(), `muse-cli-tmux-${invocationId}.launch.json`), 'utf8')
  return (JSON.parse(raw) as { env: Record<string, string | undefined> }).env
}

/** Recording exec: answers inspect/paste verbs, captures the pasted launch line. */
function createRecordingExec(pasted: string[]): ExecFn {
  return async (argv) => {
    if (argv.includes('display-message')) {
      return { stdout: '$1\t@1\t%7', stderr: '' }
    }
    if (argv.includes('load-buffer')) {
      pasted.push(readFileSync(argv[argv.length - 1] as string, 'utf8'))
      return { stdout: '', stderr: '' }
    }
    if (argv.includes('paste-buffer') || argv.includes('send-keys')) {
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected tmux argv: ${argv.join(' ')}`)
  }
}

describe('muse-cli-tmux launch runner selection', () => {
  test('helperLauncher routes the launch through the release payload tmux-launch', async () => {
    const pasted: string[] = []
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      helperLauncher: { command: '/releases/asp-x/libexec/harness-broker' },
    })
    const result = await driver.start(createSpec(), createCtx())
    expect(result).toEqual({ ok: true })
    expect(pasted).toHaveLength(1)
    const line = pasted[0] as string
    expect(line.startsWith('exec /releases/asp-x/libexec/harness-broker tmux-launch ')).toBe(true)
    expect(line).toContain('--launch-file')
    expect(line).not.toContain('$bunfs')
    await driver.dispose()
  })

  test('without helperLauncher the launch falls back to the sibling bun runner', async () => {
    const pasted: string[] = []
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
    })
    const result = await driver.start(createSpec(), createCtx('inv-test-muse-fallback'))
    expect(result).toEqual({ ok: true })
    expect(pasted).toHaveLength(1)
    const line = pasted[0] as string
    expect(line.startsWith('exec bun ')).toBe(true)
    expect(line).toContain('tmux-launch-runner')
    await driver.dispose()
  })
})

describe('muse-cli-tmux home posture', () => {
  test('operator homeMode keeps HOME on the operator home with disposable XDG dirs', async () => {
    const pasted: string[] = []
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
    })
    const invocationId = 'inv-test-muse-operator-home'
    const result = await driver.start(createSpec('operator'), createCtx(invocationId))
    expect(result).toEqual({ ok: true })
    const env = launchArtifactEnv(invocationId)
    expect(env['HOME']).toBe(homedir())
    expect(env['XDG_CONFIG_HOME']).toContain(`muse-serve-xdg-${invocationId}`)
    await driver.dispose()
  })

  test('absent homeMode keeps the isolated per-invocation HOME', async () => {
    const pasted: string[] = []
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
    })
    const invocationId = 'inv-test-muse-isolated-home'
    const result = await driver.start(createSpec(), createCtx(invocationId))
    expect(result).toEqual({ ok: true })
    const env = launchArtifactEnv(invocationId)
    expect(env['HOME']).toContain(`muse-serve-home-${invocationId}`)
    await driver.dispose()
  })
})
