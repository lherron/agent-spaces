import { afterEach, describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createArrisControlClient,
  readArrisHostDescriptor,
} from '../src/drivers/arris-resident/control-client'

const descriptorFixture = new URL(
  '../../../compiler/agent-spaces/src/__tests__/fixtures/arris-host-descriptor.json',
  import.meta.url
)
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(descriptorFixture, 'utf8')) as Record<string, unknown>
}

async function controlServer(
  response: (request: Record<string, unknown>) => unknown
): Promise<{ socketPath: string; requests: Record<string, unknown>[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'arris-control-client-'))
  const socketPath = join(dir, 'control.sock')
  const requests: Record<string, unknown>[] = []
  const server = createServer((socket) => {
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>
      requests.push(request)
      socket.end(`${JSON.stringify(response(request))}\n`)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { socketPath, requests }
}

describe('Arris federation control client', () => {
  test('reads the verbatim ca7e110 host descriptor fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arris-host-descriptor-'))
    const path = join(dir, 'host-descriptor.json')
    await copyFile(descriptorFixture, path)
    const descriptor = await readArrisHostDescriptor(path)
    expect(descriptor.host_incarnation.process.pid).toBe(67137)
    expect(descriptor.control.socket_path).toBe(
      '/private/tmp/t08502-r1/run/federation/control.sock'
    )
  })

  test('uses camelCase operation fields while preserving snake_case host identity', async () => {
    const descriptor = await fixture()
    const endpoint = await controlServer((request) => ({
      id: request['id'],
      ok: true,
      result: descriptor,
    }))
    const client = createArrisControlClient(endpoint.socketPath, {
      requestId: () => '1',
    })
    await expect(client.descriptor()).resolves.toMatchObject({
      schema: 'arris.host-descriptor/1',
    })
    expect(endpoint.requests).toEqual([{ id: '1', op: 'descriptor' }])
  })

  test('correlates queue receipts without rewriting InputIdentity', async () => {
    const identity = {
      platform: 'hrc',
      input_id: 'EN-input-alpha',
      envelope_id: 'EN-input-alpha',
      attempt: 1,
    }
    const endpoint = await controlServer((request) => ({
      id: request['id'],
      ok: true,
      result: {
        receipt_id: 'control-receipt:alpha',
        host_incarnation_id: 'host-incarnation:alpha',
        identity,
        kind: 'queue',
        target_neutral_turn_id: null,
        recorded_at_ms: 1,
        neutral_turn_id: null,
        outcome: {
          outcome: 'not_written',
          code: 'host_busy',
          message: 'nothing was written',
          eligible_for_retry: true,
          requeue_as_input_permitted: false,
        },
        outcome_at_ms: 2,
        presentation: null,
        completion: null,
        attempts_seen: [1],
        resolution_note: null,
        prior_dispositions: [],
      },
    }))
    const client = createArrisControlClient(endpoint.socketPath, {
      requestId: () => 'queue-1',
    })
    await expect(client.queue(identity, 'hello')).resolves.toMatchObject({
      receipt_id: 'control-receipt:alpha',
      identity,
      outcome: { outcome: 'not_written', eligible_for_retry: true },
    })
    expect(endpoint.requests[0]).toEqual({
      id: 'queue-1',
      op: 'queue',
      identity,
      text: 'hello',
    })
  })
})
