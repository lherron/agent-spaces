import { type JsonRpcMessage, parseJsonRpcMessage } from './jsonrpc'

export type NdjsonFrameResult =
  | { ok: true; value: JsonRpcMessage }
  | { ok: false; error: NdjsonFrameError }

export class NdjsonFrameError extends Error {
  readonly code = 'INVALID_NDJSON_FRAME'
  readonly line: string
  readonly causeError?: unknown

  constructor(line: string, causeError?: unknown) {
    super('Invalid NDJSON frame')
    this.name = 'NdjsonFrameError'
    this.line = line
    this.causeError = causeError
  }
}

export class NdjsonDecoder {
  #buffer = ''

  push(chunk: string | Uint8Array): NdjsonFrameResult[] {
    this.#buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)

    const frames: NdjsonFrameResult[] = []
    let newlineIndex = this.#buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = this.#buffer.slice(0, newlineIndex)
      this.#buffer = this.#buffer.slice(newlineIndex + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

      if (line.length > 0) {
        frames.push(decodeLine(line))
      }

      newlineIndex = this.#buffer.indexOf('\n')
    }

    return frames
  }

  flush(): NdjsonFrameResult[] {
    if (this.#buffer.length === 0) {
      return []
    }

    const line = this.#buffer
    this.#buffer = ''
    return [decodeLine(line)]
  }
}

export function encodeNdjsonFrame(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`
}

function decodeLine(line: string): NdjsonFrameResult {
  try {
    return { ok: true, value: parseJsonRpcMessage(line) }
  } catch (error) {
    return { ok: false, error: new NdjsonFrameError(line, error) }
  }
}
