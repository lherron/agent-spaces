/**
 * Focused unit tests for {@link CodexRpcClient} (REFACTOR-BACKLOG harness-codex A10).
 *
 * `rpc-client.ts` is the JSON-RPC framing + pending-promise lifecycle surface and
 * had no dedicated test — it was only exercised indirectly through the app-server
 * shim. These tests lock down the behavior that is already correct:
 *   - request/response framing and id correlation
 *   - notification delivery
 *   - JSON-RPC error responses rejecting the matching request
 *   - process exit rejecting every in-flight request
 *   - unknown-response-id surfacing through `onError`
 *   - `writeMessage` after `close()` throwing
 *   - drain backpressure on a full stdin buffer
 *
 * Tests that would only pass once a tracked correctness bug is fixed are added as
 * `.todo` with a BUGS.md reference, so the suite stays green (these are NOT bug
 * fixes — see BUGS.md harness-codex A2/A3/A5).
 */
import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { CodexRpcClient, type JsonRpcMessage, type JsonRpcNotification } from './rpc-client'

/** A controllable in-memory stand-in for a duplex app-server child process. */
class FakeProc extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stdin: PassThrough & { writeReturns?: boolean }

  private readonly stdinWritten: string[] = []

  constructor(options: { stdinWriteReturns?: boolean } = {}) {
    super()
    const stdin = new PassThrough() as PassThrough & { writeReturns?: boolean }
    const writeReturns = options.stdinWriteReturns ?? true
    const originalWrite = stdin.write.bind(stdin)
    // Capture payloads and optionally simulate a full kernel buffer (write → false).
    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      this.stdinWritten.push(String(chunk))
      ;(originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
      return writeReturns
    }) as PassThrough['write']
    this.stdin = stdin
  }

  /** Feed a single JSON-RPC frame (or raw line) to the client's stdout reader. */
  emitLine(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  emitMessage(message: JsonRpcMessage): void {
    this.emitLine(JSON.stringify(message))
  }

  written(): string[] {
    return this.stdinWritten
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }
}

/** Yield to the microtask/event-loop queue so readline 'line' events flush. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface Settled {
  rejected: boolean
  message?: string
  value?: unknown
}

/**
 * Attach handlers eagerly so a synchronous rejection (e.g. from `proc.emit('exit')`)
 * is never reported as unhandled, then expose the outcome for assertions.
 */
function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    (value) => ({ rejected: false, value }),
    (error: unknown) => ({
      rejected: true,
      message: error instanceof Error ? error.message : String(error),
    })
  )
}

describe('CodexRpcClient request/response framing', () => {
  it('writes a well-formed JSON-RPC request and resolves on the matching response', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())

    const pending = client.sendRequest<{ ok: boolean }>('thread/start', { cwd: '/tmp' })
    await tick()

    const [frame] = proc.written()
    expect(frame).toBeDefined()
    const sent = JSON.parse((frame as string).trim()) as Record<string, unknown>
    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread/start',
      params: { cwd: '/tmp' },
    })

    proc.emitMessage({ jsonrpc: '2.0', id: sent.id as number, result: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('increments request ids monotonically', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())

    void client.sendRequest('a')
    void client.sendRequest('b')
    await tick()

    const ids = proc.written().map((frame) => (JSON.parse(frame.trim()) as { id: number }).id)
    expect(ids).toEqual([1, 2])
  })

  it('omits params when none are provided', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())

    void client.sendRequest('ping')
    await tick()

    const sent = JSON.parse((proc.written()[0] as string).trim()) as Record<string, unknown>
    expect('params' in sent).toBe(false)
  })

  it('rejects a request when the response carries a JSON-RPC error', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())

    const pending = client.sendRequest('thread/resume')
    await tick()
    const id = (JSON.parse((proc.written()[0] as string).trim()) as { id: number }).id

    proc.emitMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'No rollout found', data: { threadId: 'x' } },
    })

    await expect(pending).rejects.toThrow(
      /JSON-RPC error -32600: No rollout found \(\{"threadId":"x"\}\)/
    )
  })
})

