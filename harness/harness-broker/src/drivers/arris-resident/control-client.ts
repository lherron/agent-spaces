import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'

import {
  type ArrisControlReceipt,
  type ArrisHostDescriptor,
  type ArrisInputIdentity,
  validateArrisHostDescriptor,
} from 'spaces-harness-broker-protocol'

const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024 * 1024

export class ArrisControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ArrisControlError'
    this.code = code
  }
}

export interface ArrisControlClient {
  descriptor(): Promise<ArrisHostDescriptor>
  readiness(): Promise<ArrisHostDescriptor['readiness']>
  queue(identity: ArrisInputIdentity, text: string): Promise<ArrisControlReceipt>
  steer(
    identity: ArrisInputIdentity,
    targetNeutralTurnId: string | null,
    text: string
  ): Promise<ArrisControlReceipt>
  lookup(identity: ArrisInputIdentity): Promise<ArrisControlReceipt | null>
  unresolved(): Promise<ArrisControlReceipt[]>
}

type ControlEnvelope = {
  id: string
  op: 'descriptor' | 'readiness' | 'queue' | 'steer' | 'lookup' | 'unresolved'
  identity?: ArrisInputIdentity
  targetNeutralTurnId?: string | null
  text?: string
}

type ControlResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseResponse(value: unknown, requestId: string): ControlResponse {
  if (!isRecord(value) || value['id'] !== requestId || typeof value['ok'] !== 'boolean') {
    throw new ArrisControlError(
      'malformed_control_response',
      `Arris control response did not correlate to request ${requestId}`
    )
  }
  if (value['ok'] === true && 'result' in value) return value as ControlResponse
  const error = value['error']
  if (
    value['ok'] === false &&
    isRecord(error) &&
    typeof error['code'] === 'string' &&
    typeof error['message'] === 'string'
  ) {
    return value as ControlResponse
  }
  throw new ArrisControlError('malformed_control_response', 'Arris control response is malformed')
}

function parseReceipt(value: unknown): ArrisControlReceipt {
  if (
    !isRecord(value) ||
    typeof value['receipt_id'] !== 'string' ||
    typeof value['host_incarnation_id'] !== 'string' ||
    !isRecord(value['identity']) ||
    (value['kind'] !== 'queue' && value['kind'] !== 'steer') ||
    !isRecord(value['outcome']) ||
    !['in_flight', 'written', 'not_written', 'indeterminate'].includes(
      String(value['outcome']['outcome'])
    ) ||
    !Array.isArray(value['attempts_seen']) ||
    !Array.isArray(value['prior_dispositions'])
  ) {
    throw new ArrisControlError('malformed_control_receipt', 'Arris control receipt is malformed')
  }
  return value as ArrisControlReceipt
}

async function sendLine(socketPath: string, request: ControlEnvelope): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let buffered = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.byteLength > MAX_CONTROL_RESPONSE_BYTES) {
        finish(new ArrisControlError('control_response_too_large', 'Arris response exceeded limit'))
        return
      }
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) return
      try {
        finish(undefined, JSON.parse(buffered.subarray(0, newline).toString('utf8')))
      } catch {
        finish(
          new ArrisControlError('malformed_control_response', 'Arris response was not valid JSON')
        )
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('end', () => {
      if (!settled) {
        finish(
          new ArrisControlError(
            'control_response_incomplete',
            'Arris closed the control socket before a response line'
          )
        )
      }
    })
  })
}

export async function readArrisHostDescriptor(path: string): Promise<ArrisHostDescriptor> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ArrisControlError(
      'host_descriptor_unreadable',
      error instanceof Error ? error.message : String(error)
    )
  }
  const result = validateArrisHostDescriptor(value)
  if (!result.ok) {
    throw new ArrisControlError(
      'host_descriptor_invalid',
      result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    )
  }
  return result.value
}

export function createArrisControlClient(
  socketPath: string,
  options: { requestId?: () => string } = {}
): ArrisControlClient {
  let nextId = 0
  const allocateId = options.requestId ?? (() => `arris-control:${++nextId}`)
  const request = async (body: Omit<ControlEnvelope, 'id'>): Promise<unknown> => {
    const id = allocateId()
    const response = parseResponse(await sendLine(socketPath, { id, ...body }), id)
    if (!response.ok) throw new ArrisControlError(response.error.code, response.error.message)
    return response.result
  }
  return {
    async descriptor() {
      const result = validateArrisHostDescriptor(await request({ op: 'descriptor' }))
      if (!result.ok) {
        throw new ArrisControlError(
          'host_descriptor_invalid',
          result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
        )
      }
      return result.value
    },
    async readiness() {
      const value = await request({ op: 'readiness' })
      if (
        !isRecord(value) ||
        typeof value['state'] !== 'string' ||
        typeof value['since_ms'] !== 'number' ||
        typeof value['accepts_input'] !== 'boolean'
      ) {
        throw new ArrisControlError('readiness_invalid', 'Arris readiness response is malformed')
      }
      return value as ArrisHostDescriptor['readiness']
    },
    async queue(identity, text) {
      return parseReceipt(await request({ op: 'queue', identity, text }))
    },
    async steer(identity, targetNeutralTurnId, text) {
      return parseReceipt(await request({ op: 'steer', identity, targetNeutralTurnId, text }))
    },
    async lookup(identity) {
      const value = await request({ op: 'lookup', identity })
      return value === null ? null : parseReceipt(value)
    },
    async unresolved() {
      const value = await request({ op: 'unresolved' })
      if (!Array.isArray(value)) {
        throw new ArrisControlError('unresolved_invalid', 'Arris unresolved response is malformed')
      }
      return value.map(parseReceipt)
    },
  }
}
