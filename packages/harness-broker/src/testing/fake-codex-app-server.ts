import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export interface JsonRpcRequestFrame {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

export interface FakeCodexIo {
  read(): Promise<JsonRpcRequestFrame>
  respond(request: JsonRpcRequestFrame, result: unknown): void
  reject(request: JsonRpcRequestFrame, code: number, message: string, data?: unknown): void
  notify(method: string, params?: unknown): void
  close(code?: number): never
}

export function framed(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout
): FakeCodexIo {
  const pending: JsonRpcRequestFrame[] = []
  const waiters: Array<(frame: JsonRpcRequestFrame) => void> = []

  const rl = createInterface({ input: stdin })
  // Exit when stdin reaches EOF (parent broker closed the pipe / orphaned us).
  // Without this, fixtures that block forever keep a readline open over an
  // EOF'd stdin and busy-spin the Bun event loop at ~100% CPU as orphans.
  rl.on('close', () => {
    process.exit(0)
  })
  rl.on('line', (line) => {
    const frame = JSON.parse(line) as JsonRpcRequestFrame
    const waiter = waiters.shift()
    if (waiter) {
      waiter(frame)
      return
    }
    pending.push(frame)
  })

  function write(frame: unknown): void {
    stdout.write(`${JSON.stringify(frame)}\n`)
  }

  return {
    async read(): Promise<JsonRpcRequestFrame> {
      const frame = pending.shift()
      if (frame) {
        return frame
      }
      return new Promise((resolve) => waiters.push(resolve))
    },
    respond(request: JsonRpcRequestFrame, result: unknown): void {
      write({ jsonrpc: '2.0', id: request.id, result })
    },
    reject(request: JsonRpcRequestFrame, code: number, message: string, data?: unknown): void {
      write({ jsonrpc: '2.0', id: request.id, error: { code, message, data } })
    },
    notify(method: string, params: unknown = {}): void {
      write({ jsonrpc: '2.0', method, params })
    },
    close(code = 0): never {
      process.exit(code)
    },
  }
}

export async function expectMethod(io: FakeCodexIo, method: string): Promise<JsonRpcRequestFrame> {
  const frame = await io.read()
  if (frame.method !== method) {
    throw new Error(`expected ${method}, got ${frame.method}`)
  }
  return frame
}

export async function initializeAndReadThreadRequest(
  io: FakeCodexIo,
  expectedThreadMethod: 'thread/start' | 'thread/resume'
): Promise<JsonRpcRequestFrame> {
  const init = await expectMethod(io, 'initialize')
  io.respond(init, { protocolVersion: 'codex-app-server/v0' })

  await expectMethod(io, 'initialized')

  return expectMethod(io, expectedThreadMethod)
}

export function completeSimpleTurn(io: FakeCodexIo, text = 'Done.'): void {
  io.notify('turn/started', { turnId: 'turn_1' })
  io.notify('item/started', {
    turnId: 'turn_1',
    item: { type: 'agentMessage', id: 'msg_1' },
  })
  io.notify('item/agentMessage/delta', {
    turnId: 'turn_1',
    id: 'msg_1',
    text,
  })
  io.notify('item/completed', {
    turnId: 'turn_1',
    item: {
      type: 'agentMessage',
      id: 'msg_1',
      content: [{ type: 'text', text }],
    },
  })
  io.notify('turn/completed', {
    turnId: 'turn_1',
    status: 'completed',
    finalOutput: text,
  })
}
