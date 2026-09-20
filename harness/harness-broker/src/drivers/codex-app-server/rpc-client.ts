import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { type Socket, connect } from 'node:net'
import { createInterface } from 'node:readline'
import type { JsonRpcId } from 'spaces-harness-broker-protocol'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** Bound untrusted app-server transport data before JSON parsing/allocation. */
const MAX_WEBSOCKET_HANDSHAKE_BYTES = 16 * 1024
const MAX_WEBSOCKET_FRAME_BYTES = 16 * 1024 * 1024
const MAX_WEBSOCKET_CONTROL_FRAME_BYTES = 125

export class CodexRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
    this.data = data
  }
}

export interface RpcHandlers {
  /**
   * `rawFrame` is the VERBATIM line the provider wrote, before any re-encoding.
   * The capture gate commits those bytes (§7.1: raw provider bytes remain
   * verbatim) and the normalizer reads them back, so the parsed `message` here
   * is a convenience for the transport's own routing — never the copy a
   * committed record is derived from.
   */
  onNotification?: ((message: JsonRpcNotification, rawFrame: string) => void) | undefined
  /**
   * Server->client request. The verbatim wire line is passed alongside the
   * parsed message for the same reason `onNotification` gets it: the raw bytes
   * are what the capture journal commits, and a re-encode is not the provider's
   * copy (T-07870).
   */
  onRequest?: ((message: JsonRpcRequest, rawFrame?: string) => Promise<unknown>) | undefined
  onMessage?: ((message: JsonRpcMessage) => void) | undefined
  onError?: ((error: Error) => void) | undefined
}

export interface CodexRpcPeer {
  sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    observeResult?: ((value: T, rawFrame: string) => void) | undefined
  ): Promise<T>
  sendNotification(method: string, params?: unknown): Promise<void>
  close(error?: Error): void
}

export class CodexRpcClient implements CodexRpcPeer {
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      observeResult?: ((value: unknown, rawFrame: string) => void) | undefined
    }
  >()
  private closed = false
  private readonly handlers: RpcHandlers

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    handlers: RpcHandlers = {}
  ) {
    this.handlers = handlers
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      void this.handleLine(line)
    })

    proc.on('error', (error) => {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    })

    proc.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      this.handleError(new Error(`Codex app-server exited with ${reason}`))
    })
  }

  async sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    observeResult?: ((value: T, rawFrame: string) => void) | undefined
  ): Promise<T> {
    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(observeResult !== undefined
          ? { observeResult: observeResult as (value: unknown, rawFrame: string) => void }
          : {}),
      })
    })
    await this.writeMessage(request)
    return response
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    await this.writeMessage(notification)
  }

  close(error: Error = new Error('JSON-RPC client is closed')): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.proc.stdin.end()
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch (error) {
      this.handleError(
        new Error(
          `Failed to parse JSON-RPC message: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
      return
    }

    this.handlers.onMessage?.(message)

    if (this.isResponse(message)) {
      this.handleResponse(message, trimmed)
      return
    }

    if (this.isRequest(message)) {
      await this.handleRequest(message, trimmed)
      return
    }

    if (this.isNotification(message)) {
      this.handlers.onNotification?.(message, trimmed)
    }
  }

  private isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
    return 'id' in message && !('method' in message)
  }

  private isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
    return 'method' in message && 'id' in message
  }

  private isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
    return 'method' in message && !('id' in message)
  }

  private handleResponse(message: JsonRpcResponse, rawFrame: string): void {
    const pending = this.pending.get(message.id)
    if (!pending) {
      this.handleError(new Error(`Unexpected JSON-RPC response id: ${message.id}`))
      return
    }
    this.pending.delete(message.id)

    if (message.error) {
      pending.reject(
        new CodexRpcError(message.error.code, message.error.message, message.error.data)
      )
      return
    }

    try {
      pending.observeResult?.(message.result, rawFrame)
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    pending.resolve(message.result)
  }

  private async handleRequest(message: JsonRpcRequest, rawFrame?: string): Promise<void> {
    if (!this.handlers.onRequest) {
      await this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unhandled request: ${message.method}` },
      } satisfies JsonRpcResponse)
      return
    }

    try {
      const result = await this.handlers.onRequest(message, rawFrame)
      await this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result,
      } satisfies JsonRpcResponse)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      await this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: messageText },
      } satisfies JsonRpcResponse)
      this.handleError(error instanceof Error ? error : new Error(messageText))
    }
  }

  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new Error('JSON-RPC client is closed')
    }

    const payload = `${JSON.stringify(message)}\n`
    const wrote = this.proc.stdin.write(payload)
    if (!wrote) {
      await once(this.proc.stdin, 'drain')
    }
  }

  private handleError(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.handlers.onError?.(error)
  }
}

