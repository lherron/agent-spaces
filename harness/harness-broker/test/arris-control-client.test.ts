import { afterEach, describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function fixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(descriptorFixture, 'utf8')) as Record<string, unknown>
}

async function controlServer(
  response: (request: Record<string, unknown>) => unknown
): Promise<{ socketPath: string; requests: Record<string, unknown>[] }> {
  const dir = await scratchDir('arris-control-client-')
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

const QUEUE_IDENTITY = {
  platform: 'hrc',
  input_id: 'EN-input-alpha',
  envelope_id: 'EN-input-alpha',
  attempt: 1,
}

const QUEUE_RECEIPT = {
  receipt_id: 'control-receipt:alpha',
  host_incarnation_id: 'host-incarnation:alpha',
  identity: QUEUE_IDENTITY,
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
}

type ArrisControlClient = ReturnType<typeof createArrisControlClient>

describe('Arris federation control client', () => {
  test('reads the verbatim ca7e110 host descriptor fixture', async () => {
    const dir = await scratchDir('arris-host-descriptor-')
    const path = join(dir, 'host-descriptor.json')
    await copyFile(descriptorFixture, path)
    const descriptor = await readArrisHostDescriptor(path)
    expect(descriptor.host_incarnation.process.pid).toBe(67137)
    expect(descriptor.control.socket_path).toBe(
      '/private/tmp/t08502-r1/run/federation/control.sock'
    )
  })

  test.each([
    {
      op: 'descriptor',
      call: (client: ArrisControlClient) => client.descriptor(),
      sent: { op: 'descriptor' },
      result: async () => fixture(),
    },
    {
      op: 'queue',
      call: (client: ArrisControlClient) => client.queue(QUEUE_IDENTITY, 'hello'),
      // InputIdentity keeps its snake_case host fields verbatim.
      sent: { op: 'queue', identity: QUEUE_IDENTITY, text: 'hello' },
      result: async () => QUEUE_RECEIPT,
    },
  ])(
    '$op sends exactly {id, op, ...fields} and returns the correlated result unchanged',
    async ({ op, call, sent, result }) => {
      const expected = await result()
      const endpoint = await controlServer((request) => ({
        id: request['id'],
        ok: true,
        result: expected,
      }))
      const client = createArrisControlClient(endpoint.socketPath, {
        requestId: () => `${op}-1`,
      })
      await expect<Promise<unknown>>(call(client)).resolves.toEqual(expected)
      expect(endpoint.requests).toEqual([{ id: `${op}-1`, ...sent }])
    }
  )
})