describe('CodexRpcClient notifications', () => {
  it('delivers notifications to onNotification and onMessage', async () => {
    const proc = new FakeProc()
    const notifications: JsonRpcNotification[] = []
    const messages: JsonRpcMessage[] = []
    new CodexRpcClient(proc.asChild(), {
      onNotification: (n) => notifications.push(n),
      onMessage: (m) => messages.push(m),
    })

    proc.emitMessage({ jsonrpc: '2.0', method: 'item/completed', params: { text: 'hi' } })
    await tick()

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ method: 'item/completed', params: { text: 'hi' } })
    expect(messages).toHaveLength(1)
  })

  it('ignores blank lines', async () => {
    const proc = new FakeProc()
    const messages: JsonRpcMessage[] = []
    new CodexRpcClient(proc.asChild(), { onMessage: (m) => messages.push(m) })

    proc.emitLine('   ')
    proc.emitLine('')
    await tick()

    expect(messages).toHaveLength(0)
  })

  it('surfaces a parse failure through onError without throwing', async () => {
    const proc = new FakeProc()
    const errors: Error[] = []
    new CodexRpcClient(proc.asChild(), { onError: (e) => errors.push(e) })

    proc.emitLine('{ not json')
    await tick()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/Failed to parse JSON-RPC message/)
  })
})

describe('CodexRpcClient pending lifecycle', () => {
  it('rejects every in-flight request when the process exits', async () => {
    const proc = new FakeProc()
    const errors: Error[] = []
    const client = new CodexRpcClient(proc.asChild(), { onError: (e) => errors.push(e) })

    const a = settle(client.sendRequest('a'))
    const b = settle(client.sendRequest('b'))
    await tick()

    proc.emit('exit', 1, null)

    await expect(a).resolves.toMatchObject({
      rejected: true,
      message: expect.stringMatching(/Codex app-server exited with exit code 1/),
    })
    await expect(b).resolves.toMatchObject({
      rejected: true,
      message: expect.stringMatching(/Codex app-server exited with exit code 1/),
    })
    expect(errors).toHaveLength(1)
  })

  it('reports a signal-based exit reason', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())
    const a = settle(client.sendRequest('a'))
    await tick()

    proc.emit('exit', null, 'SIGKILL')

    await expect(a).resolves.toMatchObject({
      rejected: true,
      message: expect.stringMatching(/exited with signal SIGKILL/),
    })
  })

  it('rejects in-flight requests when the process emits error', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())
    const a = settle(client.sendRequest('a'))
    await tick()

    proc.emit('error', new Error('spawn ENOENT'))

    await expect(a).resolves.toMatchObject({
      rejected: true,
      message: expect.stringMatching(/spawn ENOENT/),
    })
  })

  it('only fires onError once even across exit + error', async () => {
    const proc = new FakeProc()
    const errors: Error[] = []
    new CodexRpcClient(proc.asChild(), { onError: (e) => errors.push(e) })

    proc.emit('exit', 1, null)
    proc.emit('error', new Error('later'))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/exited with/)
  })

  it('surfaces an unexpected (unknown-id) response through onError', async () => {
    const proc = new FakeProc()
    const errors: Error[] = []
    new CodexRpcClient(proc.asChild(), { onError: (e) => errors.push(e) })

    proc.emitMessage({ jsonrpc: '2.0', id: 999, result: {} })
    await tick()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/Unexpected JSON-RPC response id: 999/)
  })
})

