import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { type Socket, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrokerHelloResponse,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationStartRequest,
  JsonRpcMessage,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { expectError, expectResult, noopSpec, parseFrames, request } from './helpers'

const repoRoot = new URL('../../..', import.meta.url).pathname
const fixtureDir = new URL('./fixtures/fake-codex', import.meta.url).pathname

const runBrokerStdio = (extraArgs: string[] = []) =>
  Bun.spawn({
    cmd: [
      'bun',
      'packages/harness-broker/bin/harness-broker.js',
      'run',
      '--transport',
      'stdio',
      ...extraArgs,
    ],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repoRoot,
  })

const waitForSocket = async (
  socketPath: string,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 1500
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`broker exited before creating unix socket: ${stderr.trim()}`)
    }
    try {
      const info = await stat(socketPath)
      if (info.isSocket()) {
        return
      }
    } catch {
      // Keep polling until the broker binds the socket or exits.
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for unix socket ${socketPath}`)
}

async function exchange(input: string) {
  const proc = runBrokerStdio()
  proc.stdin.write(input)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  expect(exitCode).toBe(0)
  expect(stderr).toBe('')

  return parseFrames(stdout)
}

async function exchangeWithBrokerArgs(input: string, args: string[]) {
  const proc = runBrokerStdio(args)
  proc.stdin.write(input)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  expect(exitCode).toBe(0)
  expect(stderr).toBe('')

  return parseFrames(stdout)
}

async function connectUnixSocket(socketPath: string): Promise<Socket> {
  const socket = connect({ path: socketPath })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.setEncoding('utf8')
  return socket
}

function createSocketFrameReader(socket: Socket): {
  nextFrame(): Promise<JsonRpcMessage>
  close(): void
} {
  let buffer = ''
  const frames: JsonRpcMessage[] = []
  const waiters: Array<(frame: JsonRpcMessage) => void> = []

  socket.on('data', (chunk: string) => {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      const frame = JSON.parse(line) as JsonRpcMessage
      const waiter = waiters.shift()
      if (waiter) {
        waiter(frame)
      } else {
        frames.push(frame)
      }
    }
  })

  return {
    nextFrame(): Promise<JsonRpcMessage> {
      const frame = frames.shift()
      if (frame) return Promise.resolve(frame)

      return new Promise<JsonRpcMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(onFrame)
          if (index !== -1) waiters.splice(index, 1)
          reject(new Error('timed out waiting for socket JSON-RPC frame'))
        }, 1500)
        const onFrame = (next: JsonRpcMessage) => {
          clearTimeout(timeout)
          resolve(next)
        }
        waiters.push(onFrame)
      })
    },
    close(): void {
      socket.end()
      socket.destroy()
    },
  }
}

describe('harness-broker CLI', () => {
  test('run --transport stdio responds to broker.hello over stdin', async () => {
    const [frame] = await exchange(
      request('hello-1', 'broker.hello', {
        clientInfo: { name: 'cli-smoke' },
        protocolVersions: ['harness-broker/0.2'],
      })
    )

    const response = expectResult<BrokerHelloResponse>(frame, 'hello-1')
    expect(response.result).toMatchObject({
      brokerInfo: { name: 'harness-broker' },
      protocolVersion: 'harness-broker/0.2',
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
      },
    })
  })

  test.each([
    ['broker.hello', {}],
    ['broker.health', { probeDrivers: 'yes' }],
    ['invocation.start', {}],
    [
      'invocation.start',
      {
        spec: noopSpec({
          harness: { frontend: 'noop', provider: 'test', driver: 'noop-driver' },
          driver: { kind: 'codex-app-server' },
        }),
      },
    ],
    [
      'invocation.input',
      {
        invocationId: 'missing',
        input: { kind: 'bogus', content: [{ type: 'text', text: 'hello' }] },
      },
    ],
    ['invocation.interrupt', { scope: 'turn' }],
    ['invocation.stop', { reason: 'test' }],
    ['invocation.status', {}],
    ['invocation.dispose', {}],
    ['invocation.snapshot', {}],
    ['invocation.eventsSince', {}],
  ])('run --transport stdio validates %s params before dispatch', async (method, params) => {
    const [frame] = await exchange(request(`invalid-${method}`, method, params))
    const response = expectError(frame, `invalid-${method}`, -32602)

    expect(response.error.message).toBe('Invalid params')
    const issues = (response.error.data as { issues?: unknown }).issues
    expect(Array.isArray(issues)).toBe(true)
    expect((issues as unknown[]).length).toBeGreaterThan(0)
  })

  test('run --transport stdio preserves malformed JSON recovery before validation errors', async () => {
    const frames = await exchange(
      `{not json}\n${request('invalid-after-parse', 'invocation.status', {})}`
    )

    expectError(frames[0], null, -32700)
    const response = expectError(frames[1], 'invalid-after-parse', -32602)
    expect(Array.isArray((response.error.data as { issues?: unknown }).issues)).toBe(true)
  })

  // broker.listInvocations plus inspection reads are part of the shared stdio
  // method surface; controller attach/fencing methods remain unix-only.
  test.each(['broker.attach', 'invocation.ackEvents', 'invocation.permission.respond'])(
    'run --transport stdio answers v2 method %s with method-not-found',
    async (method) => {
      const [frame] = await exchange(request(`v2-${method}`, method, {}))
      expectError(frame, `v2-${method}`, -32601)
    }
  )

  test('broker.hello capabilities advertise no v1 attach/replay', async () => {
    const [frame] = await exchange(
      request('hello-caps', 'broker.hello', {
        clientInfo: { name: 'cli-caps' },
        protocolVersions: ['harness-broker/0.2'],
      })
    )

    const response = expectResult<BrokerHelloResponse>(frame, 'hello-caps')
    // Stdio exposes inspection reads, but not controller attach/replay.
    expect(response.result.capabilities.inspection).toEqual({
      listInvocations: true,
      timestamps: true,
      lifecycleView: true,
      liveness: 'cached',
      eventTypeFilter: true,
    })
    expect(response.result.capabilities.attachReplay ?? false).toBe(false)
  })

  test('run --transport stdio can expose an experimental observer unix socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-observer-'))
    const socketPath = join(dir, 'observer.sock')
    const proc = runBrokerStdio(['--experimental-observer-socket', socketPath])

    let observerSocket: Socket | undefined
    let observer: ReturnType<typeof createSocketFrameReader> | undefined
    try {
      await waitForSocket(socketPath, proc)
      observerSocket = await connectUnixSocket(socketPath)
      observer = createSocketFrameReader(observerSocket)

      observerSocket.write(
        request('observer-hello', 'broker.hello', {
          clientInfo: { name: 'observer-test' },
          protocolVersions: ['harness-broker/0.2'],
        })
      )
      const hello = expectResult<BrokerHelloResponse>(await observer.nextFrame(), 'observer-hello')
      expect(hello.result.capabilities.eventNotifications).toBe(true)

      observerSocket.write(request('observer-list', 'broker.listInvocations', {}))
      const list = expectResult<{ invocations: unknown[] }>(
        await observer.nextFrame(),
        'observer-list'
      )
      expect(list.result.invocations).toEqual([])

      observerSocket.write(
        request('observer-input', 'invocation.input', {
          invocationId: 'missing',
          input: { kind: 'user', content: [{ type: 'text', text: 'hello' }] },
        })
      )
      expectError(await observer.nextFrame(), 'observer-input', -32601)
    } finally {
      observer?.close()
      proc.stdin.end()
      await proc.exited.catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('experimental observer mode rejects non-codex-app-server starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-observer-gate-'))
    const socketPath = join(dir, 'observer.sock')
    const frames = await exchangeWithBrokerArgs(
      request('observer-gate', 'invocation.start', {
        startRequest: {
          spec: noopSpec({
            invocationId: 'inv_observer_gate_non_codex',
          }),
        },
      }),
      ['--experimental-observer-socket', socketPath]
    )
    await rm(dir, { recursive: true, force: true })

    const response = expectError(frames[0], 'observer-gate', BrokerErrorCode.UnsupportedCapability)
    expect(response.error.message).toContain('codex-app-server')
    expect(response.error.data).toMatchObject({ driverKind: 'noop-driver' })
  })

  test('run --transport bogus exits nonzero with a clear transport error', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'bogus'],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('transport')
    expect(stderr).toContain('bogus')
  })
})

describe('harness-broker unix transport red tests for T-01792', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('run --transport unix --socket starts a long-lived unix socket server', async () => {
    // T-01792 Phase B: this is the broker-side real-byte entry point for
    // UnixSocketTransport and must coexist with the existing stdio transport.
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-cli-unix-'))
    tmpDirs.push(dir)
    const socketPath = join(dir, 'broker.sock')
    const proc = Bun.spawn({
      cmd: [
        'bun',
        'packages/harness-broker/bin/harness-broker.js',
        'run',
        '--transport',
        'unix',
        '--socket',
        socketPath,
      ],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      await waitForSocket(socketPath, proc)
      expect(proc.exitCode).toBeNull()
    } finally {
      proc.kill('SIGTERM')
      await proc.exited.catch(() => {})
    }
  })

  test('run --transport unix rejects over-long socket paths before bind', async () => {
    // T-01792 Phase B hazard: fail early with a readable socket-path-budget error
    // instead of surfacing a low-level sockaddr_un bind/connect failure.
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-cli-unix-long-'))
    tmpDirs.push(dir)
    const socketPath = join(dir, `${'x'.repeat(160)}.sock`)
    const proc = Bun.spawn({
      cmd: [
        'bun',
        'packages/harness-broker/bin/harness-broker.js',
        'run',
        '--transport',
        'unix',
        '--socket',
        socketPath,
      ],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('socket path')
    expect(stderr).toContain('too long')
  })
})

const codexStartRequest = (scenario: string): InvocationStartRequest => {
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: `inv_cli_start_request_${scenario.replaceAll('-', '_')}`,
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: process.execPath,
      args: [join(fixtureDir, `${scenario}.ts`)],
      cwd: repoRoot,
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: {
        startupTimeoutMs: 5000,
        turnTimeoutMs: 5000,
        stopGraceMs: 250,
      },
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'none',
    },
    driver: {
      kind: 'codex-app-server',
      resumeFallback: 'start-fresh',
      permissionPolicy: { mode: 'deny' },
    },
  }
  return {
    spec,
    initialInput: {
      inputId: 'input_cli_start_request_1',
      kind: 'user',
      content: [{ type: 'text', text: 'Please complete the lifecycle.' }],
    },
  }
}

describe('harness-broker run-once --start-request', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const writeStartRequest = async (request: unknown): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-cli-start-request-'))
    tmpDirs.push(dir)
    const path = join(dir, 'start-request.json')
    await Bun.write(path, JSON.stringify(request))
    return path
  }

  const runOnce = (args: string[]) =>
    Bun.spawn({
      cmd: ['bun', 'packages/harness-broker/bin/harness-broker.js', 'run-once', ...args],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

  test('drives the full lifecycle from an InvocationStartRequest file', async () => {
    const startRequestPath = await writeStartRequest(codexStartRequest('run-once-lifecycle'))
    const proc = runOnce(['--start-request', startRequestPath])

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    // stdout is NDJSON event frames only; diagnostics route to stderr.
    expect(stderr).toBe('')

    const lines = stdout.split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThan(0)
    const events = lines.map((line) => JSON.parse(line) as InvocationEventEnvelope)
    const eventTypes = events.map((event) => event.type)

    const turnStartedIndex = eventTypes.indexOf('turn.started')
    const turnCompletedIndex = eventTypes.indexOf('turn.completed')
    const exitedIndex = eventTypes.indexOf('invocation.exited')

    expect(turnStartedIndex).toBeGreaterThanOrEqual(0)
    expect(turnCompletedIndex).toBeGreaterThan(turnStartedIndex)
    expect(exitedIndex).toBeGreaterThan(turnCompletedIndex)

    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq)
    }
  })

  test('rejects an invalid InvocationStartRequest before driving the broker', async () => {
    const invalid = {
      spec: { ...codexStartRequest('run-once-lifecycle').spec, specVersion: 'bogus' },
    }
    const startRequestPath = await writeStartRequest(invalid)
    const proc = runOnce(['--start-request', startRequestPath])

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('specVersion')
  })
})

describe('harness-broker validate-start-request', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const writeFile = async (value: unknown): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-broker-cli-validate-'))
    tmpDirs.push(dir)
    const path = join(dir, 'start-request.json')
    await Bun.write(path, JSON.stringify(value))
    return path
  }

  const validate = (args: string[]) =>
    Bun.spawn({
      cmd: [
        'bun',
        'packages/harness-broker/bin/harness-broker.js',
        'validate-start-request',
        ...args,
      ],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

  test('exits 0 for a valid InvocationStartRequest', async () => {
    const path = await writeFile(codexStartRequest('run-once-lifecycle'))
    const proc = validate(['--file', path])

    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })

  test('exits non-zero and reports issues for an invalid InvocationStartRequest', async () => {
    const path = await writeFile({ spec: { specVersion: 'bogus' } })
    const proc = validate(['--file', path])

    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('specVersion')
  })
})
