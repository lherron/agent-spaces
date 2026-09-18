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

type EmittedEvent = { type: string; payload: unknown }

function createCtx(
  invocationId = 'inv-test-muse-launch',
  emitted: EmittedEvent[] = []
): DriverContext {
  return {
    invocationId,
    clientCapabilities: {} as ClientCapabilities,
    runtime: { terminalSurface: { ...LEASE } },
    emit: (type, payload) => {
      emitted.push({ type: String(type), payload })
    },
  }
}

type HookHandler = (envelope: Record<string, unknown>) => Promise<unknown> | unknown

function createStubHooks(socketPath = '/tmp/muse-hooks-test.sock'): {
  listen: (
    handler: HookHandler,
    context: { invocationId: string; runtimeId?: string | undefined }
  ) => Promise<{ socketPath: string; close: () => Promise<void> }>
  handler: () => HookHandler | undefined
} {
  let captured: HookHandler | undefined
  return {
    listen: async (handler) => {
      captured = handler
      return { socketPath, close: async () => {} }
    },
    handler: () => captured,
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
    const hooks = createStubHooks()
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      helperLauncher: { command: '/releases/asp-x/libexec/harness-broker' },
      hooks: { listen: hooks.listen },
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
    const hooks = createStubHooks()
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      hooks: { listen: hooks.listen },
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
    const hooks = createStubHooks()
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      hooks: { listen: hooks.listen },
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
    const hooks = createStubHooks()
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      hooks: { listen: hooks.listen },
    })
    const invocationId = 'inv-test-muse-isolated-home'
    const result = await driver.start(createSpec(), createCtx(invocationId))
    expect(result).toEqual({ ok: true })
    const env = launchArtifactEnv(invocationId)
    expect(env['HOME']).toContain(`muse-serve-home-${invocationId}`)
    await driver.dispose()
  })
})

describe('muse-cli-tmux /quit teardown', () => {
  test('start opts the launch runner into synthesized SessionEnd on the hook socket', async () => {
    const pasted: string[] = []
    const hooks = createStubHooks('/tmp/muse-teardown-test.sock')
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      hooks: { listen: hooks.listen },
    })
    const invocationId = 'inv-test-muse-teardown-env'
    const result = await driver.start(createSpec(), createCtx(invocationId))
    expect(result).toEqual({ ok: true })
    const env = launchArtifactEnv(invocationId)
    expect(env['HARNESS_BROKER_CALLBACK_SOCKET']).toBe('/tmp/muse-teardown-test.sock')
    expect(env['HARNESS_BROKER_HOOK_GENERATION']).toBe('1')
    expect(env['HARNESS_BROKER_SYNTH_SESSION_END']).toBe('1')
    await driver.dispose()
  })

  test('synthetic SessionEnd with a user-initiated reason clears the continuation', async () => {
    const pasted: string[] = []
    const emitted: EmittedEvent[] = []
    const hooks = createStubHooks()
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      hooks: { listen: hooks.listen },
    })
    const invocationId = 'inv-test-muse-teardown-event'
    const result = await driver.start(createSpec(), createCtx(invocationId, emitted))
    expect(result).toEqual({ ok: true })
    const handler = hooks.handler()
    expect(handler).toBeDefined()
    await handler?.({
      invocationId,
      callbackSocket: '/tmp/muse-hooks-test.sock',
      hookData: { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
    })
    const cleared = emitted.filter((event) => event.type === 'continuation.cleared')
    expect(cleared).toHaveLength(1)
    await driver.dispose()
  })

  test('foreign and non-end hook envelopes are ignored', async () => {
    const pasted: string[] = []
    const emitted: EmittedEvent[] = []
    const hooks = createStubHooks()
    const driver = createMuseCliTmuxDriver({
      tmux: { socketPath: LEASE.socketPath, exec: createRecordingExec(pasted) },
      hooks: { listen: hooks.listen },
    })
    const invocationId = 'inv-test-muse-teardown-fence'
    const result = await driver.start(createSpec(), createCtx(invocationId, emitted))
    expect(result).toEqual({ ok: true })
    const handler = hooks.handler()
    expect(handler).toBeDefined()
    await handler?.({
      invocationId: 'inv-someone-else',
      hookData: { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
    })
    await handler?.({
      invocationId,
      hookData: { hook_event_name: 'SessionEnd', reason: 'other' },
    })
    await handler?.({ invocationId, hookData: { hook_event_name: 'Stop' } })
    expect(emitted.filter((event) => event.type === 'continuation.cleared')).toHaveLength(0)
    await driver.dispose()
  })
})