describe('CodexRpcClient writeMessage / close', () => {
  it('throws when sending after close()', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())

    client.close()

    await expect(client.sendRequest('a')).rejects.toThrow(/JSON-RPC client is closed/)
    await expect(client.sendNotification('n')).rejects.toThrow(/JSON-RPC client is closed/)
  })

  it('ends stdin on close()', async () => {
    const proc = new FakeProc()
    const client = new CodexRpcClient(proc.asChild())
    const finished = new Promise<void>((resolve) => {
      proc.stdin.once('finish', () => resolve())
    })

    client.close()
    await expect(finished).resolves.toBeUndefined()
  })

  it('awaits drain when stdin reports backpressure', async () => {
    const proc = new FakeProc({ stdinWriteReturns: false })
    const client = new CodexRpcClient(proc.asChild())

    const pending = client.sendRequest('a')
    // write() returned false → sendRequest is parked awaiting 'drain'.
    let settledEarly = false
    void pending.then(
      () => {
        settledEarly = true
      },
      () => {
        settledEarly = true
      }
    )
    await tick()
    expect(settledEarly).toBe(false)

    // Emitting 'drain' lets writeMessage resolve and the request to register.
    proc.stdin.emit('drain')
    await tick()
    expect(proc.written()).toHaveLength(1)
  })
})

describe('CodexRpcClient handler requests', () => {
  it('responds with method-not-found when no onRequest handler is registered', async () => {
    const proc = new FakeProc()
    new CodexRpcClient(proc.asChild())

    proc.emitMessage({ jsonrpc: '2.0', id: 7, method: 'tool/permission' })
    await tick()

    const reply = JSON.parse((proc.written()[0] as string).trim()) as {
      id: number
      error: { code: number; message: string }
    }
    expect(reply.id).toBe(7)
    expect(reply.error.code).toBe(-32601)
    expect(reply.error.message).toMatch(/Unhandled request: tool\/permission/)
  })

  it('invokes onRequest and replies with its result', async () => {
    const proc = new FakeProc()
    new CodexRpcClient(proc.asChild(), {
      onRequest: async (req) => ({ echoed: req.method }),
    })

    proc.emitMessage({ jsonrpc: '2.0', id: 9, method: 'tool/permission' })
    await tick()

    const reply = JSON.parse((proc.written()[0] as string).trim()) as {
      id: number
      result: { echoed: string }
    }
    expect(reply).toMatchObject({ id: 9, result: { echoed: 'tool/permission' } })
  })

  it('replies with a server error and surfaces onError when onRequest throws', async () => {
    const proc = new FakeProc()
    const errors: Error[] = []
    new CodexRpcClient(proc.asChild(), {
      onRequest: async () => {
        throw new Error('handler boom')
      },
      onError: (e) => errors.push(e),
    })

    proc.emitMessage({ jsonrpc: '2.0', id: 11, method: 'tool/permission' })
    await tick()

    const reply = JSON.parse((proc.written()[0] as string).trim()) as {
      id: number
      error: { code: number; message: string }
    }
    expect(reply.error).toMatchObject({ code: -32000, message: 'handler boom' })
    expect(errors).toHaveLength(1)
  })
})

/*
 * Tracked correctness bugs (BUGS.md). These are intentionally NOT asserted as
 * passing tests here because A10 is a behavior-preserving cleanup, not a fix.
 * They are recorded as `.todo` so the gap is documented without going red.
 */
describe('CodexRpcClient — tracked bugs (todo, do not fix here)', () => {
  // BUGS.md harness-codex A2: close() leaks the readline interface + the
  // proc 'error'/'exit' listeners. A passing assertion requires detaching
  // listeners in close(), which is the fix — left as todo.
  it.todo('close() detaches readline + proc listeners (BUGS.md harness-codex A2)')

  // BUGS.md harness-codex A1: child stderr is never drained, so a large
  // stderr write can deadlock the pipe. Drain wiring lives in codex-session,
  // not rpc-client; documented here for the riskiest-surface inventory.
  it.todo('drains child stderr to avoid pipe-buffer deadlock (BUGS.md harness-codex A1)')
})
