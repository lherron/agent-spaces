import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationRuntimeContext,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { WebSocketServer } from 'ws'
import { createBroker } from '../../../src/broker'
import {
  type AttachAttemptResult,
  resolveCodexTuiWrapperEntryPath,
  runCodexTuiAttachRetry,
} from '../../../src/drivers/codex-app-server/codex-tui-wrapper'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'
import {
  type CodexRpcPeer,
  CodexUnixWebSocketRpcClient,
  type JsonRpcNotification,
  type RpcHandlers,
} from '../../../src/drivers/codex-app-server/rpc-client'
import type { TmuxExec } from '../../../src/runtime/tmux'

const origin: SubmissionOrigin = {
  principalRef: 'agent:codex-tui-test',
  scopeRef: 'codex-tui-test@agent-spaces',
}

const lease = (): NonNullable<InvocationRuntimeContext['terminalSurface']> => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/codex-tui-test-tmux.sock',
  sessionId: '$1',
  windowId: '@1',
  paneId: '%1',
  sessionName: 'codex-tui-test',
  windowName: 'main',
  allowedOps: {
    inspect: true,
    sendInput: true,
    sendInterrupt: true,
    capture: true,
  },
})

const spec = (
  invocationId: string,
  overrides: Partial<Extract<HarnessInvocationSpec['driver'], { kind: 'codex-app-server' }>> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: {
    frontend: 'codex-cli',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: '/opt/homebrew/bin/codex',
    args: ['app-server'],
    cwd: process.cwd(),
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 2_000, turnTimeoutMs: 2_000 },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'codex-app-server',
    presentation: 'codex-tui',
    transport: 'websocket-unix',
    approvalPolicy: 'never',
    ...overrides,
  },
})

