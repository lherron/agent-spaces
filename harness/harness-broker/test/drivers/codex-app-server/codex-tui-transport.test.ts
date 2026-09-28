import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import {
  type AttachAttemptResult,
  resolveCodexTuiWrapperEntryPath,
  runCodexTuiAttachRetry,
} from '../../../src/drivers/codex-app-server/codex-tui-wrapper'
import { CodexUnixWebSocketRpcClient } from '../../../src/drivers/codex-app-server/rpc-client'
import {
  FakeCodexRpc,
  lease,
  setupDriver,
  startUnixWebSocketEchoServer,
  waitFor,
  websocketServers,
} from './codex-tui-transport-support'

describe('codex-tui transport', () => {
  let directory: string | undefined

  afterEach(async () => {
    const runningServers = [...websocketServers]
    websocketServers.clear()
    for (const websocketServer of runningServers) {
      if (websocketServer.exitCode === null) websocketServer.kill('SIGTERM')
    }
    await Promise.all(
      runningServers.map(async (websocketServer) => {
        if (websocketServer.exitCode === null) {
          await new Promise<void>((resolve) => websocketServer.once('exit', () => resolve()))
        }
      })
    )
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  test('spec-aware cold admission rejects JSON Schema before starting the TUI driver', async () => {
    const rpc = new FakeCodexRpc()
    const run = await setupDriver(rpc, 'inv_codex_tui_cold_schema')
    try {
      // A specless hello summary remains the headless descriptor. The actual
      // cold gate must ask the driver with the candidate TUI spec.
      expect(run.driver.capabilities().finalResponse?.jsonSchema).toBe(true)
      expect(run.driver.capabilities(run.invocationSpec).finalResponse?.jsonSchema).toBe(false)

      await expect(
        run.broker.start(
          {
            spec: run.invocationSpec,
            initialInput: {
              inputId: 'input_codex_tui_cold_schema',
              kind: 'user',
              content: [{ type: 'text', text: 'return json' }],
              responseFormat: {
                kind: 'json_schema',
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
              },
            },
          },
          {},
          { terminalSurface: lease() }
        )
      ).rejects.toMatchObject({
        code: BrokerErrorCode.UnsupportedCapability,
        message: 'UnsupportedCapability: finalResponse.jsonSchema',
      })

      expect(rpc.requests).toHaveLength(0)
      expect(run.tmux.launched).toHaveLength(0)
      expect(run.events).toHaveLength(0)
    } finally {
      await run.broker.stop({ invocationId: 'inv_codex_tui_cold_schema' }).catch(() => undefined)
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('uses websocket framing over a unix socket without compression', async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-tui-ws-'))
    const socketPath = join(directory, 'appsrv.sock')
    await startUnixWebSocketEchoServer(socketPath)

    const client = new CodexUnixWebSocketRpcClient(socketPath)
    await client.ready()
    await expect(client.sendRequest('initialize', {})).resolves.toEqual({
      ok: true,
    })
    client.close()
  })

  test('answers ping and reassembles fragmented JSON-RPC text over a Unix socket', async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-tui-ws-fragmented-'))
    const socketPath = join(directory, 'appsrv.sock')
    await startUnixWebSocketEchoServer(socketPath, 'fragmented-ping')

    const client = new CodexUnixWebSocketRpcClient(socketPath)
    await client.ready()
    await expect(client.sendRequest('initialize', {})).resolves.toEqual({ ok: true })
    client.close()
  })

  test('rejects an invalid Unix websocket accept key and destroys the socket', async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-tui-ws-invalid-accept-'))
    const socketPath = join(directory, 'appsrv.sock')
    const endpoint = await startUnixWebSocketEchoServer(socketPath, 'invalid-accept')
    const client = new CodexUnixWebSocketRpcClient(socketPath)

    await expect(client.ready()).rejects.toThrow('invalid accept key')
    await waitFor(
      async () => (await readFile(endpoint.closedPath, 'utf8').catch(() => '')) === 'closed',
      'client should destroy a failed websocket upgrade socket'
    )
  })

  test('rejects an oversized websocket frame before buffering its payload', async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-tui-ws-oversize-'))
    const socketPath = join(directory, 'appsrv.sock')
    const endpoint = await startUnixWebSocketEchoServer(socketPath, 'oversize-frame')
    const client = new CodexUnixWebSocketRpcClient(socketPath)

    await client.ready()
    await expect(client.sendRequest('initialize', {})).rejects.toThrow('frame is too large')
    await waitFor(
      async () => (await readFile(endpoint.closedPath, 'utf8').catch(() => '')) === 'closed',
      'client should destroy an oversized-frame socket'
    )
  })

  test("keeps ws+unix working in Bun's compiled broker payload", async () => {
    directory = await mkdtemp(join(tmpdir(), 'codex-tui-compiled-ws-'))
    const socketPath = join(directory, 'appsrv.sock')
    await startUnixWebSocketEchoServer(socketPath)
    const entryPath = join(directory, 'compiled-client.ts')
    const payloadPath = join(directory, 'compiled-client')
    const rpcClientPath = join(
      process.cwd(),
      'harness/harness-broker/src/drivers/codex-app-server/rpc-client.ts'
    )
    await writeFile(
      entryPath,
      [
        `import { CodexUnixWebSocketRpcClient } from ${JSON.stringify(rpcClientPath)};`,
        'const client = new CodexUnixWebSocketRpcClient(process.argv[2]);',
        'await client.ready();',
        "const result = await client.sendRequest('initialize', {});",
        'client.close();',
        'process.stdout.write(JSON.stringify(result), () => process.exit(0));',
      ].join('\n')
    )
    const build = Bun.spawn({
      cmd: ['bun', 'build', '--compile', '--target=bun', '--outfile', payloadPath, entryPath],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await build.exited
    const buildError = (await new Response(build.stderr).text()).trim()
    expect(build.exitCode, buildError).toBe(0)

    const payload = Bun.spawn({
      cmd: [payloadPath, socketPath],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await payload.exited
    const payloadError = (await new Response(payload.stderr).text()).trim()
    expect(payload.exitCode, payloadError).toBe(0)
    expect((await new Response(payload.stdout).text()).trim()).toBe('{"ok":true}')
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

  test('forwards app-server stderr lines from the wrapper as info diagnostics (T-08232)', async () => {
    const rpc = new FakeCodexRpc()
    const invocationId = 'inv_codex_tui_stderr_relay'
    const run = await setupDriver(rpc, invocationId)
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      let controlSocket: string | undefined
      await waitFor(async () => {
        const entry = (await readdir(run.socketDir)).find(
          (name) => name.includes('hb-codex-tui') && name.endsWith('.control.sock')
        )
        if (entry !== undefined) controlSocket = join(run.socketDir, entry)
        return controlSocket !== undefined
      }, 'codex-tui renderer control listener should bind its socket')
      const post = (envelope: Record<string, unknown>) =>
        new Promise<void>((resolve, reject) => {
          const socket = connect(controlSocket as string, () => {
            socket.end(JSON.stringify(envelope))
          })
          socket.once('error', reject)
          socket.once('close', () => resolve())
        })
      const codexLine =
        '2026-09-07T20:46:22.558245Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit'
      const isRelay = (event: InvocationEventEnvelope) =>
        event.type === 'diagnostic' && (event.payload as { message?: string }).message === codexLine

      // Fence-mismatched envelope (wrong invocation) must be dropped, not relayed.
      await post({
        type: 'app-server-renderer.stderr',
        invocationId: 'inv_someone_else',
        callbackSocket: controlSocket,
        line: codexLine,
      })
      // Matching envelope becomes an info diagnostic on the durable stream.
      await post({
        type: 'app-server-renderer.stderr',
        invocationId,
        callbackSocket: controlSocket,
        line: codexLine,
      })
      await waitFor(
        () => run.events.some(isRelay),
        `expected a diagnostic carrying the app-server stderr line:\n${run.events
          .map((event) => JSON.stringify(event))
          .join('\n')}`
      )
      const relayed = run.events.filter(isRelay)
      expect(relayed).toHaveLength(1)
      expect(relayed[0]?.payload).toMatchObject({
        level: 'info',
        source: 'harness',
        message: codexLine,
      })
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })
})