/** JSON-RPC peer using Codex's websocket framing over a Unix-domain socket. */
export class CodexUnixWebSocketRpcClient implements CodexRpcPeer {
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      observeResult?: ((value: unknown, rawFrame: string) => void) | undefined
    }
  >()
  private closed = false
  private opened = false
  private readonly socket: Socket
  private readonly readyPromise: Promise<void>
  private resolveReady: (() => void) | undefined
  private rejectReady: ((error: Error) => void) | undefined
  private handshakeBuffer = Buffer.alloc(0)
  private frameBuffer = Buffer.alloc(0)
  private fragmentOpcode: number | undefined
  private fragments: Buffer[] = []
  private fragmentBytes = 0

  constructor(
    socketPath: string,
    private readonly handlers: RpcHandlers = {}
  ) {
    // Bun reserves the bare `ws` specifier for its compatibility shim. Its
    // native client rejects ws+unix outright; its node:http shim also cannot
    // complete the upgrade expected by the `ws` package. Codex's app-server is
    // an ordinary RFC 6455 upgrade over a Unix socket, so own that narrow
    // transport directly rather than selecting either incompatible shim.
    this.socket = connect(socketPath)
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.socket.on('connect', () => this.writeHandshake())
    this.socket.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!this.opened) this.handleHandshakeChunk(bytes)
      else this.handleFrameChunk(bytes)
    })
    this.socket.on('error', (error) => this.handleError(error))
    this.socket.on('close', () => {
      this.handleError(new Error('Codex app-server websocket closed'))
    })
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  async sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    observeResult?: ((value: T, rawFrame: string) => void) | undefined
  ): Promise<T> {
    await this.readyPromise
    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(observeResult !== undefined
          ? { observeResult: observeResult as (value: unknown, rawFrame: string) => void }
          : {}),
      })
    })
    this.writeMessage(request)
    return response
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    await this.readyPromise
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    })
  }

  close(error: Error = new Error('JSON-RPC client is closed')): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.opened) this.rejectReady?.(error)
    if (this.opened && !this.socket.destroyed) {
      this.writeFrame(0x8, Buffer.alloc(0))
      this.socket.end()
    } else {
      this.socket.destroy()
    }
  }

  private writeHandshake(): void {
    if (this.closed) return
    const nonce = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1')
      .update(`${nonce}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    this.expectedAccept = expectedAccept
    this.socket.write(
      [
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${nonce}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')
    )
  }

  private expectedAccept: string | undefined

  private handleHandshakeChunk(chunk: Buffer): void {
    if (this.handshakeBuffer.length + chunk.length > MAX_WEBSOCKET_HANDSHAKE_BYTES) {
      this.handleError(new Error('Codex app-server websocket upgrade headers are too large'))
      return
    }
    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk])
    const headerEnd = this.handshakeBuffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = this.handshakeBuffer.subarray(0, headerEnd).toString('latin1')
    const lines = header.split('\r\n')
    const status = lines.shift()
    if (status !== 'HTTP/1.1 101 Switching Protocols') {
      this.handleError(
        new Error(`Codex app-server websocket upgrade failed: ${status ?? 'missing status'}`)
      )
      return
    }
    const headers = new Map<string, string>()
    for (const line of lines) {
      const separator = line.indexOf(':')
      if (separator > 0) {
        headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
      }
    }
    if (headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      this.handleError(new Error('Codex app-server websocket upgrade omitted Upgrade: websocket'))
      return
    }
    if (
      !headers
        .get('connection')
        ?.split(',')
        .some((token) => token.trim().toLowerCase() === 'upgrade')
    ) {
      this.handleError(new Error('Codex app-server websocket upgrade omitted Connection: Upgrade'))
      return
    }
    if (headers.get('sec-websocket-accept') !== this.expectedAccept) {
      this.handleError(
        new Error('Codex app-server websocket upgrade returned an invalid accept key')
      )
      return
    }
    this.opened = true
    this.resolveReady?.()
    this.resolveReady = undefined
    this.rejectReady = undefined
    const remainder = this.handshakeBuffer.subarray(headerEnd + 4)
    this.handshakeBuffer = Buffer.alloc(0)
    if (remainder.length > 0) this.handleFrameChunk(remainder)
  }

  private handleFrameChunk(chunk: Buffer): void {
    // A complete frame carries at most fourteen bytes of header/mask overhead.
    // This cap also bounds a peer that streams an incomplete declared frame.
    if (this.frameBuffer.length + chunk.length > MAX_WEBSOCKET_FRAME_BYTES + 14) {
      this.handleError(new Error('Codex app-server websocket frame buffer is too large'))
      return
    }
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk])
    while (!this.closed) {
      const frame = this.takeFrame()
      if (frame === undefined) return
      this.handleWireFrame(frame.opcode, frame.fin, frame.payload)
    }
  }

  private takeFrame(): { opcode: number; fin: boolean; payload: Buffer } | undefined {
    if (this.frameBuffer.length < 2) return undefined
    const first = this.frameBuffer[0] as number
    const second = this.frameBuffer[1] as number
    if ((first & 0x70) !== 0) {
      this.handleError(new Error('Codex app-server websocket used an unsupported extension'))
      return undefined
    }
    const masked = (second & 0x80) !== 0
    if (masked) {
      this.handleError(new Error('Codex app-server websocket server frames must not be masked'))
      return undefined
    }
    let payloadLength = second & 0x7f
    let offset = 2
    if (payloadLength === 126) {
      if (this.frameBuffer.length < offset + 2) return undefined
      payloadLength = this.frameBuffer.readUInt16BE(offset)
      offset += 2
    } else if (payloadLength === 127) {
      if (this.frameBuffer.length < offset + 8) return undefined
      const length = this.frameBuffer.readBigUInt64BE(offset)
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.handleError(new Error('Codex app-server websocket frame is too large'))
        return undefined
      }
      payloadLength = Number(length)
      offset += 8
    }
    if (payloadLength > MAX_WEBSOCKET_FRAME_BYTES) {
      this.handleError(new Error('Codex app-server websocket frame is too large'))
      return undefined
    }
    if (this.frameBuffer.length < offset + payloadLength) return undefined
    const payload = Buffer.from(this.frameBuffer.subarray(offset, offset + payloadLength))
    this.frameBuffer = this.frameBuffer.subarray(offset + payloadLength)
    return { opcode: first & 0x0f, fin: (first & 0x80) !== 0, payload }
  }

  private handleWireFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode >= 0x8 && (!fin || payload.length > MAX_WEBSOCKET_CONTROL_FRAME_BYTES)) {
      this.handleError(new Error('Codex app-server websocket sent an invalid control frame'))
      return
    }
    if (opcode === 0x9) {
      this.writeFrame(0xa, payload)
      return
    }
    if (opcode === 0x8) {
      if (!this.closed) this.writeFrame(0x8, payload)
      this.handleError(new Error('Codex app-server websocket closed'))
      this.socket.end()
      return
    }
    if (opcode === 0xa) return
    if (opcode === 0x0) {
      if (this.fragmentOpcode === undefined) {
        this.handleError(
          new Error('Codex app-server websocket sent an unexpected continuation frame')
        )
        return
      }
      if (this.fragmentBytes + payload.length > MAX_WEBSOCKET_FRAME_BYTES) {
        this.handleError(new Error('Codex app-server websocket fragmented message is too large'))
        return
      }
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
      if (!fin) return
      const completedOpcode = this.fragmentOpcode
      const completedPayload = Buffer.concat(this.fragments)
      this.fragmentOpcode = undefined
      this.fragments = []
      this.fragmentBytes = 0
      this.handleDataFrame(completedOpcode, completedPayload)
      return
    }
    if (opcode !== 0x1 && opcode !== 0x2) {
      this.handleError(new Error(`Codex app-server websocket sent unsupported opcode ${opcode}`))
      return
    }
    if (this.fragmentOpcode !== undefined) {
      this.handleError(
        new Error('Codex app-server websocket started a new fragmented frame before finishing')
      )
      return
    }
    if (!fin) {
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      this.fragmentBytes = payload.length
      return
    }
    this.handleDataFrame(opcode, payload)
  }

  private handleDataFrame(opcode: number, payload: Buffer): void {
    if (opcode !== 0x1) {
      this.handleError(new Error('Codex app-server websocket sent a binary JSON-RPC frame'))
      return
    }
    void this.handleJsonFrame(payload.toString('utf8'))
  }

  private async handleJsonFrame(rawFrame: string): Promise<void> {
    const trimmed = rawFrame.trim()
    if (trimmed.length === 0) return
    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch (error) {
      this.handleError(
        new Error(
          `Failed to parse JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      return
    }
    this.handlers.onMessage?.(message)
    if ('id' in message && !('method' in message)) {
      this.handleResponse(message, trimmed)
      return
    }
    if ('method' in message && 'id' in message) {
      await this.handleRequest(message, trimmed)
      return
    }
    if ('method' in message) this.handlers.onNotification?.(message, trimmed)
  }

  private handleResponse(message: JsonRpcResponse, rawFrame: string): void {
    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      this.handleError(new Error(`Unexpected JSON-RPC response id: ${message.id}`))
      return
    }
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      pending.reject(
        new CodexRpcError(message.error.code, message.error.message, message.error.data)
      )
      return
    }
    try {
      pending.observeResult?.(message.result, rawFrame)
      pending.resolve(message.result)
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async handleRequest(message: JsonRpcRequest, rawFrame: string): Promise<void> {
    if (this.handlers.onRequest === undefined) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unhandled request: ${message.method}` },
      })
      return
    }
    try {
      const result = await this.handlers.onRequest(message, rawFrame)
      this.writeMessage({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } })
      this.handleError(error instanceof Error ? error : new Error(text))
    }
  }

  private writeMessage(message: JsonRpcMessage): void {
    if (this.closed || !this.opened || this.socket.destroyed) {
      throw new Error('JSON-RPC client is closed')
    }
    this.writeFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'))
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4)
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    const maskedPayload = Buffer.from(payload)
    for (let index = 0; index < maskedPayload.length; index += 1) {
      const byte = maskedPayload[index]
      const maskByte = mask[index % 4]
      if (byte === undefined || maskByte === undefined) {
        throw new Error('Failed to construct masked websocket frame')
      }
      maskedPayload[index] = byte ^ maskByte
    }
    this.socket.write(Buffer.concat([header, mask, maskedPayload]))
  }

  private handleError(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.rejectReady?.(error)
    this.resolveReady = undefined
    this.rejectReady = undefined
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.handlers.onError?.(error)
    this.socket.destroy()
  }
}