function fakeTmux(): { exec: TmuxExec; launched: string[] } {
  const buffers = new Map<string, string>()
  const launched: string[] = []
  let pane = ''
  const exec: TmuxExec = async (argv) => {
    const commandIndex = argv.findIndex((part) =>
      [
        'display-message',
        'load-buffer',
        'paste-buffer',
        'delete-buffer',
        'capture-pane',
        'send-keys',
      ].includes(part)
    )
    const command = argv[commandIndex]
    const args = argv.slice(commandIndex + 1)
    if (command === 'display-message') return { stdout: '$1\t@1\t%1\n', stderr: '' }
    if (command === 'load-buffer') {
      const name = args[args.indexOf('-b') + 1] ?? ''
      const path = args.at(-1) ?? ''
      buffers.set(name, await readFile(path, 'utf8'))
      return { stdout: '', stderr: '' }
    }
    if (command === 'paste-buffer') {
      const name = args[args.indexOf('-b') + 1] ?? ''
      pane = buffers.get(name) ?? ''
      launched.push(pane)
      return { stdout: '', stderr: '' }
    }
    if (command === 'delete-buffer') return { stdout: '', stderr: '' }
    if (command === 'capture-pane') return { stdout: pane, stderr: '' }
    if (command === 'send-keys') {
      pane = ''
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected fake tmux command: ${argv.join(' ')}`)
  }
  return { exec, launched }
}

type RpcRequest = { method: string; params: unknown }

class FakeCodexRpc implements CodexRpcPeer {
  readonly requests: RpcRequest[] = []
  readonly notifications: RpcRequest[] = []
  handlers: RpcHandlers = {}
  onRequest?: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (this.onRequest !== undefined) return (await this.onRequest(method, params)) as T
    if (method === 'initialize') return {} as T
    if (method === 'hooks/list') return { data: [] } as T
    if (method === 'thread/start') return { thread: { id: 'thread_test' } } as T
    if (method === 'thread/queue/list') return { data: [] } as T
    throw new Error(`unhandled fake RPC request: ${method}`)
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params })
  }

  close(): void {}

  emit(method: string, params: unknown): void {
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.handlers.onNotification?.(message, JSON.stringify(message))
  }

  fail(error: Error): void {
    this.handlers.onError?.(error)
  }
}

function emitTurn(
  rpc: FakeCodexRpc,
  turnId: string,
  options: {
    clientId?: string | null
    firstItem?: 'userMessage' | 'agentMessage'
    terminal?: 'completed' | 'interrupted'
  } = {}
): void {
  rpc.emit('turn/started', {
    threadId: 'thread_test',
    turn: { id: turnId, status: 'inProgress', items: [] },
  })
  const firstItem = options.firstItem ?? 'userMessage'
  rpc.emit('item/started', {
    threadId: 'thread_test',
    turnId,
    item:
      firstItem === 'userMessage'
        ? {
            id: `user_${turnId}`,
            type: 'userMessage',
            clientId: options.clientId ?? null,
            content: [{ type: 'text', text: `prompt ${turnId}` }],
          }
        : { id: `agent_${turnId}`, type: 'agentMessage', text: '' },
  })
  rpc.emit('turn/completed', {
    threadId: 'thread_test',
    turn: {
      id: turnId,
      status: options.terminal ?? 'completed',
      items: [],
    },
  })
}

function emitUserMessageItem(
  rpc: FakeCodexRpc,
  options: {
    turnId: string
    itemId: string
    clientId?: string | null
    text: string
    threadId?: string
  }
): void {
  rpc.emit('item/started', {
    threadId: options.threadId ?? 'thread_test',
    turnId: options.turnId,
    item: {
      id: options.itemId,
      type: 'userMessage',
      clientId: options.clientId ?? null,
      content: [{ type: 'text', text: options.text }],
    },
  })
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  expect(await predicate(), message).toBe(true)
}

async function setupDriver(
  rpc: FakeCodexRpc,
  invocationId: string,
  driverOverrides: Partial<
    Extract<HarnessInvocationSpec['driver'], { kind: 'codex-app-server' }>
  > = {},
  durableCapture = false
) {
  const events: InvocationEventEnvelope[] = []
  const tmux = fakeTmux()
  const socketDir = await mkdtemp(join(tmpdir(), 'codex-tui-driver-test-'))
  const driver = createCodexAppServerDriver({
    codexTui: {
      tmuxExec: tmux.exec,
      socketDir,
      connect: async (_socketPath, handlers) => {
        rpc.handlers = handlers
        return rpc
      },
    },
  })
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event) => events.push(event),
    ...(durableCapture ? { captureDir: socketDir } : {}),
  })
  const invocationSpec = spec(invocationId, driverOverrides)
  return { broker, driver, events, invocationSpec, socketDir, tmux }
}

describe('codex-tui transport', () => {
  let directory: string | undefined
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  test('uses websocket framing over a unix socket without compression', async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-tui-ws-'))
    const socketPath = join(directory, 'appsrv.sock')
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    })
    server = createServer()
    server.on('upgrade', (request, socket, head) => {
      expect(request.headers['sec-websocket-extensions']).toBeUndefined()
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
    })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const request = JSON.parse(raw.toString()) as {
          id?: number
          method: string
        }
        if (request.id !== undefined) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { ok: true },
            })
          )
        }
      })
    })
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))

    const client = new CodexUnixWebSocketRpcClient(socketPath)
    await client.ready()
    await expect(client.sendRequest('initialize', {})).resolves.toEqual({
      ok: true,
    })
    client.close()
    wss.close()
  })

  test('retries -32600 then -32603 before the successful remote attach', async () => {
    const attempts: AttachAttemptResult[] = [
      { code: 1, signal: null, stderr: 'error -32600: no rollout found' },
      {
        code: 1,
        signal: null,
        stderr: 'error -32603: failed to read session metadata',
      },
      { code: 0, signal: null, stderr: '' },
    ]
    const delays: number[] = []
    let now = 0
    const result = await runCodexTuiAttachRetry({
      launch: async () => attempts.shift() ?? { code: 2, signal: null, stderr: 'unexpected' },
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms)
        now += ms
      },
    })
    expect(result.code).toBe(0)
    expect(delays).toEqual([250, 500])
  })

  test('SIGHUP to the pane wrapper terminates its app-server child', async () => {
    const wrapperDir = await mkdtemp(join(tmpdir(), 'codex-tui-wrapper-lifetime-'))
    const fakeCodex = join(wrapperDir, 'fake-codex')
    const socketPath = join(wrapperDir, 'app-server.sock')
    const attachTokenPath = join(wrapperDir, 'attach-token')
    await writeFile(
      fakeCodex,
      "#!/bin/sh\ntrap 'exit 0' TERM HUP INT\nwhile :; do sleep 1; done\n",
      'utf8'
    )
    await chmod(fakeCodex, 0o700)
    await writeFile(attachTokenPath, 'thread_test\n', 'utf8')
    const wrapper = spawn(process.execPath, [
      resolveCodexTuiWrapperEntryPath(),
      '--command',
      fakeCodex,
      '--socket',
      socketPath,
      '--attach-token',
      attachTokenPath,
      '--control-socket',
      join(wrapperDir, 'control.sock'),
      '--invocation-id',
      'inv_wrapper_lifetime',
    ])
    let appServerPid: number | undefined
    try {
      await waitFor(async () => {
        try {
          const parsed = Number((await readFile(`${socketPath}.pid`, 'utf8')).trim())
          if (Number.isInteger(parsed) && parsed > 0) appServerPid = parsed
          return appServerPid !== undefined
        } catch {
          return false
        }
      }, 'wrapper should record its app-server pid')
      wrapper.kill('SIGHUP')
      const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
          wrapper.once('exit', (code, signal) => resolve({ code, signal }))
        ),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('wrapper did not exit after SIGHUP')), 3_000)
        ),
      ])
      expect(exit).toEqual({ code: 129, signal: null })
      await waitFor(() => {
        try {
          process.kill(appServerPid as number, 0)
          return false
        } catch {
          return true
        }
      }, 'app-server child should not survive wrapper SIGHUP')
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL')
      if (appServerPid !== undefined) {
        try {
          process.kill(appServerPid, 'SIGKILL')
        } catch {
          // Already reaped by the wrapper, which is the expected path.
        }
      }
      await rm(wrapperDir, { recursive: true, force: true })
    }
  })

  test('captures hook envelopes as raw provenance without minting events', async () => {
    const rpc = new FakeCodexRpc()
    const invocationId = 'inv_codex_tui_raw_hook'
    const run = await setupDriver(rpc, invocationId, {}, true)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      let hookSocket: string | undefined
      await waitFor(async () => {
        const entry = (await readdir(run.socketDir)).find(
          (name) => name.includes('codex-tui-hooks') && name.endsWith('.sock')
        )
        if (entry !== undefined) hookSocket = join(run.socketDir, entry)
        return hookSocket !== undefined
      }, 'codex-tui hook listener should bind its socket')
      const eventCount = run.events.length
      await new Promise<void>((resolve, reject) => {
        const socket = connect(hookSocket as string, () => {
          socket.end(
            JSON.stringify({
              invocationId,
              generation: 1,
              callbackSocket: hookSocket,
              hookData: {
                hook_event_name: 'PostToolUse',
                session_id: 'thread_test',
                tool_name: 'shell',
              },
            })
          )
        })
        socket.once('error', reject)
        socket.once('close', () => resolve())
      })
      const rawPath = join(run.socketDir, 'raw', `${invocationId}.ndjson`)
      await waitFor(async () => {
        try {
          const rows = (await readFile(rawPath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { sourceKind?: string; nativeType?: string })
          return rows.some((row) => row.sourceKind === 'hook' && row.nativeType === 'PostToolUse')
        } catch {
          return false
        }
      }, 'hook envelope should be committed to the raw journal')
      expect(run.events).toHaveLength(eventCount)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('handshakes experimentally and attributes two queued inputs without turn/start', async () => {
    const rpc = new FakeCodexRpc()
    let turnNumber = 0
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
        const turnId = `turn_own_${++turnNumber}`
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: turnId, status: 'inProgress', items: [] },
          })
          rpc.emit('item/started', {
            threadId: 'thread_test',
            turnId,
            item: {
              id: `user_${turnId}`,
              type: 'userMessage',
              clientId: inputId,
              content: [{ type: 'text', text: `prompt ${inputId}` }],
            },
          })
          setTimeout(() => {
            rpc.emit('item/started', {
              threadId: 'thread_test',
              turnId,
              item: { id: `agent_${turnId}`, type: 'agentMessage', text: '' },
            })
            rpc.emit('item/completed', {
              threadId: 'thread_test',
              turnId,
              item: {
                id: `agent_${turnId}`,
                type: 'agentMessage',
                text: `done ${inputId}`,
              },
            })
            rpc.emit('turn/completed', {
              threadId: 'thread_test',
              turn: {
                id: turnId,
                status: 'completed',
                items: [
                  {
                    id: `agent_${turnId}`,
                    type: 'agentMessage',
                    text: `done ${inputId}`,
                  },
                ],
              },
            })
          }, 5)
        })
        return { queuedSubmission: { id: `queued_${inputId}` } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_two_queue')
    try {
      const started = await run.broker.start(
        {
          spec: run.invocationSpec,
          initialInput: {
            inputId: 'input_launch',
            kind: 'user',
            content: [{ type: 'text', text: 'launch' }],
          },
        },
        {},
        { terminalSurface: lease() }
      )
      expect(started.capabilities.admission.classes).toEqual(['steer', 'queue'])
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.completed' && event.inputId === 'input_launch'
          ),
        'launch queue input should complete'
      )
      const second = await run.broker.enqueue({
        invocationId: 'inv_codex_tui_two_queue',
        origin,
        body: 'second',
      })
      expect(second.admission).toBe('admitted')
      await waitFor(
        () => run.events.filter((event) => event.type === 'turn.completed').length === 2,
        'second queue input should complete'
      )

      const initialize = rpc.requests.find((request) => request.method === 'initialize')
      expect(initialize?.params).toEqual(
        expect.objectContaining({ capabilities: { experimentalApi: true } })
      )
      expect(rpc.notifications).toEqual([{ method: 'initialized', params: {} }])
      expect(rpc.requests.filter((request) => request.method === 'thread/queue/add')).toHaveLength(
        2
      )
      expect(rpc.requests.some((request) => request.method === 'turn/start')).toBe(false)
      expect(run.events.filter((event) => event.type === 'turn.attributed')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            ownership: 'own',
            inputId: 'input_launch',
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            ownership: 'own',
            inputId: second.submissionId,
          }),
        }),
      ])
      expect(run.events.filter((event) => event.type === 'submission.executed')).toHaveLength(2)
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
      const exclusive = await run.broker.invoke({
        invocationId: 'inv_codex_tui_two_queue',
        origin,
        body: 'must refuse',
      })
      expect(exclusive).toMatchObject({
        admission: 'rejected',
        reason: 'unsupported:exclusive',
      })
      expect(rpc.requests.filter((request) => request.method === 'thread/queue/add')).toHaveLength(
        2
      )
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_two_queue',
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: 'inv_codex_tui_two_queue' })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('scrubs stale queue entries before resume and writes the attach token afterward', async () => {
    const rpc = new FakeCodexRpc()
    rpc.onRequest = async (method) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/queue/list') {
        return {
          data: [
            { id: 'stale_1', clientUserMessageId: 'old_input_1' },
            { id: 'stale_2', clientUserMessageId: 'old_input_2' },
          ],
        }
      }
      if (method === 'thread/queue/delete') return { deleted: true }
      if (method === 'thread/resume') return { thread: { id: 'thread_resume' } }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_resume', {
      resumeThreadId: 'thread_resume',
    })
    let socketPath = ''
    try {
      // The injected connector receives the concrete hashed socket through the
      // fake peer setup; discover it from the generated pane launch command.
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const methods = rpc.requests.map((request) => request.method)
      expect(methods.slice(0, 6)).toEqual([
        'initialize',
        'hooks/list',
        'thread/queue/list',
        'thread/queue/delete',
        'thread/queue/delete',
        'thread/resume',
      ])
      const diagnostics = run.events.filter(
        (event) =>
          event.type === 'diagnostic' &&
          (event.payload as { message?: string }).message ===
            'Removed stale Codex queued input before resume'
      )
      expect(diagnostics).toHaveLength(2)
      expect(diagnostics.map((event) => JSON.stringify(event.payload))).toEqual([
        expect.stringContaining('old_input_1'),
        expect.stringContaining('old_input_2'),
      ])
      const launch = run.tmux.launched.find((line) => line.includes('codex-tui')) ?? ''
      const match = launch.match(/--launch-file\s+(?:'([^']+)'|"([^"]+)"|(\S+))/)
      const launchFile = match?.[1] ?? match?.[2] ?? match?.[3]
      expect(launchFile).toBeDefined()
      if (launchFile !== undefined) {
        const artifact = JSON.parse(await readFile(launchFile, 'utf8')) as {
          argv: string[]
        }
        socketPath = artifact.argv[artifact.argv.indexOf('--socket') + 1] ?? ''
        expect((await readFile(socketPath.replace(/\.app\.sock$/, '.attach'), 'utf8')).trim()).toBe(
          'thread_resume'
        )
      }
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_resume',
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: 'inv_codex_tui_resume' })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a queued input separate from a foreign interrupted turn and starts it explicitly', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_human', status: 'inProgress', items: [] },
          })
          rpc.emit('item/started', {
            threadId: 'thread_test',
            turnId: 'turn_human',
            item: {
              id: 'user_turn_human',
              type: 'userMessage',
              clientId: null,
              content: [{ type: 'text', text: 'human race' }],
            },
          })
          setTimeout(
            () =>
              rpc.emit('turn/completed', {
                threadId: 'thread_test',
                turn: { id: 'turn_human', status: 'interrupted', items: [] },
              }),
            5
          )
        })
        return { queuedSubmission: { id: 'queued_after_interrupt' } }
      }
      if (method === 'thread/queue/start') {
        queueMicrotask(() => emitTurn(rpc, 'turn_broker', { clientId: queuedInputId }))
        return { turn: { id: 'turn_broker', status: 'inProgress' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_interrupt_race')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const queued = await run.broker.enqueue({
        invocationId: 'inv_codex_tui_interrupt_race',
        origin,
        body: 'queued broker input',
      })
      await waitFor(
        () => run.events.some((event) => event.type === 'submission.executed'),
        'broker input should execute after explicit queue/start'
      )
      expect(rpc.requests.map((request) => request.method)).toContain('thread/queue/start')
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_human'
        )?.payload
      ).toMatchObject({ ownership: 'foreign', origin: 'human' })
      expect(run.events.find((event) => event.type === 'submission.executed')?.payload).toEqual({
        submissionId: queued.submissionId,
        turnId: 'turn_broker',
      })
      expect(
        run.events.find((event) => event.type === 'user.message' && event.turnId === 'turn_human')
          ?.inputId
      ).toBeUndefined()
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_interrupt_race',
        reason: 'test cleanup',
      })
      await run.broker.dispose({
        invocationId: 'inv_codex_tui_interrupt_race',
      })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('starts the next idle queue submission after an owned turn was interrupted', async () => {
    const rpc = new FakeCodexRpc()
    let queueAdds = 0
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueAdds += 1
        if (queueAdds === 1) {
          setTimeout(
            () =>
              emitTurn(rpc, 'turn_interrupted_own', {
                clientId: inputId,
                terminal: 'interrupted',
              }),
            0
          )
        }
        return { queuedSubmission: { id: `queued_${queueAdds}` } }
      }
      if (method === 'thread/queue/start') {
        const queuedSubmissionId = (params as { queuedSubmissionId: string }).queuedSubmissionId
        expect(queuedSubmissionId).toBe('queued_2')
        const secondInputId = rpc.requests
          .filter((request) => request.method === 'thread/queue/add')
          .at(-1)?.params as { clientUserMessageId: string }
        queueMicrotask(() =>
          emitTurn(rpc, 'turn_after_interrupt', {
            clientId: secondInputId.clientUserMessageId,
          })
        )
        return { turn: { id: 'turn_after_interrupt', status: 'inProgress' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_owned_interrupt_then_queue')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const first = await run.broker.enqueue({
        invocationId: 'inv_codex_tui_owned_interrupt_then_queue',
        origin,
        body: 'first',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.interrupted' && event.inputId === first.submissionId
          ),
        'first owned turn should interrupt'
      )
      const second = await run.broker.enqueue({
        invocationId: 'inv_codex_tui_owned_interrupt_then_queue',
        origin,
        body: 'second',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.completed' && event.inputId === second.submissionId
          ),
        'post-interrupt queue input should execute after queue/start'
      )
      expect(
        rpc.requests.filter((request) => request.method === 'thread/queue/start')
      ).toHaveLength(1)
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_owned_interrupt_then_queue',
        reason: 'test cleanup',
      })
      await run.broker.dispose({
        invocationId: 'inv_codex_tui_owned_interrupt_then_queue',
      })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('holds resumed launch input behind an autonomous startup turn before queue delivery', async () => {
    const rpc = new FakeCodexRpc()
    let launchInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/queue/list') return { data: [] }
      if (method === 'thread/resume') {
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_resume_goal',
            turn: { id: 'turn_goal_startup', status: 'inProgress', items: [] },
          })
          setTimeout(() => {
            rpc.emit('item/started', {
              threadId: 'thread_resume_goal',
              turnId: 'turn_goal_startup',
              item: { id: 'goal_agent', type: 'agentMessage', text: '' },
            })
            rpc.emit('turn/completed', {
              threadId: 'thread_resume_goal',
              turn: { id: 'turn_goal_startup', status: 'completed', items: [] },
            })
          }, 20)
        })
        return { thread: { id: 'thread_resume_goal' } }
      }
      if (method === 'thread/queue/add') {
        launchInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => emitTurn(rpc, 'turn_launch_after_goal', { clientId: launchInputId }))
        return { queuedSubmission: { id: 'queued_launch_after_goal' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_resume_goal', {
      resumeThreadId: 'thread_resume_goal',
    })
    try {
      await run.broker.start(
        {
          spec: run.invocationSpec,
          initialInput: {
            inputId: 'input_launch_after_goal',
            kind: 'user',
            content: [{ type: 'text', text: 'launch after goal' }],
          },
        },
        {},
        { terminalSurface: lease() }
      )
      expect(
        (
          await run.broker.seatProbe({
            invocationId: 'inv_codex_tui_resume_goal',
          })
        ).seat
      ).toEqual({ state: 'turn-observed', turnId: 'turn_goal_startup' })
      expect(rpc.requests.some((request) => request.method === 'thread/queue/add')).toBe(false)
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === 'input_launch_after_goal'
          ),
        'launch input should drain after autonomous startup turn'
      )
      const goalTerminalIndex = run.events.findIndex(
        (event) => event.type === 'turn.completed' && event.turnId === 'turn_goal_startup'
      )
      const launchAcceptedIndex = run.events.findIndex(
        (event) => event.type === 'input.accepted' && event.inputId === 'input_launch_after_goal'
      )
      expect(goalTerminalIndex).toBeGreaterThanOrEqual(0)
      expect(launchAcceptedIndex).toBeGreaterThan(goalTerminalIndex)
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_goal_startup'
        )?.payload
      ).toMatchObject({ ownership: 'foreign', origin: 'autonomous' })
      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.executed' &&
            event.payload.submissionId === 'input_launch_after_goal'
        )?.payload
      ).toMatchObject({ turnId: 'turn_launch_after_goal' })
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_resume_goal',
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: 'inv_codex_tui_resume_goal' })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a later queued input out of a completed human race turn', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          emitTurn(rpc, 'turn_human_completed', { clientId: null })
          emitTurn(rpc, 'turn_broker_after_human', { clientId: queuedInputId })
        })
        return { queuedSubmission: { id: 'queued_completed_race' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_completed_race')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const queued = await run.broker.enqueue({
        invocationId: 'inv_codex_tui_completed_race',
        origin,
        body: 'queued behind human',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === queued.submissionId
          ),
        'queued input should execute in its distinct post-human turn'
      )
      const humanTurn = run.events.find(
        (event) => event.type === 'turn.attributed' && event.turnId === 'turn_human_completed'
      )
      const executed = run.events.find(
        (event) =>
          event.type === 'submission.executed' && event.payload.submissionId === queued.submissionId
      )
      expect(humanTurn?.payload).toMatchObject({
        ownership: 'foreign',
        origin: 'human',
      })
      expect(humanTurn?.inputId).toBeUndefined()
      expect(executed?.payload).toMatchObject({
        turnId: 'turn_broker_after_human',
      })
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_completed_race',
        reason: 'test cleanup',
      })
      await run.broker.dispose({
        invocationId: 'inv_codex_tui_completed_race',
      })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a guarded broker turn owned when a human steers inside it', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_guarded_own', status: 'inProgress', items: [] },
          })
          rpc.emit('item/started', {
            threadId: 'thread_test',
            turnId: 'turn_guarded_own',
            item: {
              id: 'user_guarded_own',
              type: 'userMessage',
              clientId: queuedInputId,
              content: [{ type: 'text', text: 'broker input' }],
            },
          })
        })
        return { queuedSubmission: { id: 'queued_guarded_own' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_guarded_own')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const queued = await run.broker.enqueue({
        invocationId: 'inv_codex_tui_guarded_own',
        origin,
        body: 'guarded broker input',
        turnPolicy: 'guarded',
      })
      await waitFor(
        () => run.events.some((event) => event.type === 'submission.executed'),
        'guarded own turn should be attributed'
      )
      expect(
        await run.broker.steer({
          invocationId: 'inv_codex_tui_guarded_own',
          origin,
          body: 'broker steer must be refused',
        })
      ).toMatchObject({ admission: 'rejected', reason: 'guarded' })
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_guarded_own',
        item: {
          id: 'user_human_steer',
          type: 'userMessage',
          clientId: null,
          content: [{ type: 'text', text: 'human steer' }],
        },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_guarded_own', status: 'completed', items: [] },
      })
      expect(
        run.events.find(
          (event) =>
            event.type === 'user.message' &&
            event.turnId === 'turn_guarded_own' &&
            event.payload.content === 'human steer'
        )?.inputId
      ).toBeUndefined()
      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.executed' &&
            event.payload.submissionId === queued.submissionId
        )?.payload
      ).toMatchObject({ turnId: 'turn_guarded_own' })
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_guarded_own',
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: 'inv_codex_tui_guarded_own' })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('confirms every distinct native steer item once without changing the turn owner', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_owned', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_owned',
            itemId: 'user_owner',
            clientId: queuedInputId,
            text: 'owning input',
          })
        })
        return { queuedSubmission: { id: 'queued_owned' } }
      }
      if (method === 'turn/steer') {
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_native_steers'
    const run = await setupDriver(rpc, invocationId, {}, true)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const owner = await run.broker.enqueue({
        invocationId,
        origin,
        body: 'owning input',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === owner.submissionId
          ),
        'owner should execute'
      )

      const first = await run.broker.steer({ invocationId, origin, body: 'identical text' })
      await waitFor(
        () => rpc.requests.filter((request) => request.method === 'turn/steer').length === 1,
        'first steer should reach Codex'
      )
      const second = await run.broker.steer({ invocationId, origin, body: 'identical text' })
      await waitFor(
        () => rpc.requests.filter((request) => request.method === 'turn/steer').length === 2,
        'second steer should reach Codex'
      )
      const steerRequests = rpc.requests.filter((request) => request.method === 'turn/steer')
      expect(steerRequests).toHaveLength(2)
      expect(steerRequests.map((request) => request.params)).toMatchObject([
        {
          threadId: 'thread_test',
          expectedTurnId: 'turn_owned',
          clientUserMessageId: first.submissionId,
        },
        {
          threadId: 'thread_test',
          expectedTurnId: 'turn_owned',
          clientUserMessageId: second.submissionId,
        },
      ])
      expect(first.submissionId).not.toBe(second.submissionId)
      expect(run.events.filter((event) => event.type === 'submission.absorbed')).toHaveLength(0)

      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_human_later',
        text: 'human context',
      })
      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_steer_first',
        clientId: first.submissionId,
        text: 'identical text',
      })
      // Provider replay and item/completed are not second landing evidence.
      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_steer_first',
        clientId: first.submissionId,
        text: 'identical text',
      })
      rpc.emit('item/completed', {
        threadId: 'thread_test',
        turnId: 'turn_owned',
        item: {
          id: 'user_steer_first',
          type: 'userMessage',
          clientId: first.submissionId,
          content: [{ type: 'text', text: 'identical text' }],
        },
      })
      emitUserMessageItem(rpc, {
        turnId: 'turn_owned',
        itemId: 'user_steer_second',
        clientId: second.submissionId,
        text: 'identical text',
      })

      const absorptions = run.events.filter((event) => event.type === 'submission.absorbed')
      expect(absorptions).toHaveLength(2)
      expect(absorptions.map((event) => event.payload.submissionId)).toEqual([
        first.submissionId,
        second.submissionId,
      ])
      expect(absorptions.every((event) => event.turnId === 'turn_owned')).toBe(true)
      expect(
        run.events.filter(
          (event) => event.type === 'user.message' && event.payload.content === 'identical text'
        )
      ).toHaveLength(2)
      expect(
        run.events.find(
          (event) => event.type === 'user.message' && event.payload.content === 'human context'
        )?.inputId
      ).toBeUndefined()
      expect(
        run.events.filter(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_owned'
        )
      ).toMatchObject([
        {
          inputId: owner.submissionId,
          payload: { ownership: 'own', inputId: owner.submissionId, origin: 'broker' },
        },
      ])
      expect(absorptions[0]?.provenance).toMatchObject({ sourceKind: 'provider-jsonrpc' })
      expect(await run.broker.turnManifest({ invocationId, turnId: 'turn_owned' })).toMatchObject({
        submissionIds: [owner.submissionId, first.submissionId, second.submissionId],
      })
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps before-await steer identity when a foreign turn races the RPC response', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    let steerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_original', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_original',
            itemId: 'user_original',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_original' } }
      }
      if (method === 'turn/steer') {
        const steer = params as { clientUserMessageId: string; expectedTurnId: string }
        steerInputId = steer.clientUserMessageId
        rpc.emit('turn/started', {
          threadId: 'thread_test',
          turn: { id: 'turn_foreign', status: 'inProgress', items: [] },
        })
        emitUserMessageItem(rpc, {
          turnId: 'turn_foreign',
          itemId: 'user_foreign',
          text: 'foreign input',
        })
        return { turnId: steer.expectedTurnId }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_steer_identity_race'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_original'
          ),
        'original turn should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'race steer' })
      expect(steerInputId).toBe(steer.submissionId)
      emitUserMessageItem(rpc, {
        turnId: 'turn_original',
        itemId: 'user_race_steer',
        clientId: steer.submissionId,
        text: 'race steer',
      })

      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toMatchObject({ turnId: 'turn_original' })
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_original'
        )?.payload
      ).toMatchObject({ ownership: 'own', inputId: ownerInputId })
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_foreign'
        )?.payload
      ).toMatchObject({ ownership: 'foreign', origin: 'human' })
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a mismatched steer response uncertain until the armed native item arrives', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_mismatch', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_mismatch',
            itemId: 'user_mismatch_owner',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_mismatch' } }
      }
      if (method === 'turn/steer') return { turnId: 'turn_wrong_response' }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_steer_response_mismatch'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_mismatch'
          ),
        'owner should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'mismatched response' })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
          ),
        'mismatched response should be diagnosed as uncertain'
      )
      expect(
        run.events.find(
          (event) => event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
        )?.payload
      ).toMatchObject({ deliveryEvidence: 'possibly_written' })
      expect(
        run.events.find(
          (event) =>
            event.type === 'diagnostic' &&
            event.payload.message.includes('conflicts with the armed turn identity')
        )?.payload
      ).toMatchObject({
        data: {
          inputId: steer.submissionId,
          expectedTurnId: 'turn_mismatch',
          responseTurnId: 'turn_wrong_response',
          nativeContextEntryObserved: false,
        },
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)

      emitUserMessageItem(rpc, {
        turnId: 'turn_wrong_native',
        itemId: 'user_wrong_native_turn',
        clientId: steer.submissionId,
        text: 'wrong native context',
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)
      expect(
        run.events.find(
          (event) =>
            event.type === 'diagnostic' &&
            event.payload.message.includes('unexpected thread or turn')
        )?.payload
      ).toMatchObject({
        data: {
          inputId: steer.submissionId,
          expectedTurnId: 'turn_mismatch',
          observedTurnId: 'turn_wrong_native',
        },
      })

      emitUserMessageItem(rpc, {
        turnId: 'turn_mismatch',
        itemId: 'user_after_mismatch',
        clientId: steer.submissionId,
        text: 'mismatched response',
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(1)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('does not infer through a tool gap or interrupt and accepts delayed native evidence', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_interrupted_steer', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_interrupted_steer',
            itemId: 'user_interrupt_owner',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_interrupt' } }
      }
      if (method === 'turn/steer') {
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId }
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_interrupted_steer'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_interrupted_steer'
          ),
        'owner should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'late steer' })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'input.accepted' && event.payload.inputId === steer.submissionId
          ),
        'steer should be accepted'
      )
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_interrupted_steer',
        item: { id: 'tool_gap', type: 'commandExecution', command: 'sleep 1' },
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)
      await run.broker.interrupt({ invocationId, scope: 'turn', reason: 'test interrupt' })
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_interrupted_steer', status: 'interrupted', items: [] },
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)

      emitUserMessageItem(rpc, {
        turnId: 'turn_interrupted_steer',
        itemId: 'user_after_interrupt',
        clientId: steer.submissionId,
        text: 'late steer',
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(1)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('clears pending steer correlation on provider death without fabricating landing', async () => {
    const rpc = new FakeCodexRpc()
    let ownerInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_provider_death', status: 'inProgress', items: [] },
          })
          emitUserMessageItem(rpc, {
            turnId: 'turn_provider_death',
            itemId: 'user_provider_death_owner',
            clientId: ownerInputId,
            text: 'owner',
          })
        })
        return { queuedSubmission: { id: 'queued_provider_death' } }
      }
      if (method === 'turn/steer') {
        return { turnId: (params as { expectedTurnId: string }).expectedTurnId }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const invocationId = 'inv_codex_tui_provider_death_steer'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      await run.broker.enqueue({ invocationId, origin, body: 'owner' })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.attributed' && event.turnId === 'turn_provider_death'
          ),
        'owner should be attributed'
      )
      const steer = await run.broker.steer({ invocationId, origin, body: 'lost with process' })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'input.accepted' && event.payload.inputId === steer.submissionId
          ),
        'steer should be accepted'
      )
      rpc.fail(new Error('provider process died'))
      await waitFor(
        () => run.events.some((event) => event.type === 'invocation.exited'),
        'provider death should terminate the invocation'
      )
      emitUserMessageItem(rpc, {
        turnId: 'turn_provider_death',
        itemId: 'user_impossible_after_death',
        clientId: steer.submissionId,
        text: 'lost with process',
      })
      expect(
        run.events.filter(
          (event) =>
            event.type === 'submission.absorbed' &&
            event.payload.submissionId === steer.submissionId
        )
      ).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test.each([false, true])(
    'retains native steer evidence when an RPC failure is observed nativeFirst=%s',
    async (nativeFirst) => {
      const rpc = new FakeCodexRpc()
      let ownerInputId = ''
      let steerInputId = ''
      rpc.onRequest = async (method, params) => {
        if (method === 'initialize') return {}
        if (method === 'hooks/list') return { data: [] }
        if (method === 'thread/start') return { thread: { id: 'thread_test' } }
        if (method === 'thread/queue/add') {
          ownerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
          queueMicrotask(() => {
            rpc.emit('turn/started', {
              threadId: 'thread_test',
              turn: { id: 'turn_rpc_failure', status: 'inProgress', items: [] },
            })
            emitUserMessageItem(rpc, {
              turnId: 'turn_rpc_failure',
              itemId: 'user_rpc_owner',
              clientId: ownerInputId,
              text: 'owner',
            })
          })
          return { queuedSubmission: { id: 'queued_rpc_failure' } }
        }
        if (method === 'turn/steer') {
          steerInputId = (params as { clientUserMessageId: string }).clientUserMessageId
          if (nativeFirst) {
            emitUserMessageItem(rpc, {
              turnId: 'turn_rpc_failure',
              itemId: 'user_before_rpc_failure',
              clientId: steerInputId,
              text: 'uncertain steer',
            })
          }
          throw new Error('simulated RPC response failure')
        }
        throw new Error(`unhandled fake RPC request: ${method}`)
      }
      const invocationId = `inv_codex_tui_rpc_failure_${nativeFirst}`
      const run = await setupDriver(rpc, invocationId)
      try {
        await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
        await run.broker.enqueue({ invocationId, origin, body: 'owner' })
        await waitFor(
          () =>
            run.events.some(
              (event) => event.type === 'turn.attributed' && event.turnId === 'turn_rpc_failure'
            ),
          'owner should be attributed'
        )
        const steer = await run.broker.steer({ invocationId, origin, body: 'uncertain steer' })
        expect(steerInputId).toBe(steer.submissionId)
        await waitFor(
          () =>
            run.events.some(
              (event) =>
                event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
            ),
          'RPC failure should emit an uncertain input rejection'
        )
        expect(
          run.events.find(
            (event) =>
              event.type === 'input.rejected' && event.payload.inputId === steer.submissionId
          )?.payload
        ).toMatchObject({ deliveryEvidence: 'possibly_written' })
        expect(
          run.events.filter(
            (event) =>
              event.type === 'submission.rejected' &&
              event.payload.submissionId === steer.submissionId
          )
        ).toHaveLength(0)

        if (nativeFirst) {
          expect(
            run.events.find(
              (event) =>
                event.type === 'diagnostic' &&
                event.payload.message.includes('failed after native context entry')
            )?.payload
          ).toMatchObject({ data: { inputId: steer.submissionId } })
        }

        if (!nativeFirst) {
          expect(
            run.events.filter(
              (event) =>
                event.type === 'submission.absorbed' &&
                event.payload.submissionId === steer.submissionId
            )
          ).toHaveLength(0)
          emitUserMessageItem(rpc, {
            turnId: 'turn_rpc_failure',
            itemId: 'user_after_rpc_failure',
            clientId: steer.submissionId,
            text: 'uncertain steer',
          })
        }
        expect(
          run.events.filter(
            (event) =>
              event.type === 'submission.absorbed' &&
              event.payload.submissionId === steer.submissionId
          )
        ).toHaveLength(1)
      } finally {
        await run.broker.stop({ invocationId, reason: 'test cleanup' })
        await run.broker.dispose({ invocationId })
        await rm(run.socketDir, { recursive: true, force: true })
      }
    }
  )

  test('attributes autonomous and itemless turns before output or terminal events', async () => {
    const rpc = new FakeCodexRpc()
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'turn/steer') {
        return {
          turnId: (params as { expectedTurnId: string }).expectedTurnId,
        }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_attribution')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      rpc.emit('turn/started', {
        threadId: 'thread_test',
        turn: { id: 'turn_goal', status: 'inProgress', items: [] },
      })
      expect(
        (
          await run.broker.seatProbe({
            invocationId: 'inv_codex_tui_attribution',
          })
        ).seat
      ).toEqual({ state: 'turn-observed', turnId: 'turn_goal' })
      expect(
        await run.broker.steer({
          invocationId: 'inv_codex_tui_attribution',
          origin,
          body: 'too early',
        })
      ).toMatchObject({ admission: 'rejected', reason: 'unattributed-turn' })
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_goal',
        item: { id: 'goal_agent', type: 'agentMessage', text: '' },
      })
      const goalAttribution = run.events.find(
        (event) => event.type === 'turn.attributed' && event.turnId === 'turn_goal'
      )
      const goalOutput = run.events.findIndex(
        (event) => event.type === 'assistant.message.started' && event.turnId === 'turn_goal'
      )
      expect(goalAttribution?.payload).toMatchObject({
        ownership: 'foreign',
        origin: 'autonomous',
      })
      expect(run.events.indexOf(goalAttribution as InvocationEventEnvelope)).toBeLessThan(
        goalOutput
      )
      expect(
        await run.broker.steer({
          invocationId: 'inv_codex_tui_attribution',
          origin,
          body: 'land after attribution',
        })
      ).toMatchObject({ admission: 'admitted' })
      expect(rpc.requests.find((request) => request.method === 'turn/steer')?.params).toMatchObject(
        {
          expectedTurnId: 'turn_goal',
        }
      )
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_goal', status: 'completed', items: [] },
      })

      rpc.emit('turn/started', {
        threadId: 'thread_test',
        turn: { id: 'turn_itemless', status: 'inProgress', items: [] },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_itemless', status: 'failed', items: [] },
      })
      const unknownIndex = run.events.findIndex(
        (event) => event.type === 'turn.attributed' && event.turnId === 'turn_itemless'
      )
      const terminalIndex = run.events.findIndex(
        (event) =>
          event.turnId === 'turn_itemless' &&
          ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
      )
      expect(run.events[unknownIndex]?.payload).toMatchObject({
        ownership: 'unknown',
        origin: 'unknown',
      })
      expect(unknownIndex).toBeGreaterThanOrEqual(0)
      expect(unknownIndex).toBeLessThan(terminalIndex)
      expect(
        await run.broker.turnManifest({
          invocationId: 'inv_codex_tui_attribution',
          turnId: 'turn_itemless',
        })
      ).toMatchObject({ policy: 'open' })
    } finally {
      await run.broker.stop({
        invocationId: 'inv_codex_tui_attribution',
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: 'inv_codex_tui_attribution' })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test.each(['native-terminal', 'app-server-error', 'turn-timeout', 'rpc-close'] as const)(
    'attributes an itemless pending turn unknown before %s and fails correlation closed',
    async (terminalPath) => {
      const rpc = new FakeCodexRpc()
      let pendingInputId = ''
      rpc.onRequest = async (method, params) => {
        if (method === 'initialize') return {}
        if (method === 'hooks/list') return { data: [] }
        if (method === 'thread/start') return { thread: { id: 'thread_test' } }
        if (method === 'thread/queue/add') {
          pendingInputId = (params as { clientUserMessageId: string }).clientUserMessageId
          setTimeout(
            () =>
              rpc.emit('turn/started', {
                threadId: 'thread_test',
                turn: { id: 'turn_itemless_pending', status: 'inProgress', items: [] },
              }),
            0
          )
          return { queuedSubmission: { id: 'queued_itemless_pending' } }
        }
        throw new Error(`unhandled fake RPC request: ${method}`)
      }
      const invocationId = `inv_codex_tui_itemless_${terminalPath}`
      const run = await setupDriver(rpc, invocationId)
      if (terminalPath === 'turn-timeout') {
        run.invocationSpec.process.limits = { startupTimeoutMs: 2_000, turnTimeoutMs: 25 }
      }
      try {
        await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
        const queued = await run.broker.enqueue({ invocationId, origin, body: 'pending' })
        await waitFor(
          () =>
            run.events.some(
              (event) => event.type === 'turn.started' && event.turnId === 'turn_itemless_pending'
            ),
          'itemless turn should start'
        )

        if (terminalPath === 'native-terminal') {
          rpc.emit('turn/completed', {
            threadId: 'thread_test',
            turn: { id: 'turn_itemless_pending', status: 'failed', items: [] },
          })
        } else if (terminalPath === 'app-server-error') {
          rpc.emit('error', { message: 'synthetic app-server error', code: 'synthetic_error' })
        } else if (terminalPath === 'rpc-close') {
          rpc.fail(new Error('synthetic websocket close'))
        }

        await waitFor(
          () =>
            run.events.some(
              (event) =>
                event.type === 'submission.lost' &&
                event.payload.submissionId === queued.submissionId
            ),
          'pending submission should be lost after unknown terminal'
        )
        await waitFor(
          () => run.events.some((event) => event.type === 'invocation.failed'),
          'unknown correlation should fail the invocation'
        )

        const unknownIndex = run.events.findIndex(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_itemless_pending'
        )
        const terminalIndex = run.events.findIndex(
          (event) =>
            event.turnId === 'turn_itemless_pending' &&
            ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
        )
        expect(run.events[unknownIndex]).toMatchObject({
          payload: { ownership: 'unknown', origin: 'unknown' },
        })
        expect(run.events[unknownIndex]?.inputId).toBeUndefined()
        expect(unknownIndex).toBeGreaterThanOrEqual(0)
        expect(terminalIndex).toBeGreaterThan(unknownIndex)
        expect(run.events[terminalIndex]?.inputId).toBeUndefined()
        expect(
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === queued.submissionId
          )
        ).toBe(false)
        expect(
          await run.broker.turnManifest({ invocationId, turnId: 'turn_itemless_pending' })
        ).toMatchObject({ policy: 'open', submissionIds: [] })
        expect(pendingInputId).toBe(queued.submissionId)
      } finally {
        await run.broker.stop({ invocationId, reason: 'test cleanup' })
        await run.broker.dispose({ invocationId })
        await rm(run.socketDir, { recursive: true, force: true })
      }
    }
  )

  test('refuses approval policies other than never before opening a transport', async () => {
    const rpc = new FakeCodexRpc()
    const run = await setupDriver(rpc, 'inv_codex_tui_approval', {
      approvalPolicy: 'on-request' as never,
    })
    try {
      await expect(
        run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      ).rejects.toThrow(/approvalPolicy=never/)
      expect(rpc.requests).toHaveLength(0)
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'diagnostic',
          payload: expect.objectContaining({
            message: 'Codex TUI cannot attach while app-server approvals are enabled',
          }),
        })
      )
    } finally {
      await run.driver.dispose()
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })
})
